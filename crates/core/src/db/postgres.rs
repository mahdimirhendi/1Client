use std::time::Duration;

use futures_util::TryStreamExt;
use postgres_native_tls::MakeTlsConnector;
use tokio::net::TcpStream;
use tokio_postgres::config::SslMode as PgSslMode;
use tokio_postgres::tls::MakeTlsConnect;
use tokio_postgres::{Client, NoTls, SimpleQueryMessage};

use crate::edit::{update_sql, RowEdit, Values};
use crate::error::chain;
use crate::{
    ColumnMeta, ColumnSource, ConnectionProfile, DbStage, Engine, Error, Result, ResultSet, SslMode, ROW_LIMIT,
};

pub(crate) struct PgConn {
    client: Client,
}

/// `addr` is where to open the TCP socket: the real host, or the tunnel's local port.
/// TLS still uses `profile.host` as the server name, so certificates match through a tunnel.
pub(crate) async fn connect(
    profile: &ConnectionProfile,
    password: Option<&str>,
    addr: (&str, u16),
) -> Result<(PgConn, String)> {
    let mut cfg = tokio_postgres::Config::new();
    cfg.user(&profile.user).application_name("1Client").connect_timeout(Duration::from_secs(15));
    if let Some(pw) = password {
        cfg.password(pw);
    }
    if !profile.database.is_empty() {
        cfg.dbname(&profile.database);
    }

    let stream = tokio::time::timeout(Duration::from_secs(15), TcpStream::connect(addr))
        .await
        .map_err(|_| Error::Timeout(format!("connecting to {}:{}", addr.0, addr.1)))?
        .map_err(|e| Error::DbConnect { stage: DbStage::Network, message: e.to_string() })?;
    stream.set_nodelay(true).ok();

    let client = if profile.ssl_mode == SslMode::Disable {
        cfg.ssl_mode(PgSslMode::Disable);
        let (client, conn) = cfg.connect_raw(stream, NoTls).await.map_err(classify)?;
        tokio::spawn(async move {
            if let Err(e) = conn.await {
                tracing::warn!("postgres connection closed: {e}");
            }
        });
        client
    } else {
        cfg.ssl_mode(match profile.ssl_mode {
            SslMode::Prefer => PgSslMode::Prefer,
            _ => PgSslMode::Require,
        });
        let verify = profile.ssl_mode == SslMode::VerifyFull;
        let tls = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(!verify)
            .danger_accept_invalid_hostnames(!verify)
            .build()
            .map_err(|e| Error::Postgres(format!("TLS setup: {e}")))?;
        let mut maker = MakeTlsConnector::new(tls);
        let tls = MakeTlsConnect::<TcpStream>::make_tls_connect(&mut maker, &profile.host)
            .map_err(|e| Error::Postgres(format!("TLS setup: {e}")))?;
        let (client, conn) = cfg.connect_raw(stream, tls).await.map_err(classify)?;
        tokio::spawn(async move {
            if let Err(e) = conn.await {
                tracing::warn!("postgres connection closed: {e}");
            }
        });
        client
    };

    if profile.read_only {
        client.batch_execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY").await?;
    }
    let version = client
        .simple_query("SHOW server_version")
        .await?
        .into_iter()
        .find_map(|m| match m {
            SimpleQueryMessage::Row(r) => r.get(0).map(|v| v.split_whitespace().next().unwrap_or(v).to_string()),
            _ => None,
        })
        .unwrap_or_default();
    Ok((PgConn { client }, format!("PostgreSQL {version}")))
}

/// Sort a connect error into the part of the connection that failed.
fn classify(e: tokio_postgres::Error) -> Error {
    if let Some(db) = e.as_db_error() {
        let stage = match db.code().code() {
            "3D000" => DbStage::Database, // invalid_catalog_name: database does not exist
            "42501" => DbStage::Database, // insufficient_privilege (e.g. no CONNECT on the database)
            _ => DbStage::Auth,           // 28P01 wrong password, 28000 pg_hba rules, …
        };
        return Error::DbConnect { stage, message: db.message().to_string() };
    }
    let message = chain(&e);
    let low = message.to_lowercase();
    let stage = if low.contains("tls") || low.contains("ssl") || low.contains("certificate") {
        DbStage::Tls
    } else if low.contains("password") {
        DbStage::Auth
    } else {
        DbStage::Network
    };
    Error::DbConnect { stage, message }
}

impl PgConn {
    pub(crate) fn is_closed(&self) -> bool {
        self.client.is_closed()
    }

    /// An empty query: answered even inside a failed transaction, and changes nothing.
    pub(crate) async fn ping(&self) -> Result<()> {
        self.client.simple_query("").await?;
        Ok(())
    }

    /// Run one or more statements with the simple query protocol (values come back as text).
    /// Rows are read as they arrive, so only the first `ROW_LIMIT` of each set are kept in memory.
    pub(crate) async fn run(&self, sql: &str) -> Result<Vec<ResultSet>> {
        let mut sets = Vec::new();
        let mut current: Option<ResultSet> = None;

        let stream = self.client.simple_query_raw(sql).await?;
        futures_util::pin_mut!(stream);
        while let Some(msg) = stream.try_next().await? {
            match msg {
                SimpleQueryMessage::RowDescription(cols) => {
                    current = Some(ResultSet {
                        columns: cols
                            .iter()
                            .map(|c| ColumnMeta { name: c.name().to_string(), type_name: None, source: None })
                            .collect(),
                        ..Default::default()
                    });
                }
                SimpleQueryMessage::Row(row) => {
                    let set = current.get_or_insert_with(|| ResultSet {
                        columns: row
                            .columns()
                            .iter()
                            .map(|c| ColumnMeta { name: c.name().to_string(), type_name: None, source: None })
                            .collect(),
                        ..Default::default()
                    });
                    if set.rows.len() < ROW_LIMIT {
                        set.rows.push((0..row.len()).map(|i| row.get(i).map(str::to_owned)).collect());
                    } else {
                        set.truncated = true;
                    }
                }
                SimpleQueryMessage::CommandComplete(n) => {
                    let mut set = current.take().unwrap_or_default();
                    set.row_count = Some(n);
                    sets.push(set);
                }
                _ => {}
            }
        }
        if let Some(set) = current.take() {
            sets.push(set);
        }

        // Type names and source columns for the grid. Only possible for a single statement;
        // a failure here never fails the query.
        if sets.len() == 1 && !sets[0].columns.is_empty() {
            if let Ok(stmt) = self.client.prepare(sql).await {
                for (meta, col) in sets[0].columns.iter_mut().zip(stmt.columns()) {
                    meta.type_name = Some(col.type_().name().to_string());
                }
                let refs: Vec<(u32, i16)> =
                    stmt.columns().iter().filter_map(|c| Some((c.table_oid()?, c.column_id()?))).collect();
                if !refs.is_empty() {
                    if let Ok(found) = self.sources(&refs).await {
                        for (meta, col) in sets[0].columns.iter_mut().zip(stmt.columns()) {
                            if let (Some(t), Some(a)) = (col.table_oid(), col.column_id()) {
                                meta.source = found.iter().find(|f| f.0 == t && f.1 == a).map(|f| f.2.clone());
                            }
                        }
                    }
                }
            }
        }
        Ok(sets)
    }

    /// Schema, table and column names for (table oid, column number) pairs.
    /// Only ordinary and partitioned tables count: views and the like are not edited.
    async fn sources(&self, refs: &[(u32, i16)]) -> Result<Vec<(u32, i16, ColumnSource)>> {
        let oids: Vec<u32> = refs.iter().map(|r| r.0).collect();
        let rows = self
            .client
            .query(
                "SELECT c.oid, a.attnum, n.nspname, c.relname, a.attname \
                 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE c.oid = ANY($1) AND a.attnum > 0 AND c.relkind IN ('r', 'p')",
                &[&oids],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| {
                let source = ColumnSource { schema: r.get(2), table: r.get(3), column: r.get(4) };
                (r.get::<_, u32>(0), r.get::<_, i16>(1), source)
            })
            .collect())
    }

    /// Save edited rows in one transaction. Each statement must change exactly one row.
    pub(crate) async fn apply(&self, edits: &[RowEdit]) -> Result<u64> {
        let mut sql = String::from("BEGIN;\n");
        for e in edits {
            sql += &update_sql(Engine::Postgres, e, Values::Inline)?.0;
            sql += ";\n";
        }
        let counts: Vec<u64> = match self.client.simple_query(&sql).await {
            Ok(msgs) => msgs
                .into_iter()
                .filter_map(|m| match m {
                    SimpleQueryMessage::CommandComplete(n) => Some(n),
                    _ => None,
                })
                .skip(1) // BEGIN
                .collect(),
            Err(e) => {
                let _ = self.client.simple_query("ROLLBACK").await;
                return Err(e.into());
            }
        };
        if let Some(i) = counts.iter().position(|&n| n != 1) {
            let _ = self.client.simple_query("ROLLBACK").await;
            return Err(not_one_row(&edits[i], counts[i]));
        }
        self.client.simple_query("COMMIT").await?;
        Ok(counts.len() as u64)
    }
}

pub(crate) fn not_one_row(e: &RowEdit, n: u64) -> Error {
    let key: Vec<String> =
        e.key.iter().map(|k| format!("{} = {}", k.column, k.value.as_deref().unwrap_or("NULL"))).collect();
    Error::Config(if n == 0 {
        format!(
            "Nothing was saved: the row in {} where {} no longer exists. Refresh and try again.",
            e.table,
            key.join(", ")
        )
    } else {
        format!("Nothing was saved: {n} rows in {} match {}, so the key is not unique.", e.table, key.join(", "))
    })
}
