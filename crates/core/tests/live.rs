//! Live tests against real servers. Ignored by default; run with
//!
//! ```sh
//! ONECLIENT_TEST_PG="127.0.0.1:5432:postgres:secret:shop" \
//! ONECLIENT_TEST_MYSQL="127.0.0.1:3306:app:secret:shop" \
//! ONECLIENT_TEST_SSH="me@127.0.0.1:22" ONECLIENT_TEST_SSH_KEY=~/.ssh/id_ed25519 ONECLIENT_TEST_SSH_KEY_PASS= \
//! ONECLIENT_TEST_SSH2="other@127.0.0.1:22" ONECLIENT_TEST_SSH2_PASSWORD=secret \
//! cargo test -p oneclient-core --test live -- --ignored --nocapture
//! ```
//!
//! Each test skips itself when its variables are missing. SSH tests add unknown host
//! keys to ~/.ssh/known_hosts (and replace a test server's key that changed), so only point them
//! at machines you trust, or run them with `HOME` set to a scratch directory.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use oneclient_core::secrets::{HopSecret, ProfileSecrets};
use oneclient_core::*;
use tokio::net::{TcpListener, TcpStream};
use uuid::Uuid;

struct Db {
    host: String,
    port: u16,
    user: String,
    password: String,
    db: String,
}

fn db_env(name: &str) -> Option<Db> {
    let v = std::env::var(name).ok()?;
    let [host, port, user, password, db] = v.splitn(5, ':').collect::<Vec<_>>()[..] else { return None };
    Some(Db {
        host: host.into(),
        port: port.parse().ok()?,
        user: user.into(),
        password: password.into(),
        db: db.into(),
    })
}

fn hop_env(name: &str, auth: SshAuth) -> Option<SshHop> {
    let v = std::env::var(name).ok()?;
    let (user, rest) = v.split_once('@')?;
    let (host, port) = rest.rsplit_once(':')?;
    Some(SshHop { id: Uuid::new_v4(), host: host.into(), port: port.parse().ok()?, user: user.into(), auth })
}

fn profile(engine: Engine, d: &Db, ssl: SslMode, network: Network) -> ConnectionProfile {
    ConnectionProfile {
        id: Uuid::new_v4(),
        name: "test".into(),
        engine,
        environment: "local".into(),
        host: d.host.clone(),
        port: d.port,
        user: d.user.clone(),
        database: d.db.clone(),
        ssl_mode: ssl,
        network,
        confirm_writes: false,
        read_only: false,
        last_used_at: None,
    }
}

/// Open a session through SSH. A test server's key changes when its container is rebuilt: the old
/// key is replaced, like pressing "Replace Key and Retry".
async fn open_ssh(p: ConnectionProfile, s: &ProfileSecrets) -> Session {
    for _ in 0..3 {
        match Session::open(p.clone(), s).await {
            Ok(session) => return session,
            Err(e) => match e.root() {
                Error::HostKeyChanged { host, port, key, .. } => known_hosts::replace(host, *port, key).await.unwrap(),
                _ => panic!("open failed: {e}"),
            },
        }
    }
    panic!("could not open session")
}

/// The same for tests that only call `Session::test`.
async fn replace_changed_key(hop: &SshHop, d: &Db) {
    let net = Network { mode: NetworkMode::SshTunnel, hops: vec![hop.clone()] };
    let r = Session::test(profile(Engine::Postgres, d, SslMode::Prefer, net), &ProfileSecrets::default()).await;
    if let Some(Error::HostKeyChanged { host, port, key, .. }) = r.error.as_ref().map(Error::root) {
        known_hosts::replace(host, *port, key).await.unwrap();
    }
}

/// A TCP proxy to a server. `freeze` leaves its open connections open but silent, like after the
/// Mac slept; `cut` closes them, like a server that went away. New connections always work.
struct Proxy {
    port: u16,
    epoch: tokio::sync::watch::Sender<u64>,
    cut: Arc<AtomicBool>,
}

impl Proxy {
    async fn start(host: &str, port: u16, listen: u16) -> Proxy {
        let listener = TcpListener::bind(("127.0.0.1", listen)).await.unwrap();
        let local = listener.local_addr().unwrap().port();
        let (epoch, changes) = tokio::sync::watch::channel(0u64);
        let cut = Arc::new(AtomicBool::new(false));
        let (target, closing) = (format!("{host}:{port}"), cut.clone());
        tokio::spawn(async move {
            while let Ok((mut inbound, _)) = listener.accept().await {
                let mut changed = changes.clone();
                changed.mark_unchanged();
                let (target, closing) = (target.clone(), closing.clone());
                tokio::spawn(async move {
                    let mut outbound = TcpStream::connect(&target).await.unwrap();
                    tokio::select! {
                        _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound) => {}
                        _ = changed.changed() => {
                            if !closing.load(Ordering::SeqCst) {
                                std::future::pending::<()>().await;
                            }
                        }
                    }
                });
            }
        });
        Proxy { port: local, epoch, cut }
    }

    fn freeze(&self) {
        self.cut.store(false, Ordering::SeqCst);
        self.epoch.send_modify(|e| *e += 1);
    }

    fn cut(&self) {
        self.cut.store(true, Ordering::SeqCst);
        self.epoch.send_modify(|e| *e += 1);
    }
}

/// The server's id for the session's connection (Postgres backend pid, MySQL connection id).
async fn connection_id(s: &Session) -> String {
    let sql = match s.profile.engine {
        Engine::Postgres => "SELECT pg_backend_pid()",
        Engine::Mysql => "SELECT CONNECTION_ID()",
    };
    s.run(sql, true).await.unwrap().sets[0].rows[0][0].clone().unwrap()
}

#[tokio::test]
#[ignore]
async fn postgres_direct() {
    let Some(d) = db_env("ONECLIENT_TEST_PG") else { return eprintln!("skip: ONECLIENT_TEST_PG") };
    let secrets = ProfileSecrets { db_password: Some(d.password.clone()), ..Default::default() };
    let s = Session::open(profile(Engine::Postgres, &d, SslMode::Prefer, Network::default()), &secrets).await.unwrap();
    eprintln!("{}", s.info().server_version);

    let out = s.run("SELECT 1 AS one, NULL::text AS nothing; SELECT 'a;b' AS semi", false).await.unwrap();
    assert_eq!(out.sets.len(), 2);
    assert_eq!(out.sets[0].rows[0], vec![Some("1".into()), None]);
    assert_eq!(out.sets[1].rows[0][0].as_deref(), Some("a;b"));

    let single = s.run("SELECT 42::int8 AS n", false).await.unwrap();
    assert_eq!(single.sets[0].columns[0].type_name.as_deref(), Some("int8"));

    // Big results keep the first ROW_LIMIT rows and still report the real count.
    let big = s.run("SELECT g FROM generate_series(1, 25000) g", false).await.unwrap();
    assert_eq!((big.sets[0].rows.len(), big.sets[0].truncated), (ROW_LIMIT, true));
    assert_eq!(big.sets[0].row_count, Some(25_000));
    assert_eq!(big.sets[0].rows[ROW_LIMIT - 1][0].as_deref(), Some("10000"));

    let err = s.run("SELECT totl FROM pg_class", false).await.unwrap_err();
    assert!(err.to_string().contains("totl"), "{err}");
    let Error::Db(db) = &err else { panic!("expected a server error, got {err:?}") };
    assert_eq!(db.sqlstate.as_deref(), Some("42703"));
    assert_eq!(db.position, Some(8));
    eprintln!("{err}");

    let tables = s.introspect().await.unwrap();
    eprintln!("{} tables", tables.len());
    // Any `orders` table with a `customer_id` (other schemas may have an `orders` of their own).
    let orders = tables.iter().find(|t| t.name == "orders" && t.columns.iter().any(|c| c.name == "customer_id"));
    if let Some(orders) = orders {
        let fk = orders.columns.iter().find(|c| c.name == "customer_id").unwrap();
        eprintln!("orders.customer_id -> {:?}", fk.references);
        assert!(fk.references.as_deref().is_some_and(|r| r.ends_with("customers.id")));
    }
}

/// The referenced column of every foreign key column, as `table.column → schema.table.column`.
fn references(tables: &[TableInfo], schema: &str) -> Vec<String> {
    let mut out: Vec<String> = tables
        .iter()
        .filter(|t| t.schema == schema)
        .flat_map(|t| t.columns.iter().filter(|c| c.foreign_key).map(move |c| (t, c)))
        .map(|(t, c)| format!("{}.{} → {}", t.name, c.name, c.references.as_deref().unwrap_or("?")))
        .collect();
    out.sort();
    out
}

#[tokio::test]
#[ignore]
async fn postgres_keys() {
    let Some(d) = db_env("ONECLIENT_TEST_PG") else { return eprintln!("skip: ONECLIENT_TEST_PG") };
    let secrets = ProfileSecrets { db_password: Some(d.password.clone()), ..Default::default() };
    let s = Session::open(profile(Engine::Postgres, &d, SslMode::Prefer, Network::default()), &secrets).await.unwrap();
    s.run(
        "DROP SCHEMA IF EXISTS oneclient_keys CASCADE; CREATE SCHEMA oneclient_keys; SET search_path = oneclient_keys;
         CREATE TABLE people (id int PRIMARY KEY); CREATE TABLE houses (id int PRIMARY KEY);
         CREATE TABLE lines (order_id int, line int, PRIMARY KEY (order_id, line));
         -- Same constraint name on two tables, and a composite key in reverse column order.
         CREATE TABLE kids (id int PRIMARY KEY, parent int, CONSTRAINT fk_parent FOREIGN KEY (parent) REFERENCES people(id));
         CREATE TABLE pets (id int PRIMARY KEY, home int, CONSTRAINT fk_parent FOREIGN KEY (home) REFERENCES houses(id));
         CREATE TABLE shipments (id int PRIMARY KEY, l int, o int, FOREIGN KEY (l, o) REFERENCES lines(line, order_id));
         RESET search_path",
        false,
    )
    .await
    .unwrap();
    let tables = s.introspect().await.unwrap();
    s.run("DROP SCHEMA oneclient_keys CASCADE", false).await.unwrap();
    assert_eq!(
        references(&tables, "oneclient_keys"),
        [
            "kids.parent → oneclient_keys.people.id",
            "pets.home → oneclient_keys.houses.id",
            "shipments.l → oneclient_keys.lines.line",
            "shipments.o → oneclient_keys.lines.order_id",
        ]
    );
    let lines = tables.iter().find(|t| t.schema == "oneclient_keys" && t.name == "lines").unwrap();
    assert!(lines.columns.iter().all(|c| c.primary_key), "both columns of a composite primary key");
}

#[tokio::test]
#[ignore]
async fn mysql_keys() {
    let Some(d) = db_env("ONECLIENT_TEST_MYSQL") else { return eprintln!("skip: ONECLIENT_TEST_MYSQL") };
    let secrets = ProfileSecrets { db_password: Some(d.password.clone()), ..Default::default() };
    let s = Session::open(profile(Engine::Mysql, &d, SslMode::Prefer, Network::default()), &secrets).await.unwrap();
    let drop = "DROP TABLE IF EXISTS oc_shipments, oc_lines";
    s.run(drop, false).await.unwrap();
    s.run("CREATE TABLE oc_lines (order_id INT, line INT, PRIMARY KEY (order_id, line))", false).await.unwrap();
    s.run("CREATE TABLE oc_shipments (id INT PRIMARY KEY, l INT, o INT, FOREIGN KEY (o, l) REFERENCES oc_lines(order_id, line))", false)
        .await
        .unwrap();
    let tables = s.introspect().await.unwrap();
    s.run(drop, false).await.unwrap();
    let mine: Vec<String> = references(&tables, &d.db).into_iter().filter(|r| r.starts_with("oc_")).collect();
    assert_eq!(
        mine,
        [format!("oc_shipments.l → {}.oc_lines.line", d.db), format!("oc_shipments.o → {}.oc_lines.order_id", d.db)]
    );
}

#[tokio::test]
#[ignore]
async fn mysql_direct() {
    let Some(d) = db_env("ONECLIENT_TEST_MYSQL") else { return eprintln!("skip: ONECLIENT_TEST_MYSQL") };
    let secrets = ProfileSecrets { db_password: Some(d.password.clone()), ..Default::default() };
    let s = Session::open(profile(Engine::Mysql, &d, SslMode::Prefer, Network::default()), &secrets).await.unwrap();
    eprintln!("{}", s.info().server_version);

    let out =
        s.run("SELECT 1 AS one, NULL AS nothing, CAST('2026-10-01' AS DATE) AS d; SELECT 2", false).await.unwrap();
    assert_eq!(out.sets.len(), 2);
    assert_eq!(out.sets[0].rows[0], vec![Some("1".into()), None, Some("2026-10-01".into())]);

    let w = s.run("CREATE TEMPORARY TABLE t1 (x INT); INSERT INTO t1 VALUES (1),(2),(3)", false).await.unwrap();
    assert_eq!(w.sets.last().unwrap().row_count, Some(3));

    // Big results keep the first ROW_LIMIT rows and still report the real count.
    let big = s
        .run(
            "SET SESSION cte_max_recursion_depth = 30000; \
             WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 25000) SELECT n FROM seq",
            false,
        )
        .await
        .unwrap();
    let set = big.sets.last().unwrap();
    assert_eq!((set.rows.len(), set.truncated, set.row_count), (ROW_LIMIT, true, Some(25_000)));

    // Fractional seconds survive.
    let t = s.run("SELECT CAST('2026-01-02 03:04:05.123456' AS DATETIME(6))", false).await.unwrap();
    assert_eq!(t.sets[0].rows[0][0].as_deref(), Some("2026-01-02 03:04:05.123456"));

    let err = s.run("SELECT nope FROM DUAL", false).await.unwrap_err();
    assert!(err.to_string().starts_with("ERROR 1054 (42S22): Unknown column 'nope'"), "{err}");
    let err = s.run("SELEC 1", false).await.unwrap_err();
    assert!(err.to_string().starts_with("ERROR 1064 (42000)"), "{err}");
    eprintln!("{err}");

    let tables = s.introspect().await.unwrap();
    eprintln!("{} tables", tables.len());
    // Any `orders` table with a `customer_id` (other schemas may have an `orders` of their own).
    let orders = tables.iter().find(|t| t.name == "orders" && t.columns.iter().any(|c| c.name == "customer_id"));
    if let Some(orders) = orders {
        let fk = orders.columns.iter().find(|c| c.name == "customer_id").unwrap();
        eprintln!("orders.customer_id -> {:?}", fk.references);
        assert!(fk.references.as_deref().is_some_and(|r| r.ends_with("customers.id")));
    }
}

#[tokio::test]
#[ignore]
async fn postgres_through_ssh_tunnel() {
    let Some(d) = db_env("ONECLIENT_TEST_PG") else { return eprintln!("skip: ONECLIENT_TEST_PG") };
    let Ok(key) = std::env::var("ONECLIENT_TEST_SSH_KEY") else { return eprintln!("skip: ONECLIENT_TEST_SSH_KEY") };
    let Some(hop) = hop_env("ONECLIENT_TEST_SSH", SshAuth::KeyFile { path: key }) else { return };
    let mut secrets = ProfileSecrets { db_password: Some(d.password.clone()), ..Default::default() };
    let pass = std::env::var("ONECLIENT_TEST_SSH_KEY_PASS").ok().filter(|p| !p.is_empty());
    secrets.hops.insert(hop.id, HopSecret { password: None, key_passphrase: pass });

    let net = Network { mode: NetworkMode::SshTunnel, hops: vec![hop] };
    let p = profile(Engine::Postgres, &d, SslMode::Require, net);
    let s = open_ssh(p.clone(), &secrets).await;
    assert_eq!(s.info().hops, 1);
    let out = s.run("SELECT current_database()", false).await.unwrap();
    assert_eq!(out.sets[0].rows[0][0].as_deref(), Some(d.db.as_str()));

    // Browsing from the form and switching databases work through the tunnel too.
    assert!(Session::list_databases(&p, &secrets).await.unwrap().contains(&"postgres".to_string()));
    let info = s.use_database("postgres").await.unwrap();
    assert_eq!((info.database.as_str(), info.hops), ("postgres", 1));
}

#[tokio::test]
#[ignore]
async fn mysql_through_two_hop_bastion() {
    let Some(d) = db_env("ONECLIENT_TEST_MYSQL") else { return eprintln!("skip: ONECLIENT_TEST_MYSQL") };
    let Ok(key) = std::env::var("ONECLIENT_TEST_SSH_KEY") else { return eprintln!("skip: ONECLIENT_TEST_SSH_KEY") };
    // Hop 1 uses the SSH agent when one is running, otherwise the key file.
    let auth1 = if std::env::var_os("SSH_AUTH_SOCK").is_some() {
        SshAuth::Agent { socket: None }
    } else {
        SshAuth::KeyFile { path: key }
    };
    let Some(h1) = hop_env("ONECLIENT_TEST_SSH", auth1) else { return };
    let Some(h2) = hop_env("ONECLIENT_TEST_SSH2", SshAuth::Password) else {
        return eprintln!("skip: ONECLIENT_TEST_SSH2");
    };

    let mut secrets = ProfileSecrets { db_password: Some(d.password.clone()), ..Default::default() };
    let pass = std::env::var("ONECLIENT_TEST_SSH_KEY_PASS").ok().filter(|p| !p.is_empty());
    secrets.hops.insert(h1.id, HopSecret { password: None, key_passphrase: pass });
    secrets.hops.insert(
        h2.id,
        HopSecret { password: std::env::var("ONECLIENT_TEST_SSH2_PASSWORD").ok(), key_passphrase: None },
    );

    let net = Network { mode: NetworkMode::Bastion, hops: vec![h1, h2] };
    let s = open_ssh(profile(Engine::Mysql, &d, SslMode::Prefer, net), &secrets).await;
    assert_eq!(s.info().hops, 2);
    let out = s.run("SELECT DATABASE()", false).await.unwrap();
    assert_eq!(out.sets[0].rows[0][0].as_deref(), Some(d.db.as_str()));
}

/// Each failure is reported at the right step, with earlier steps ok and later ones skipped.
#[tokio::test]
#[ignore]
async fn test_reports_the_failing_step() {
    use oneclient_core::steps::StepStatus;
    let Some(d) = db_env("ONECLIENT_TEST_PG") else { return eprintln!("skip: ONECLIENT_TEST_PG") };
    let pw = |p: &str| ProfileSecrets { db_password: Some(p.into()), ..Default::default() };
    let failed = |r: &TestReport| {
        let f = r.steps.iter().find(|s| s.status == StepStatus::Failed).expect("a failed step");
        eprintln!(
            "  ✗ {} — {}\n    hint: {}",
            f.label,
            f.detail.clone().unwrap_or_default(),
            f.hint.clone().unwrap_or_default()
        );
        f.label.clone()
    };

    let ok = Session::test(profile(Engine::Postgres, &d, SslMode::Prefer, Network::default()), &pw(&d.password)).await;
    assert!(ok.ok, "{:?}", ok.steps);

    let r = Session::test(profile(Engine::Postgres, &d, SslMode::Prefer, Network::default()), &pw("wrong")).await;
    assert!(failed(&r).starts_with("Sign in to PostgreSQL"));
    assert_eq!(r.steps.last().unwrap().status, StepStatus::Skipped);

    let mut nodb = profile(Engine::Postgres, &d, SslMode::Prefer, Network::default());
    nodb.database = "does_not_exist".into();
    let r = Session::test(nodb, &pw(&d.password)).await;
    assert!(failed(&r).starts_with("Open database"));

    let mut closed = profile(Engine::Postgres, &d, SslMode::Prefer, Network::default());
    closed.port = 1;
    let r = Session::test(closed, &pw(&d.password)).await;
    assert!(failed(&r).starts_with("Reach database"));

    if let Some(m) = db_env("ONECLIENT_TEST_MYSQL") {
        let r = Session::test(profile(Engine::Mysql, &m, SslMode::Prefer, Network::default()), &pw("wrong")).await;
        assert!(failed(&r).starts_with("Sign in to MySQL"));
    }

    // Through SSH: a wrong SSH password, then a database port the SSH host cannot reach.
    if let (Ok(key), Some(h2)) =
        (std::env::var("ONECLIENT_TEST_SSH_KEY"), hop_env("ONECLIENT_TEST_SSH2", SshAuth::Password))
    {
        replace_changed_key(&h2, &d).await;
        let mut s = pw(&d.password);
        s.hops.insert(h2.id, HopSecret { password: Some("wrong".into()), key_passphrase: None });
        let net = Network { mode: NetworkMode::SshTunnel, hops: vec![h2.clone()] };
        let r = Session::test(profile(Engine::Postgres, &d, SslMode::Prefer, net), &s).await;
        assert!(failed(&r).starts_with("Sign in as"));

        let h1 = hop_env("ONECLIENT_TEST_SSH", SshAuth::KeyFile { path: key }).unwrap();
        replace_changed_key(&h1, &d).await;
        let mut s = pw(&d.password);
        let pass = std::env::var("ONECLIENT_TEST_SSH_KEY_PASS").ok().filter(|p| !p.is_empty());
        s.hops.insert(h1.id, HopSecret { password: None, key_passphrase: pass });
        let mut p =
            profile(Engine::Postgres, &d, SslMode::Prefer, Network { mode: NetworkMode::SshTunnel, hops: vec![h1] });
        p.port = 1;
        let r = Session::test(p, &s).await;
        assert!(failed(&r).starts_with("Reach database"), "{:?}", r.steps);
    }
}

/// A link from another app opens a working session (ONECLIENT_TEST_PG as host:port:user:password:db).
#[tokio::test]
#[ignore]
async fn opens_a_link() {
    let Some(d) = db_env("ONECLIENT_TEST_PG") else { return eprintln!("skip: ONECLIENT_TEST_PG") };
    let enc = |s: &str| s.bytes().map(|b| format!("%{b:02X}")).collect::<String>();
    let db_url = format!("postgresql://{}:{}@{}:{}/{}", enc(&d.user), enc(&d.password), d.host, d.port, enc(&d.db));
    let link = format!("oneclient://open?url={}&name=from%20a%20link&unknown=1", enc(&db_url));
    let incoming = oneclient_core::link::parse_link(&link).unwrap();
    assert_eq!(incoming.profile.name, "from a link");
    let secrets = ProfileSecrets { db_password: incoming.db_password.clone(), ..Default::default() };
    let s = Session::open(incoming.profile, &secrets).await.unwrap();
    let out = s.run("SELECT current_database()", false).await.unwrap();
    assert_eq!(out.sets[0].rows[0][0].as_deref(), Some(d.db.as_str()));
}

/// Grid edits: source columns are reported, rows are saved by primary key, and a missing
/// row rolls the whole save back.
async fn edits_round_trip(engine: Engine, var: &str) {
    use oneclient_core::edit::{CellValue, RowEdit};
    let Some(d) = db_env(var) else { return eprintln!("skip: {var}") };
    let secrets = ProfileSecrets { db_password: Some(d.password.clone()), ..Default::default() };
    let mut p = profile(engine, &d, SslMode::Prefer, Network::default());
    let s = Session::open(p.clone(), &secrets).await.unwrap();
    let schema = if engine == Engine::Postgres { "public".to_string() } else { d.db.clone() };
    s.run("DROP TABLE IF EXISTS oc_edit_test", false).await.unwrap();
    s.run("CREATE TABLE oc_edit_test (id INT PRIMARY KEY, lang VARCHAR(20), note TEXT)", false).await.unwrap();
    s.run("INSERT INTO oc_edit_test VALUES (1, 'de', 'x'), (2, 'de', NULL)", false).await.unwrap();

    let out = s.run("SELECT id, lang, note, 1 + 1 AS two FROM oc_edit_test ORDER BY id", false).await.unwrap();
    let cols = &out.sets[0].columns;
    let src = cols[1].source.as_ref().expect("lang has a source");
    assert_eq!(
        (src.schema.as_str(), src.table.as_str(), src.column.as_str()),
        (schema.as_str(), "oc_edit_test", "lang")
    );
    assert!(cols[3].source.is_none(), "computed column must not be editable");

    let cell = |c: &str, v: Option<&str>| CellValue { column: c.into(), value: v.map(Into::into) };
    let row = |id: &str, lang: &str| RowEdit {
        schema: schema.clone(),
        table: "oc_edit_test".into(),
        key: vec![cell("id", Some(id))],
        values: vec![cell("lang", Some(lang)), cell("note", None)],
    };
    // Unchanged value still counts as one matched row; quotes and backslashes survive.
    assert_eq!(s.apply_edits(&[row("1", r"it's \en"), row("2", "de")]).await.unwrap(), 2);
    let out = s.run("SELECT lang, note FROM oc_edit_test ORDER BY id", false).await.unwrap();
    assert_eq!(out.sets[0].rows[0], vec![Some(r"it's \en".into()), None]);

    // Row 99 doesn't exist: nothing is saved, row 1 keeps its value.
    let err = s.apply_edits(&[row("1", "fr"), row("99", "fr")]).await.unwrap_err().to_string();
    assert!(err.contains("no longer exists"), "{err}");
    let out = s.run("SELECT lang FROM oc_edit_test WHERE id = 1", false).await.unwrap();
    assert_eq!(out.sets[0].rows[0][0].as_deref(), Some(r"it's \en"));

    s.run("DROP TABLE oc_edit_test", false).await.unwrap();
    p.read_only = true;
    let ro = Session::open(p, &secrets).await.unwrap();
    assert!(ro.apply_edits(&[row("1", "x")]).await.unwrap_err().to_string().contains("read-only"));
}

#[tokio::test]
#[ignore]
async fn postgres_edits() {
    edits_round_trip(Engine::Postgres, "ONECLIENT_TEST_PG").await;
}

#[tokio::test]
#[ignore]
async fn mysql_edits() {
    edits_round_trip(Engine::Mysql, "ONECLIENT_TEST_MYSQL").await;
}

/// The server ends the session between statements, and while one runs: the connection is opened
/// again, a read runs again, and a write is not sent twice.
async fn server_ends_the_session(engine: Engine, var: &str) {
    let Some(d) = db_env(var) else { return eprintln!("skip: {var}") };
    let secrets = ProfileSecrets { db_password: Some(d.password.clone()), ..Default::default() };
    let p = profile(engine, &d, SslMode::Prefer, Network::default());
    let s = Session::open(p.clone(), &secrets).await.unwrap();
    let admin = &Session::open(p, &secrets).await.unwrap();
    let end = |id: String| async move {
        let sql = match engine {
            Engine::Postgres => format!("SELECT pg_terminate_backend({id})"),
            Engine::Mysql => format!("KILL {id}"),
        };
        admin.run(&sql, false).await.unwrap();
    };

    let first = connection_id(&s).await;
    end(first.clone()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_ne!(connection_id(&s).await, first);
    assert!(s.take_reconnected());

    let slow = match engine {
        Engine::Postgres => "SELECT pg_sleep(2)",
        Engine::Mysql => "SELECT SLEEP(2)",
    };
    for rerun in [true, false] {
        let id = connection_id(&s).await;
        let ending = async {
            tokio::time::sleep(Duration::from_millis(500)).await;
            end(id).await;
        };
        let (result, ()) = tokio::join!(s.run(slow, rerun), ending);
        match rerun {
            true => assert!(result.is_ok(), "a read runs again: {result:?}"),
            false => assert!(matches!(result, Err(Error::Interrupted)), "a write is not sent twice: {result:?}"),
        }
    }
    connection_id(&s).await;
}

#[tokio::test]
#[ignore]
async fn postgres_server_ends_the_session() {
    server_ends_the_session(Engine::Postgres, "ONECLIENT_TEST_PG").await;
}

#[tokio::test]
#[ignore]
async fn mysql_server_ends_the_session() {
    server_ends_the_session(Engine::Mysql, "ONECLIENT_TEST_MYSQL").await;
}

/// After sleep, connections look open but carry nothing. The next statement finds out with a
/// ping, before it is sent, and runs on a new connection. Takes over 30 seconds.
#[tokio::test]
#[ignore]
async fn reconnects_after_sleep() {
    let Some(d) = db_env("ONECLIENT_TEST_PG") else { return eprintln!("skip: ONECLIENT_TEST_PG") };
    let secrets = ProfileSecrets { db_password: Some(d.password.clone()), ..Default::default() };
    let proxy = Proxy::start(&d.host, d.port, 0).await;
    let mut p = profile(Engine::Postgres, &d, SslMode::Prefer, Network::default());
    (p.host, p.port) = ("127.0.0.1".into(), proxy.port);
    let s = Session::open(p, &secrets).await.unwrap();
    let first = connection_id(&s).await;

    proxy.freeze();
    tokio::time::sleep(Duration::from_secs(31)).await;
    let started = Instant::now();
    let out = s.run("SELECT pg_backend_pid()", false).await.unwrap();
    eprintln!("found the dead connection and opened a new one in {:?}", started.elapsed());
    assert_ne!(out.sets[0].rows[0][0].as_deref(), Some(first.as_str()));
    assert!(s.take_reconnected());
}

/// The SSH connection drops (another network, the server restarted): the tunnel is opened again.
#[tokio::test]
#[ignore]
async fn reconnects_when_the_ssh_connection_drops() {
    let Some(d) = db_env("ONECLIENT_TEST_PG") else { return eprintln!("skip: ONECLIENT_TEST_PG") };
    let Ok(key) = std::env::var("ONECLIENT_TEST_SSH_KEY") else { return eprintln!("skip: ONECLIENT_TEST_SSH_KEY") };
    let Some(mut hop) = hop_env("ONECLIENT_TEST_SSH", SshAuth::KeyFile { path: key }) else { return };
    // A fixed port, so known_hosts keeps one entry for it.
    let proxy = Proxy::start(&hop.host, hop.port, 62222).await;
    (hop.host, hop.port) = ("127.0.0.1".into(), proxy.port);
    let mut secrets = ProfileSecrets { db_password: Some(d.password.clone()), ..Default::default() };
    let pass = std::env::var("ONECLIENT_TEST_SSH_KEY_PASS").ok().filter(|p| !p.is_empty());
    secrets.hops.insert(hop.id, HopSecret { password: None, key_passphrase: pass });
    let net = Network { mode: NetworkMode::SshTunnel, hops: vec![hop] };
    let s = open_ssh(profile(Engine::Postgres, &d, SslMode::Prefer, net), &secrets).await;
    let first = connection_id(&s).await;

    proxy.cut();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_ne!(connection_id(&s).await, first);
    assert!(s.take_reconnected());
}

/// The form lists the databases (also when the one typed there doesn't exist), and an open session
/// switches between them: it stays in the new one after a reconnect, and a failed switch changes nothing.
async fn databases_list_and_switch(engine: Engine, var: &str) {
    let Some(d) = db_env(var) else { return eprintln!("skip: {var}") };
    let secrets = ProfileSecrets { db_password: Some(d.password.clone()), ..Default::default() };
    let p = profile(engine, &d, SslMode::Prefer, Network::default());
    let admin = Session::open(p.clone(), &secrets).await.unwrap();
    let (create, drop) = match engine {
        Engine::Postgres => ("CREATE DATABASE oc_other", "DROP DATABASE IF EXISTS oc_other WITH (FORCE)"),
        Engine::Mysql => ("CREATE DATABASE oc_other", "DROP DATABASE IF EXISTS oc_other"),
    };
    admin.run(drop, false).await.unwrap();
    if let Err(e) = admin.run(create, false).await {
        return eprintln!("skip: {} can't create a database ({e})", d.user);
    }

    let listed = Session::list_databases(&p, &secrets).await.unwrap();
    eprintln!("databases: {listed:?}");
    assert!(listed.contains(&d.db) && listed.contains(&"oc_other".to_string()));
    let system = ["template0", "template1", "mysql", "sys", "information_schema", "performance_schema"];
    assert!(!listed.iter().any(|n| system.contains(&n.as_str())), "system databases are left out");
    let typo = ConnectionProfile { database: "does_not_exist".into(), ..p.clone() };
    assert_eq!(Session::list_databases(&typo, &secrets).await.unwrap(), listed, "a database that doesn't exist");

    let s = Session::open(p, &secrets).await.unwrap();
    assert_eq!(s.info().database, d.db);
    assert_eq!(s.databases().await.unwrap(), listed);
    assert_eq!(s.use_database("oc_other").await.unwrap().database, "oc_other");
    s.run("CREATE TABLE oc_marker (id INT PRIMARY KEY)", false).await.unwrap();
    let marker = |tables: Vec<TableInfo>| tables.into_iter().find(|t| t.name == "oc_marker").map(|t| t.schema);
    let schema = marker(s.introspect().await.unwrap()).expect("the new database's table");
    if engine == Engine::Mysql {
        assert_eq!(schema, "oc_other");
    }

    // A reconnect opens the database switched to, not the saved one.
    let id = connection_id(&s).await;
    let end = match engine {
        Engine::Postgres => format!("SELECT pg_terminate_backend({id})"),
        Engine::Mysql => format!("KILL {id}"),
    };
    admin.run(&end, false).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_ne!(connection_id(&s).await, id);
    assert_eq!(s.info().database, "oc_other");

    let err = s.use_database("does_not_exist").await.unwrap_err();
    eprintln!("{err}");
    assert_eq!(s.info().database, "oc_other", "a failed switch keeps the database");
    s.run("SELECT 1", false).await.unwrap();

    assert_eq!(s.use_database(&d.db).await.unwrap().database, d.db);
    if engine == Engine::Postgres {
        assert_eq!(marker(s.introspect().await.unwrap()), None, "each PostgreSQL database has its own tables");
    }
    admin.run(drop, false).await.unwrap();
}

#[tokio::test]
#[ignore]
async fn postgres_databases() {
    databases_list_and_switch(Engine::Postgres, "ONECLIENT_TEST_PG").await;
}

#[tokio::test]
#[ignore]
async fn mysql_databases() {
    databases_list_and_switch(Engine::Mysql, "ONECLIENT_TEST_MYSQL").await;
}
