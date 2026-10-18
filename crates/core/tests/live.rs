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
//! keys to ~/.ssh/known_hosts, so only point them at machines you trust.

use oneclient_core::secrets::{HopSecret, ProfileSecrets};
use oneclient_core::*;
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

/// Open a session, trusting an unknown host key once (like clicking "Trust and Retry").
async fn open_trusting(p: ConnectionProfile, s: &ProfileSecrets) -> Session {
    for _ in 0..4 {
        match Session::open(p.clone(), s).await {
            Ok(sess) => return sess,
            Err(e) if matches!(e.root(), Error::UnknownHostKey { .. }) => {
                let Error::UnknownHostKey { host, port, fingerprint, key } = e.root() else { unreachable!() };
                let (host, port, key) = (host.clone(), *port, key.clone());
                eprintln!("trusting {host}:{port} {fingerprint}");
                tunnel::trust_host_key(&host, port, &key).unwrap();
            }
            Err(e) => panic!("open failed: {e}"),
        }
    }
    panic!("could not open session")
}

#[tokio::test]
#[ignore]
async fn postgres_direct() {
    let Some(d) = db_env("ONECLIENT_TEST_PG") else { return eprintln!("skip: ONECLIENT_TEST_PG") };
    let secrets = ProfileSecrets { db_password: Some(d.password.clone()), ..Default::default() };
    let s = Session::open(profile(Engine::Postgres, &d, SslMode::Prefer, Network::default()), &secrets).await.unwrap();
    eprintln!("{}", s.server_version);

    let out = s.run("SELECT 1 AS one, NULL::text AS nothing; SELECT 'a;b' AS semi").await.unwrap();
    assert_eq!(out.sets.len(), 2);
    assert_eq!(out.sets[0].rows[0], vec![Some("1".into()), None]);
    assert_eq!(out.sets[1].rows[0][0].as_deref(), Some("a;b"));

    let single = s.run("SELECT 42::int8 AS n").await.unwrap();
    assert_eq!(single.sets[0].columns[0].type_name.as_deref(), Some("int8"));

    // Big results keep the first ROW_LIMIT rows and still report the real count.
    let big = s.run("SELECT g FROM generate_series(1, 25000) g").await.unwrap();
    assert_eq!((big.sets[0].rows.len(), big.sets[0].truncated), (ROW_LIMIT, true));
    assert_eq!(big.sets[0].row_count, Some(25_000));
    assert_eq!(big.sets[0].rows[ROW_LIMIT - 1][0].as_deref(), Some("10000"));

    let err = s.run("SELECT totl FROM pg_class").await.unwrap_err();
    assert!(err.to_string().contains("totl"), "{err}");
    let Error::Db(db) = &err else { panic!("expected a server error, got {err:?}") };
    assert_eq!(db.sqlstate.as_deref(), Some("42703"));
    assert_eq!(db.position, Some(8));
    eprintln!("{err}");

    let tables = s.introspect().await.unwrap();
    eprintln!("{} tables", tables.len());
    if let Some(orders) = tables.iter().find(|t| t.name == "orders") {
        let fk = orders.columns.iter().find(|c| c.name == "customer_id").unwrap();
        eprintln!("orders.customer_id -> {:?}", fk.references);
        assert!(fk.references.as_deref().is_some_and(|r| r.ends_with("customers.id")));
    }
}

#[tokio::test]
#[ignore]
async fn mysql_direct() {
    let Some(d) = db_env("ONECLIENT_TEST_MYSQL") else { return eprintln!("skip: ONECLIENT_TEST_MYSQL") };
    let secrets = ProfileSecrets { db_password: Some(d.password.clone()), ..Default::default() };
    let s = Session::open(profile(Engine::Mysql, &d, SslMode::Prefer, Network::default()), &secrets).await.unwrap();
    eprintln!("{}", s.server_version);

    let out = s.run("SELECT 1 AS one, NULL AS nothing, CAST('2026-10-01' AS DATE) AS d; SELECT 2").await.unwrap();
    assert_eq!(out.sets.len(), 2);
    assert_eq!(out.sets[0].rows[0], vec![Some("1".into()), None, Some("2026-10-01".into())]);

    let w = s.run("CREATE TEMPORARY TABLE t1 (x INT); INSERT INTO t1 VALUES (1),(2),(3)").await.unwrap();
    assert_eq!(w.sets.last().unwrap().row_count, Some(3));

    // Big results keep the first ROW_LIMIT rows and still report the real count.
    let big = s
        .run(
            "SET SESSION cte_max_recursion_depth = 30000; \
             WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 25000) SELECT n FROM seq",
        )
        .await
        .unwrap();
    let set = big.sets.last().unwrap();
    assert_eq!((set.rows.len(), set.truncated, set.row_count), (ROW_LIMIT, true, Some(25_000)));

    // Fractional seconds survive.
    let t = s.run("SELECT CAST('2026-01-02 03:04:05.123456' AS DATETIME(6))").await.unwrap();
    assert_eq!(t.sets[0].rows[0][0].as_deref(), Some("2026-01-02 03:04:05.123456"));

    let err = s.run("SELECT nope FROM DUAL").await.unwrap_err();
    assert!(err.to_string().starts_with("ERROR 1054 (42S22): Unknown column 'nope'"), "{err}");
    let err = s.run("SELEC 1").await.unwrap_err();
    assert!(err.to_string().starts_with("ERROR 1064 (42000)"), "{err}");
    eprintln!("{err}");

    let tables = s.introspect().await.unwrap();
    eprintln!("{} tables", tables.len());
    if let Some(orders) = tables.iter().find(|t| t.name == "orders") {
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
    let s = open_trusting(profile(Engine::Postgres, &d, SslMode::Require, net), &secrets).await;
    assert_eq!(s.info().hops, 1);
    let out = s.run("SELECT current_database()").await.unwrap();
    assert_eq!(out.sets[0].rows[0][0].as_deref(), Some(d.db.as_str()));
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
    let s = open_trusting(profile(Engine::Mysql, &d, SslMode::Prefer, net), &secrets).await;
    assert_eq!(s.info().hops, 2);
    let out = s.run("SELECT DATABASE()").await.unwrap();
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
        let mut s = pw(&d.password);
        s.hops.insert(h2.id, HopSecret { password: Some("wrong".into()), key_passphrase: None });
        let net = Network { mode: NetworkMode::SshTunnel, hops: vec![h2.clone()] };
        let r = Session::test(profile(Engine::Postgres, &d, SslMode::Prefer, net), &s).await;
        assert!(failed(&r).starts_with("Sign in as"));

        let h1 = hop_env("ONECLIENT_TEST_SSH", SshAuth::KeyFile { path: key }).unwrap();
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
    let out = s.run("SELECT current_database()").await.unwrap();
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
    s.run("DROP TABLE IF EXISTS oc_edit_test").await.unwrap();
    s.run("CREATE TABLE oc_edit_test (id INT PRIMARY KEY, lang VARCHAR(20), note TEXT)").await.unwrap();
    s.run("INSERT INTO oc_edit_test VALUES (1, 'de', 'x'), (2, 'de', NULL)").await.unwrap();

    let out = s.run("SELECT id, lang, note, 1 + 1 AS two FROM oc_edit_test ORDER BY id").await.unwrap();
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
    let out = s.run("SELECT lang, note FROM oc_edit_test ORDER BY id").await.unwrap();
    assert_eq!(out.sets[0].rows[0], vec![Some(r"it's \en".into()), None]);

    // Row 99 doesn't exist: nothing is saved, row 1 keeps its value.
    let err = s.apply_edits(&[row("1", "fr"), row("99", "fr")]).await.unwrap_err().to_string();
    assert!(err.contains("no longer exists"), "{err}");
    let out = s.run("SELECT lang FROM oc_edit_test WHERE id = 1").await.unwrap();
    assert_eq!(out.sets[0].rows[0][0].as_deref(), Some(r"it's \en"));

    s.run("DROP TABLE oc_edit_test").await.unwrap();
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
