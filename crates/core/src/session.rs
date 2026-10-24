//! A live connection: optional tunnel plus a database connection. When it drops (the Mac slept,
//! the network changed, the server restarted) it is opened again by itself.

use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use tokio::net::TcpStream;
use uuid::Uuid;

use crate::db::{self, DbConn};
use crate::secrets::{HopSecret, ProfileSecrets};
use crate::steps::{self, label, Step, StepStatus, Steps};
use crate::tunnel::{self, Tunnel};
use crate::{ConnectionProfile, DbStage, Engine, Error, QueryOutput, Result, SessionInfo, TableInfo};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// After this long without a statement, the connection is pinged before it is used: after sleep,
/// connections often look open but are dead.
const IDLE: Duration = Duration::from_secs(30);
const PING_TIMEOUT: Duration = Duration::from_secs(3);

pub struct Session {
    pub id: Uuid,
    /// The saved settings. The database may have been switched since: see `database`.
    pub profile: ConnectionProfile,
    /// The database to open: the saved one, or the one switched to.
    database: Mutex<String>,
    /// Kept to connect again.
    secrets: ProfileSecrets,
    live: Mutex<Arc<Live>>,
    /// One reconnect at a time; statements that find the connection dead wait for it.
    reconnecting: tokio::sync::Mutex<()>,
    reconnected: AtomicBool,
    /// Statements running now, and when the last one ended. Wall-clock time, because `Instant`
    /// stands still while the Mac sleeps.
    busy: AtomicUsize,
    last_used: Mutex<SystemTime>,
}

/// One opened connection.
struct Live {
    server_version: String,
    /// The database it is in, as the server says (PostgreSQL picks one when none was given).
    database: String,
    db: DbConn,
    // Declared after `db` so the database connection closes before the tunnel. Switching databases
    // reuses the tunnel.
    tunnel: Option<Arc<Tunnel>>,
    /// A statement found it dropped.
    lost: AtomicBool,
}

impl Live {
    fn is_closed(&self) -> bool {
        self.lost.load(Ordering::SeqCst) || self.db.is_closed() || self.tunnel.as_ref().is_some_and(|t| t.is_closed())
    }

    /// The server answers a ping in time (an error from the server is an answer too).
    async fn answers(&self) -> bool {
        matches!(tokio::time::timeout(PING_TIMEOUT, self.db.ping()).await, Ok(Ok(()) | Err(Error::Db(_))))
    }
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
    /// The failure, so the UI can offer actions like replacing a changed host key.
    pub error: Option<Error>,
}

impl Session {
    /// Connect. On failure the error names the step that failed and carries a hint.
    pub async fn open(profile: ConnectionProfile, secrets: &ProfileSecrets) -> Result<Self> {
        let live = Self::connect(&profile, secrets).await?;
        Ok(Self {
            id: Uuid::new_v4(),
            database: Mutex::new(profile.database.clone()),
            profile,
            secrets: secrets.clone(),
            live: Mutex::new(Arc::new(live)),
            reconnecting: Default::default(),
            reconnected: AtomicBool::new(false),
            busy: AtomicUsize::new(0),
            last_used: Mutex::new(SystemTime::now()),
        })
    }

    async fn connect(profile: &ConnectionProfile, secrets: &ProfileSecrets) -> Result<Live> {
        let mut steps = Steps::default();
        Self::open_with(profile, secrets, &mut steps).await.map_err(|e| at_failed_step(e, &steps))
    }

    /// The databases the server offers this user, for the connection form's Browse button: connect
    /// with the form's values, list them, disconnect. When the database typed in the form can't be
    /// opened, the server's default one is used for the listing.
    pub async fn list_databases(profile: &ConnectionProfile, secrets: &ProfileSecrets) -> Result<Vec<String>> {
        let mut steps = Steps::default();
        let tunnel = Self::reach(profile, secrets, &mut steps).await.map_err(|e| at_failed_step(e, &steps))?;
        let mut live = Self::sign_in(profile, secrets, &mut steps, tunnel.clone()).await;
        let fallback = match profile.engine {
            Engine::Postgres => "postgres",
            Engine::Mysql => "",
        };
        if matches!(live, Err(Error::DbConnect { stage: DbStage::Database, .. })) && profile.database != fallback {
            let other = ConnectionProfile { database: fallback.into(), ..profile.clone() };
            steps = Steps::default();
            live = Self::sign_in(&other, secrets, &mut steps, tunnel).await;
        }
        let live = live.map_err(|e| at_failed_step(e, &steps))?;
        Ok(names(&live.db.run(db::databases_sql(profile.engine)).await?))
    }

    /// Connect step by step, recording each one, then disconnect.
    pub async fn test(profile: ConnectionProfile, secrets: &ProfileSecrets) -> TestReport {
        let started = Instant::now();
        let plan = steps::plan(&profile);
        let hops = profile.network.active_hops().len();
        let mut steps = Steps::default();
        let result = Self::open_with(&profile, secrets, &mut steps).await;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(live) => TestReport {
                ok: true,
                steps: steps.list,
                server_version: Some(live.server_version.clone()),
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

    async fn open_with(profile: &ConnectionProfile, secrets: &ProfileSecrets, steps: &mut Steps) -> Result<Live> {
        let tunnel = Self::reach(profile, secrets, steps).await?;
        Self::sign_in(profile, secrets, steps, tunnel).await
    }

    /// Reach the database server: open the SSH tunnel, or check that it answers directly.
    async fn reach(
        profile: &ConnectionProfile,
        secrets: &ProfileSecrets,
        steps: &mut Steps,
    ) -> Result<Option<Arc<Tunnel>>> {
        if profile.host.trim().is_empty() {
            return Err(Error::Config("Enter the database host first".into()));
        }
        let hops: Vec<_> = profile
            .network
            .active_hops()
            .iter()
            .map(|h| (h.clone(), secrets.hops.get(&h.id).cloned().unwrap_or_else(HopSecret::default)))
            .collect();

        if hops.is_empty() {
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
            Ok(None)
        } else {
            // Boxed, like the drivers below: these futures are large, and nested they could overflow a
            // worker thread's stack in debug builds.
            Ok(Some(Arc::new(Box::pin(tunnel::open(&hops, &profile.host, profile.port, steps)).await?)))
        }
    }

    /// Sign in to the database, through `tunnel` when there is one.
    async fn sign_in(
        profile: &ConnectionProfile,
        secrets: &ProfileSecrets,
        steps: &mut Steps,
        tunnel: Option<Arc<Tunnel>>,
    ) -> Result<Live> {
        let (host, port) = match &tunnel {
            Some(t) => ("127.0.0.1", t.local_port),
            None => (profile.host.as_str(), profile.port),
        };

        let pw = secrets.db_password.as_deref();
        let sign_in = label::db_sign_in(steps::engine_name(profile.engine), &profile.user);
        let connected = match profile.engine {
            Engine::Postgres => {
                Box::pin(db::postgres::connect(profile, pw, (host, port))).await.map(|(c, v)| (DbConn::Postgres(c), v))
            }
            Engine::Mysql => {
                Box::pin(db::mysql::connect(profile, pw, (host, port))).await.map(|(c, v)| (DbConn::Mysql(c), v))
            }
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
                    let hint = db_hint(profile, &e, tunnel.is_some(), pw.is_some());
                    steps.failed(sign_in, &e, hint);
                }
                return Err(e);
            }
        };
        steps.ok(sign_in, Some(server_version.clone()));
        if !profile.database.is_empty() {
            steps.ok(label::db_open(&profile.database), None);
        }

        let database = names(&db.run(db::current_database_sql(profile.engine)).await?).pop().unwrap_or_default();
        Ok(Live { server_version, database, db, tunnel, lost: AtomicBool::new(false) })
    }

    pub fn info(&self) -> SessionInfo {
        let live = self.current();
        SessionInfo {
            session_id: self.id,
            profile_id: self.profile.id,
            server_version: live.server_version.clone(),
            database: live.database.clone(),
            hops: if live.tunnel.is_some() { self.profile.network.active_hops().len() } else { 0 },
        }
    }

    /// The databases on the server this user can open, system ones left out.
    pub async fn databases(&self) -> Result<Vec<String>> {
        Ok(names(&self.run(db::databases_sql(self.profile.engine), true).await?.sets))
    }

    /// Work in another database from now on. The SSH tunnel is reused; the database connection is
    /// new, so it starts a fresh session. On failure the current database stays.
    pub async fn use_database(&self, name: &str) -> Result<SessionInfo> {
        {
            let _one = self.reconnecting.lock().await;
            let current = self.current();
            let target = ConnectionProfile { database: name.into(), ..self.profile.clone() };
            let mut steps = Steps::default();
            let opened = match current.tunnel.clone().filter(|t| !t.is_closed()) {
                Some(tunnel) => Self::sign_in(&target, &self.secrets, &mut steps, Some(tunnel)).await,
                None => Self::open_with(&target, &self.secrets, &mut steps).await,
            };
            let fresh = opened.map_err(|e| at_failed_step(e, &steps))?;
            *self.database.lock().unwrap() = name.into();
            *self.live.lock().unwrap() = Arc::new(fresh);
        }
        Ok(self.info())
    }

    /// Run SQL. A connection that dropped is opened again first. If it drops while the statement
    /// runs, the statement runs again only with `rerun` (it only reads, so twice is harmless).
    pub async fn run(&self, sql: &str, rerun: bool) -> Result<QueryOutput> {
        let started = Instant::now();
        let live = self.live().await?;
        let sets = match self.track(live.db.run(sql)).await {
            Err(Error::ConnectionLost(_)) => {
                live.lost.store(true, Ordering::SeqCst);
                if !rerun {
                    return Err(Error::Interrupted);
                }
                let live = self.live().await?;
                self.track(live.db.run(sql)).await?
            }
            other => other?,
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
        let live = self.live().await?;
        let result = self.track(live.db.apply(edits)).await;
        if let Err(Error::ConnectionLost(_)) = result {
            // The next statement opens it again; these edits may or may not have been saved.
            live.lost.store(true, Ordering::SeqCst);
            return Err(Error::Interrupted);
        }
        result
    }

    pub async fn introspect(&self) -> Result<Vec<TableInfo>> {
        let out = self.run(db::introspection_sql(self.profile.engine), true).await?;
        Ok(out.sets.first().map(db::fold_tables).unwrap_or_default())
    }

    /// Whether the connection was opened again since the last call, to tell the user once.
    pub fn take_reconnected(&self) -> bool {
        self.reconnected.swap(false, Ordering::SeqCst)
    }

    fn current(&self) -> Arc<Live> {
        self.live.lock().unwrap().clone()
    }

    /// The connection to use: the current one, or a new one when it has dropped. After a pause it
    /// is pinged first, so a connection that died during sleep doesn't swallow the statement.
    async fn live(&self) -> Result<Arc<Live>> {
        let live = self.current();
        let idle = self.busy.load(Ordering::SeqCst) == 0
            && self.last_used.lock().unwrap().elapsed().map_or(true, |d| d > IDLE);
        if live.is_closed() || (idle && !live.answers().await) {
            return self.reconnect(&live).await;
        }
        Ok(live)
    }

    /// Open a new connection in place of `dead`, unless another statement already did.
    async fn reconnect(&self, dead: &Arc<Live>) -> Result<Arc<Live>> {
        let _one = self.reconnecting.lock().await;
        let live = self.current();
        if !Arc::ptr_eq(&live, dead) {
            return Ok(live);
        }
        let target = ConnectionProfile { database: self.database.lock().unwrap().clone(), ..self.profile.clone() };
        let fresh = Arc::new(Self::connect(&target, &self.secrets).await?);
        *self.live.lock().unwrap() = fresh.clone();
        self.reconnected.store(true, Ordering::SeqCst);
        tracing::info!("the connection to {} dropped and was opened again", self.profile.name);
        Ok(fresh)
    }

    /// Count `fut` as a running statement, for `live`'s idle check.
    async fn track<T>(&self, fut: impl Future<Output = Result<T>>) -> Result<T> {
        struct Running<'a>(&'a Session);
        impl Drop for Running<'_> {
            fn drop(&mut self) {
                self.0.busy.fetch_sub(1, Ordering::SeqCst);
                *self.0.last_used.lock().unwrap() = SystemTime::now();
            }
        }
        self.busy.fetch_add(1, Ordering::SeqCst);
        let _running = Running(self);
        fut.await
    }
}

/// A connect error, tagged with the step that failed and its hint.
fn at_failed_step(e: Error, steps: &Steps) -> Error {
    match steps.list.iter().find(|s| s.status == StepStatus::Failed) {
        Some(failed) => Error::Step { step: failed.label.clone(), hint: failed.hint.clone(), source: Box::new(e) },
        None => e,
    }
}

/// The first column of the first result, as text: a list of names.
fn names(out: &[crate::ResultSet]) -> Vec<String> {
    out.first().map(|set| set.rows.iter().filter_map(|r| r.first().cloned().flatten()).collect()).unwrap_or_default()
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
