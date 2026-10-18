//! SSH tunnels, including multi-hop bastion chains.
//!
//! Hop 1 is reached over TCP. Every later hop is reached through a `direct-tcpip`
//! channel opened on the previous hop, and a fresh SSH session runs over that
//! channel (the same thing OpenSSH `ProxyJump` does). The last session forwards a
//! local port on 127.0.0.1 to the database host, so the drivers only ever see
//! `127.0.0.1:<port>`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

use crate::known_hosts::HostKeyStatus;
use crate::secrets::HopSecret;
use crate::steps::{label, Steps};
use crate::{Error, Result, SshAuth, SshHop};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// An open tunnel. Dropping it closes the listener and every SSH session.
pub struct Tunnel {
    pub local_port: u16,
    accept_task: JoinHandle<()>,
    _sessions: Vec<Arc<Handle<HostKeyCheck>>>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

/// Verifies server keys against `~/.ssh/known_hosts` and remembers why a key was refused,
/// so the UI can offer "Trust this host" instead of a generic error.
pub struct HostKeyCheck {
    host: String,
    port: u16,
    refusal: Arc<Mutex<Option<Error>>>,
}

impl client::Handler for HostKeyCheck {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key,
            PublicKeyOrCertificate::Certificate(_) => {
                *self.refusal.lock().unwrap() = Some(Error::ssh(&self.host, "host certificates are not supported yet"));
                return Ok(false);
            }
        };
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let refusal = match crate::known_hosts::check(&self.host, self.port, key) {
            HostKeyStatus::Trusted => return Ok(true),
            HostKeyStatus::Changed { line } => {
                Error::HostKeyChanged { host: self.host.clone(), port: self.port, line, fingerprint }
            }
            HostKeyStatus::Revoked { line } => {
                Error::ssh(&self.host, format!("this host key is marked @revoked in ~/.ssh/known_hosts line {line}"))
            }
            HostKeyStatus::Unknown => Error::UnknownHostKey {
                host: self.host.clone(),
                port: self.port,
                fingerprint,
                key: key.to_openssh().unwrap_or_default(),
            },
        };
        *self.refusal.lock().unwrap() = Some(refusal);
        Ok(false)
    }
}

/// Add a host key to `~/.ssh/known_hosts` after the user confirmed it.
pub fn trust_host_key(host: &str, port: u16, key_openssh: &str) -> Result<()> {
    let key = keys::PublicKey::from_openssh(key_openssh).map_err(|e| Error::ssh(host, e))?;
    keys::known_hosts::learn_known_hosts(host, port, &key).map_err(|e| Error::ssh(host, e))
}

fn ssh_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    })
}

/// Open the chain `hops` and forward a local port to `target_host:target_port`
/// as seen from the last hop. Each stage is recorded in `steps`.
pub async fn open(
    hops: &[(SshHop, HopSecret)],
    target_host: &str,
    target_port: u16,
    steps: &mut Steps,
) -> Result<Tunnel> {
    if hops.is_empty() {
        return Err(Error::Config("An SSH connection needs at least one host".into()));
    }
    let config = ssh_config();
    let mut sessions: Vec<Arc<Handle<HostKeyCheck>>> = Vec::with_capacity(hops.len());

    for (i, (hop, secret)) in hops.iter().enumerate() {
        let host = hop.host.as_str();
        let refusal = Arc::new(Mutex::new(None));
        let handler = HostKeyCheck { host: hop.host.clone(), port: hop.port, refusal: refusal.clone() };

        // 1. Reach the host: TCP for the first hop, a forwarded channel for later ones.
        let handle = match sessions.last() {
            None => {
                let tcp = steps
                    .run(
                        label::reach(host, hop.port),
                        timed(&format!("connecting to {host}:{}", hop.port), async {
                            TcpStream::connect((host, hop.port)).await.map_err(|e| Error::ssh(host, reach_message(&e)))
                        }),
                        |_| Some("Check the host name and port, and that your network or VPN can reach it.".into()),
                    )
                    .await?;
                tcp.set_nodelay(true).ok();
                handshake(steps, hop, &refusal, client::connect_stream(config.clone(), tcp, handler)).await?
            }
            Some(prev) => {
                let via = &hops[i - 1].0.host;
                let channel = steps
                    .run(
                        label::reach_via(host, hop.port, via),
                        timed(&format!("opening {host}:{} through {via}", hop.port), async {
                            prev.channel_open_direct_tcpip(hop.host.clone(), hop.port.into(), "127.0.0.1", 0)
                                .await
                                .map_err(|e| Error::ssh(via, format!("could not open a connection to {host}:{}: {e}", hop.port)))
                        }),
                        |_| Some(format!(
                            "{via} could not connect to {host}:{}. Use the address as seen from {via}, and check that it allows TCP forwarding (AllowTcpForwarding).",
                            hop.port
                        )),
                    )
                    .await?;
                handshake(steps, hop, &refusal, client::connect_stream(config.clone(), channel.into_stream(), handler))
                    .await?
            }
        };

        // 3. Sign in.
        let mut handle = handle;
        steps
            .run(label::ssh_sign_in(&hop.user, host), authenticate(&mut handle, hop, secret), |_| Some(auth_hint(hop)))
            .await?;
        sessions.push(Arc::new(handle));
    }

    // 4. Make sure the last hop can actually reach the database before handing out the port.
    let last = sessions.last().cloned().expect("at least one session");
    let last_host = &hops[hops.len() - 1].0.host;
    steps
        .run(
            label::db_from(target_host, target_port, last_host),
            timed(&format!("opening {target_host}:{target_port} from {last_host}"), async {
                last.channel_open_direct_tcpip(target_host.to_string(), target_port.into(), "127.0.0.1", 0)
                    .await
                    .map(drop)
                    .map_err(|e| Error::ssh(last_host, format!("could not reach {target_host}:{target_port}: {e}")))
            }),
            |_| Some(format!(
                "{last_host} cannot reach {target_host}:{target_port}. Enter the database host as {last_host} sees it (often localhost or a private IP), and check the port."
            )),
        )
        .await?;

    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let local_port = listener.local_addr()?.port();
    let target_host = target_host.to_string();

    let accept_task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, peer)) = listener.accept().await else { break };
            let last = last.clone();
            let host = target_host.clone();
            tokio::spawn(async move {
                match last
                    .channel_open_direct_tcpip(
                        host.clone(),
                        target_port.into(),
                        peer.ip().to_string(),
                        peer.port().into(),
                    )
                    .await
                {
                    Ok(channel) => {
                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                    }
                    Err(e) => tracing::warn!("forward to {host}:{target_port} failed: {e}"),
                }
            });
        }
    });

    Ok(Tunnel { local_port, accept_task, _sessions: sessions })
}

/// 2. SSH handshake, including the host key check.
async fn handshake(
    steps: &mut Steps,
    hop: &SshHop,
    refusal: &Arc<Mutex<Option<Error>>>,
    fut: impl std::future::Future<Output = Result<Handle<HostKeyCheck>, russh::Error>>,
) -> Result<Handle<HostKeyCheck>> {
    let host = hop.host.as_str();
    steps
        .run(
            label::host_key(host),
            timed(&format!("SSH handshake with {host}"), async {
                fut.await.map_err(|e| refusal.lock().unwrap().take().unwrap_or_else(|| Error::ssh(host, format!("SSH handshake failed: {e}"))))
            }),
            |e| match e {
                Error::UnknownHostKey { .. } => {
                    Some("First connection to this server. Compare the fingerprint with your admin, then choose Trust and Retry.".into())
                }
                Error::HostKeyChanged { .. } => Some(format!(
                    "If the server was rebuilt, remove the old line with `ssh-keygen -R {host}` and try again. Otherwise don't connect."
                )),
                _ => Some("The server is not speaking SSH on this port, or uses algorithms 1Client does not support.".into()),
            },
        )
        .await
}

async fn timed<T>(what: &str, fut: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(CONNECT_TIMEOUT, fut)
        .await
        .unwrap_or_else(|_| Err(Error::Timeout(format!("{what} took longer than {}s", CONNECT_TIMEOUT.as_secs()))))
}

pub(crate) fn reach_message(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::ConnectionRefused => "connection refused (nothing is listening on that port)".into(),
        _ if e.to_string().contains("failed to lookup") || e.to_string().contains("nodename nor servname") => {
            "host name not found".into()
        }
        _ => e.to_string(),
    }
}

fn auth_hint(hop: &SshHop) -> String {
    match &hop.auth {
        SshAuth::Agent { .. } => {
            "Check that the agent has the right key loaded (`ssh-add -l`) and that it is in the server's authorized_keys."
                .into()
        }
        SshAuth::KeyFile { .. } => {
            "Check the key path and passphrase, and that the public key is in the server's authorized_keys.".into()
        }
        SshAuth::Password => "Check the user name and password. Some servers allow keys only.".into(),
    }
}

async fn authenticate(handle: &mut Handle<HostKeyCheck>, hop: &SshHop, secret: &HopSecret) -> Result<()> {
    let host = hop.host.as_str();
    let user = hop.user.as_str();
    let ok = match &hop.auth {
        SshAuth::Password => {
            let pw = secret.password.clone().ok_or_else(|| Error::ssh(host, "no password saved for this host"))?;
            handle.authenticate_password(user, pw).await.map_err(|e| Error::ssh(host, e))?.success()
        }
        SshAuth::KeyFile { path } => {
            let path = expand_home(path);
            let key = keys::load_secret_key(&path, secret.key_passphrase.as_deref())
                .map_err(|e| Error::ssh(host, format!("cannot read key {}: {e}", path.display())))?;
            let hash = handle_rsa_hash(handle).await;
            handle
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(|e| Error::ssh(host, e))?
                .success()
        }
        SshAuth::Agent { socket } => {
            let mut agent = match socket {
                Some(path) => keys::agent::client::AgentClient::connect_uds(expand_home(path)).await,
                None => keys::agent::client::AgentClient::connect_env().await,
            }
            .map_err(|e| Error::ssh(host, format!("SSH agent not reachable: {e}")))?;
            let identities =
                agent.request_identities().await.map_err(|e| Error::ssh(host, format!("SSH agent: {e}")))?;
            if identities.is_empty() {
                return Err(Error::ssh(host, "the SSH agent has no keys loaded"));
            }
            let hash = handle_rsa_hash(handle).await;
            let mut ok = false;
            for id in identities {
                let key = id.public_key().into_owned();
                let res = handle
                    .authenticate_publickey_with(user, key, hash, &mut agent)
                    .await
                    .map_err(|e| Error::ssh(host, e))?;
                if res.success() {
                    ok = true;
                    break;
                }
            }
            ok
        }
    };

    if ok {
        Ok(())
    } else {
        Err(Error::ssh(host, format!("{user}@{host} rejected the credentials")))
    }
}

async fn handle_rsa_hash(handle: &Handle<HostKeyCheck>) -> Option<HashAlg> {
    handle.best_supported_rsa_hash().await.ok().flatten().flatten()
}

fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => PathBuf::from(path),
    }
}
