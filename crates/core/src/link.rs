//! Connections handed to 1Client by other apps.
//!
//! Accepted forms:
//! - `oneclient://open?url=<percent-encoded DB URL>&name=<label>`
//!   with optional SSH: `ssh=user@host[:port]`, `jump=user@host[:port]` (repeatable, first hop
//!   first), `ssh_agent=1password|<socket path>`, `ssh_key=<path>`.
//!   The DB host and port are then as seen from the SSH host.
//! - a plain `postgresql://`, `postgres://`, `mysql://` or `mariadb://` URL.
//!
//! User, password and database name are percent-decoded. Unknown query parameters are ignored.
//! Nothing here logs or puts the password into an error message.

use percent_encoding::percent_decode_str;
use url::Url;
use uuid::Uuid;

use crate::{ConnectionProfile, Engine, Error, Network, NetworkMode, Result, SshAuth, SshHop, SslMode};

const ONE_PASSWORD_AGENT: &str = "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock";

/// A connection from a link: not saved until the user saves it.
#[derive(Debug, Clone)]
pub struct IncomingConnection {
    pub profile: ConnectionProfile,
    pub db_password: Option<String>,
}

fn bad(msg: &str) -> Error {
    Error::Config(format!("The link could not be opened: {msg}"))
}

fn decode(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().into_owned()
}

pub fn parse_link(link: &str) -> Result<IncomingConnection> {
    let link = link.trim();
    let url = Url::parse(link).map_err(|_| bad("not a valid URL"))?;
    match url.scheme() {
        "oneclient" => parse_oneclient(&url),
        "postgresql" | "postgres" | "mysql" | "mariadb" => parse_db_url(&url, None),
        other => Err(bad(&format!("unsupported scheme “{other}”"))),
    }
}

fn parse_oneclient(url: &Url) -> Result<IncomingConnection> {
    // `oneclient://open?...` (host "open") or `oneclient:open?...`
    let action = url.host_str().unwrap_or_else(|| url.path().trim_start_matches('/'));
    if action != "open" {
        return Err(bad(&format!("unknown action “{action}”")));
    }
    let mut db_url = None;
    let mut name = None;
    let mut ssh = None;
    let mut jumps = Vec::new();
    let mut agent: Option<String> = None;
    let mut key: Option<String> = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "url" => db_url = Some(v.into_owned()),
            "name" => name = Some(v.into_owned()),
            "ssh" => ssh = Some(v.into_owned()),
            "jump" => jumps.extend(v.split(',').filter(|s| !s.is_empty()).map(str::to_owned)),
            "ssh_agent" => agent = Some(v.into_owned()),
            "ssh_key" => key = Some(v.into_owned()),
            _ => {} // ignore what we don't know
        }
    }
    let db_url = db_url.ok_or_else(|| bad("missing url parameter"))?;
    let inner = Url::parse(&db_url).map_err(|_| bad("the url parameter is not a database URL"))?;
    let mut incoming = parse_db_url(&inner, name)?;

    if let Some(ssh) = ssh {
        let auth = match (key, agent.as_deref()) {
            (Some(path), _) => SshAuth::KeyFile { path },
            (None, Some("1password")) => SshAuth::Agent { socket: Some(ONE_PASSWORD_AGENT.into()) },
            (None, Some(socket)) if !socket.is_empty() && socket != "default" => {
                SshAuth::Agent { socket: Some(socket.into()) }
            }
            _ => SshAuth::Agent { socket: None },
        };
        let mut hops = Vec::new();
        for j in jumps.iter().chain(std::iter::once(&ssh)) {
            hops.push(parse_hop(j, auth.clone())?);
        }
        incoming.profile.network =
            Network { mode: if hops.len() > 1 { NetworkMode::Bastion } else { NetworkMode::SshTunnel }, hops };
    }
    Ok(incoming)
}

/// `user@host[:port]`
fn parse_hop(s: &str, auth: SshAuth) -> Result<SshHop> {
    let (user, rest) = s.split_once('@').ok_or_else(|| bad("SSH hosts must look like user@host[:port]"))?;
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) if !h.contains(']') || h.ends_with(']') => {
            (h.trim_matches(['[', ']']), p.parse().map_err(|_| bad("SSH port is not a number"))?)
        }
        _ => (rest, 22),
    };
    if user.is_empty() || host.is_empty() {
        return Err(bad("SSH hosts must look like user@host[:port]"));
    }
    Ok(SshHop { id: Uuid::new_v4(), host: host.into(), port, user: decode(user), auth })
}

fn parse_db_url(url: &Url, name: Option<String>) -> Result<IncomingConnection> {
    let engine = match url.scheme() {
        "postgresql" | "postgres" => Engine::Postgres,
        "mysql" | "mariadb" => Engine::Mysql,
        other => return Err(bad(&format!("unsupported database “{other}”"))),
    };
    let host = url.host_str().map(|h| h.trim_matches(['[', ']']).to_string()).unwrap_or_default();
    if host.is_empty() {
        return Err(bad("no host"));
    }
    let port = url.port().unwrap_or(engine.default_port());
    let user = decode(url.username());
    let db_password = url.password().map(decode).filter(|p| !p.is_empty());
    let database = decode(url.path().trim_start_matches('/'));

    let mut ssl_mode = SslMode::Prefer;
    for (k, v) in url.query_pairs() {
        if k == "sslmode" || k == "ssl-mode" || k == "ssl_mode" {
            ssl_mode = match v.to_ascii_lowercase().as_str() {
                "disable" | "disabled" => SslMode::Disable,
                "require" | "required" => SslMode::Require,
                "verify-full" | "verify-ca" | "verify_identity" | "verify_ca" => SslMode::VerifyFull,
                _ => SslMode::Prefer,
            };
        }
    }

    let label = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| {
        if database.is_empty() {
            format!("{host}:{port}")
        } else {
            format!("{database} @ {host}")
        }
    });
    Ok(IncomingConnection {
        profile: ConnectionProfile {
            id: Uuid::new_v4(),
            name: label,
            engine,
            environment: "local".into(),
            host,
            port,
            user,
            database,
            ssl_mode,
            network: Network::default(),
            confirm_writes: true,
            read_only: false,
            last_used_at: None,
        },
        db_password,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oneclient_link_with_encoded_url_and_name() {
        let c = parse_link(
            "oneclient://open?url=postgresql%3A%2F%2Fshop%3Ashop_dev%40127.0.0.1%3A25434%2Fshop&name=shop-api%20postgres%20(remote)",
        )
        .unwrap();
        let p = &c.profile;
        assert_eq!(p.engine, Engine::Postgres);
        assert_eq!(
            (p.host.as_str(), p.port, p.user.as_str(), p.database.as_str()),
            ("127.0.0.1", 25434, "shop", "shop")
        );
        assert_eq!(c.db_password.as_deref(), Some("shop_dev"));
        assert_eq!(p.name, "shop-api postgres (remote)");
        assert_eq!(p.network.mode, NetworkMode::Direct);
    }

    #[test]
    fn plain_urls_and_special_password_characters() {
        // Password "p@ss/w:rd%", database "my db"
        let c =
            parse_link("postgres://me:p%40ss%2Fw%3Ard%25@db.example.com/my%20db?sslmode=require&application_name=x")
                .unwrap();
        assert_eq!(c.db_password.as_deref(), Some("p@ss/w:rd%"));
        assert_eq!(c.profile.database, "my db");
        assert_eq!(c.profile.port, 5432);
        assert_eq!(c.profile.ssl_mode, SslMode::Require);

        let m = parse_link("mariadb://root@[::1]:3307").unwrap();
        assert_eq!((m.profile.engine, m.profile.host.as_str(), m.profile.port), (Engine::Mysql, "::1", 3307));
        assert_eq!(m.db_password, None);
    }

    #[test]
    fn link_with_ssh_and_jump_hosts() {
        let db = "postgresql%3A%2F%2Fapp%3Asecret%40db.internal%3A5432%2Fshop";
        let c = parse_link(&format!(
            "oneclient://open?url={db}&ssh=deploy@10.0.4.12&jump=me@bastion.example.com:2222&ssh_agent=1password&foo=bar"
        ))
        .unwrap();
        let n = &c.profile.network;
        assert_eq!(n.mode, NetworkMode::Bastion);
        assert_eq!(n.hops[0].host, "bastion.example.com");
        assert_eq!(n.hops[0].port, 2222);
        assert_eq!(n.hops[1].user, "deploy");
        assert_eq!(n.hops[1].port, 22);
        assert!(matches!(&n.hops[1].auth, SshAuth::Agent { socket: Some(s) } if s.contains("1password")));
    }

    #[test]
    fn errors_never_contain_the_password() {
        for bad in [
            "oneclient://open?name=x",
            "oneclient://delete?url=postgres%3A%2F%2Fu%3Atopsecret%40h%2Fd",
            "redis://u:topsecret@h",
            "postgres://u:topsecret@/d",
        ] {
            let e = parse_link(bad).unwrap_err().to_string();
            assert!(!e.contains("topsecret"), "{e}");
        }
    }
}
