//! A live connection: optional tunnel plus a database connection.

use std::time::{Duration, Instant};

use tokio::net::TcpStream;
use uuid::Uuid;

use crate::db::{self, DbConn};
use crate::secrets::{HopSecret, ProfileSecrets};
use crate::steps::{self, label, Step, StepStatus, Steps};
use crate::tunnel::{self, Tunnel};
use crate::{ConnectionProfile, DbStage, Engine, Error, QueryOutput, Result, SessionInfo, TableInfo};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

pub struct Session {
    pub id: Uuid,
    pub profile: ConnectionProfile,
    pub server_version: String,
    db: DbConn,
    // Declared after `db` so the database connection closes before the tunnel.
    tunnel: Option<Tunnel>,
}

/// Result of "Test Connection": every step, with what failed and what to try.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestReport {
    pub ok: bool,
    pub steps: Vec<Step>,
    pub server_version: Option<String>,
    pub hops: usize,
    pub elapsed_ms: u64,
    /// The failure, so the UI can offer actions like "Trust and Retry".
    pub error: Option<Error>,
}

impl Session {
    /// Connect. On failure the error names the step that failed and carries a hint.
    pub async fn open(profile: ConnectionProfile, secrets: &ProfileSecrets) -> Result<Self> {
        let mut steps = Steps::default();
        match Self::open_with(profile, secrets, &mut steps).await {
            Ok(s) => Ok(s),
            Err(e) => Err(match steps.list.iter().find(|s| s.status == StepStatus::Failed) {
                Some(failed) => {
                    Error::Step { step: failed.label.clone(), hint: failed.hint.clone(), source: Box::new(e) }
                }
                None => e,
            }),
        }
    }

    /// Connect step by step, recording each one, then disconnect.
    pub async fn test(profile: ConnectionProfile, secrets: &ProfileSecrets) -> TestReport {
        let started = Instant::now();
        let plan = steps::plan(&profile);
        let hops = profile.network.active_hops().len();
        let mut steps = Steps::default();
        let result = Self::open_with(profile, secrets, &mut steps).await;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(s) => TestReport {
                ok: true,
                steps: steps.list,
                server_version: Some(s.server_version.clone()),
                hops,
                elapsed_ms,
                error: None,
            },
            Err(e) => {
                steps.skip_rest(&plan);
                TestReport { ok: false, steps: steps.list, server_version: None, hops, elapsed_ms, error: Some(e) }
            }
        }
    }

    async fn open_with(profile: ConnectionProfile, secrets: &ProfileSecrets, steps: &mut Steps) -> Result<Self> {
        if profile.host.trim().is_empty() {
            return Err(Error::Config("Enter the database host first".into()));
        }
        let hops: Vec<_> = profile
            .network
            .active_hops()
            .iter()
            .map(|h| (h.clone(), secrets.hops.get(&h.id).cloned().unwrap_or_else(HopSecret::default)))
            .collect();

        let tunnel = if hops.is_empty() {
            let (h, p) = (profile.host.as_str(), profile.port);
            steps
                .run(
                    label::db_reach(h, p),
                    async {
                        match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((h, p))).await {
                            Ok(Ok(_)) => Ok(()),
                            Ok(Err(e)) => Err(Error::DbConnect { stage: DbStage::Network, message: tunnel::reach_message(&e) }),
                            Err(_) => Err(Error::Timeout(format!("connecting to {h}:{p}"))),
                        }
                    },
                    |_| Some("Check the host and port, and that your network or VPN can reach it. If the database is only reachable from a server, connect through SSH.".into()),
                )
                .await?;
            None
        } else {
            Some(tunnel::open(&hops, &profile.host, profile.port, steps).await?)
        };
        let (host, port) = match &tunnel {
            Some(t) => ("127.0.0.1", t.local_port),
            None => (profile.host.as_str(), profile.port),
        };

        let pw = secrets.db_password.as_deref();
        let sign_in = label::db_sign_in(steps::engine_name(profile.engine), &profile.user);
        let connected = match profile.engine {
            Engine::Postgres => {
                db::postgres::connect(&profile, pw, (host, port)).await.map(|(c, v)| (DbConn::Postgres(c), v))
            }
            Engine::Mysql => db::mysql::connect(&profile, pw, (host, port)).await.map(|(c, v)| (DbConn::Mysql(c), v)),
        };
        let (db, server_version) = match connected {
            Ok(ok) => ok,
            Err(e) => {
                if let Error::DbConnect { stage: DbStage::Database, .. } = e {
                    steps.ok(sign_in, None);
                    steps.failed(
                        label::db_open(&profile.database),
                        &e,
                        Some(format!(
                            "“{}” does not exist or {} cannot open it. Check the name, or leave Database empty to use the default.",
                            profile.database, profile.user
                        )),
                    );
                } else {
                    let hint = db_hint(&profile, &e, tunnel.is_some(), pw.is_some());
                    steps.failed(sign_in, &e, hint);
                }
                return Err(e);
            }
        };
        steps.ok(sign_in, Some(server_version.clone()));
        if !profile.database.is_empty() {
            steps.ok(label::db_open(&profile.database), None);
        }

        Ok(Self { id: Uuid::new_v4(), profile, server_version, db, tunnel })
    }

    pub fn info(&self) -> SessionInfo {
        SessionInfo {
            session_id: self.id,
            profile_id: self.profile.id,
            server_version: self.server_version.clone(),
            hops: if self.tunnel.is_some() { self.profile.network.active_hops().len() } else { 0 },
        }
    }

    pub async fn run(&self, sql: &str) -> Result<QueryOutput> {
        let started = Instant::now();
        let sets = match &self.db {
            DbConn::Postgres(c) => {
                if c.is_closed() {
                    return Err(Error::NoSession);
                }
                c.run(sql).await?
            }
            DbConn::Mysql(c) => c.run(sql).await?,
        };
        Ok(QueryOutput { sets, elapsed_ms: started.elapsed().as_millis() as u64 })
    }

    /// Save cells edited in the grid. Refused in read-only sessions.
    pub async fn apply_edits(&self, edits: &[crate::edit::RowEdit]) -> Result<u64> {
        if self.profile.read_only {
            return Err(Error::Config("This connection is read-only. Turn off \"Read-only session\" to edit.".into()));
        }
        if edits.is_empty() {
            return Ok(0);
        }
        match &self.db {
            DbConn::Postgres(c) => c.apply(edits).await,
            DbConn::Mysql(c) => c.apply(edits).await,
        }
    }

    pub async fn introspect(&self) -> Result<Vec<TableInfo>> {
        let out = self.run(db::introspection_sql(self.profile.engine)).await?;
        Ok(out.sets.first().map(db::fold_tables).unwrap_or_default())
    }
}

/// What to try when signing in to the database fails.
fn db_hint(p: &ConnectionProfile, e: &Error, tunneled: bool, has_password: bool) -> Option<String> {
    let Error::DbConnect { stage, message } = e else { return None };
    let low = message.to_lowercase();
    Some(match stage {
        DbStage::Tls => "The server did not accept the SSL settings. Try SSL mode Prefer, or Require if the certificate cannot be verified.".into(),
        DbStage::Network if tunneled => format!(
            "The tunnel works, but the database closed the connection. Check the port, and that this is a {} server.",
            steps::engine_name(p.engine)
        ),
        DbStage::Network => "Could not talk to the database server. Check the port and that this is the right kind of server.".into(),
        DbStage::Database => return None,
        DbStage::Auth => match p.engine {
            Engine::Postgres if low.contains("pg_hba") => format!(
                "The server's pg_hba.conf does not allow {} from this address{}. Ask the database admin, or try SSL mode Require.",
                p.user,
                if tunneled { " (the server sees the SSH host's address)" } else { "" }
            ),
            _ if !has_password => "No password was given. Enter it in the Password field.".into(),
            Engine::Postgres => "Wrong user name or password.".into(),
            Engine::Mysql => format!(
                "Wrong user name or password, or {} may not log in from this address. MySQL users are tied to a host ('user'@'host'){}.",
                p.user,
                if tunneled { "; through SSH the server sees the SSH host's address" } else { "" }
            ),
        },
    })
}
