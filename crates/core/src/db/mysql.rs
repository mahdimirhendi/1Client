use mysql_async::prelude::Queryable;
use mysql_async::{Conn, OptsBuilder, Row, SslOpts, Value};
use tokio::sync::Mutex;

use crate::db::postgres::not_one_row;
use crate::edit::{update_sql, RowEdit, Values};
use crate::error::chain;
use crate::{
    ColumnMeta, ColumnSource, ConnectionProfile, DbStage, Engine, Error, Result, ResultSet, SslMode, ROW_LIMIT,
};

/// One connection per session, so `USE`, variables and transactions behave as typed.
pub(crate) struct MyConn {
    conn: Mutex<Conn>,
}

pub(crate) async fn connect(
    profile: &ConnectionProfile,
    password: Option<&str>,
    addr: (&str, u16),
) -> Result<(MyConn, String)> {
    let base = OptsBuilder::default()
        .ip_or_hostname(addr.0)
        .tcp_port(addr.1)
        .prefer_socket(false)
        .user(Some(profile.user.clone()))
        .pass(password.map(str::to_owned))
        .db_name((!profile.database.is_empty()).then(|| profile.database.clone()));

    let tls = |verify: bool| {
        SslOpts::default().with_danger_accept_invalid_certs(!verify).with_danger_skip_domain_validation(!verify)
    };

    let conn = match profile.ssl_mode {
        SslMode::Disable => Conn::new(base).await.map_err(classify)?,
        SslMode::Require => Conn::new(base.ssl_opts(Some(tls(false)))).await.map_err(classify)?,
        SslMode::VerifyFull => Conn::new(base.ssl_opts(Some(tls(true)))).await.map_err(classify)?,
        SslMode::Prefer => match Conn::new(base.clone().ssl_opts(Some(tls(false)))).await {
            Ok(c) => c,
            Err(first) => {
                let first = classify(first);
                // The server answered and refused the sign-in: trying again without TLS would only
                // count a second failed login against the account.
                if matches!(first, Error::DbConnect { stage: DbStage::Auth | DbStage::Database, .. }) {
                    return Err(first);
                }
                match Conn::new(base).await {
                    Ok(c) => c,
                    // Report the TLS attempt's error unless the plain one is more specific.
                    Err(second) => {
                        let second = classify(second);
                        return Err(if matches!(first, Error::DbConnect { stage: DbStage::Tls, .. }) {
                            second
                        } else {
                            first
                        });
                    }
                }
            }
        },
    };

    let (major, minor, patch) = conn.server_version();
    let mut conn = conn;
    if profile.read_only {
        conn.query_drop("SET SESSION TRANSACTION READ ONLY").await?;
    }
    let flavor = if conn.server_version().0 >= 10 && is_mariadb(&mut conn).await { "MariaDB" } else { "MySQL" };
    Ok((MyConn { conn: Mutex::new(conn) }, format!("{flavor} {major}.{minor}.{patch}")))
}

/// Sort a connect error into the part of the connection that failed.
fn classify(e: mysql_async::Error) -> Error {
    match &e {
        mysql_async::Error::Server(s) => {
            let stage = match s.code {
                1049 | 1044 => DbStage::Database, // unknown database / no access to it
                _ => DbStage::Auth,               // 1045 access denied, 1130 host not allowed, …
            };
            Error::DbConnect { stage, message: s.message.clone() }
        }
        _ => {
            let message = chain(&e);
            let low = message.to_lowercase();
            let stage = if low.contains("tls") || low.contains("ssl") || low.contains("certificate") {
                DbStage::Tls
            } else {
                DbStage::Network
            };
            Error::DbConnect { stage, message }
        }
    }
}

async fn is_mariadb(conn: &mut Conn) -> bool {
    conn.query_first::<String, _>("SELECT VERSION()")
        .await
        .ok()
        .flatten()
        .is_some_and(|v| v.to_lowercase().contains("mariadb"))
}

impl MyConn {
    pub(crate) async fn ping(&self) -> Result<()> {
        Ok(self.conn.lock().await.ping().await?)
    }

    pub(crate) async fn run(&self, sql: &str) -> Result<Vec<ResultSet>> {
        let mut conn = self.conn.lock().await;
        let mut result = conn.query_iter(sql).await?;
        let mut sets = Vec::new();

        loop {
            let columns: Vec<ColumnMeta> = result
                .columns()
                .map(|cols| {
                    cols.iter()
                        .map(|c| ColumnMeta {
                            name: c.name_str().into_owned(),
                            type_name: Some(type_name(c.column_type())),
                            source: (!c.org_table_str().is_empty() && !c.org_name_str().is_empty()).then(|| {
                                ColumnSource {
                                    schema: c.schema_str().into_owned(),
                                    table: c.org_table_str().into_owned(),
                                    column: c.org_name_str().into_owned(),
                                }
                            }),
                        })
                        .collect()
                })
                .unwrap_or_default();

            // Rows are read one by one, so only the first `ROW_LIMIT` are kept in memory.
            let mut set = ResultSet::default();
            let mut total: u64 = 0;
            result
                .for_each(|row: Row| {
                    total += 1;
                    if set.rows.len() < ROW_LIMIT {
                        set.rows.push(row.unwrap().into_iter().map(text).collect());
                    } else {
                        set.truncated = true;
                    }
                })
                .await?;
            set.row_count = Some(if columns.is_empty() { result.affected_rows() } else { total });
            set.columns = columns;
            sets.push(set);

            if result.is_empty() {
                break;
            }
        }
        Ok(sets)
    }

    /// Save edited rows in one transaction. Each statement must change exactly one row.
    pub(crate) async fn apply(&self, edits: &[RowEdit]) -> Result<u64> {
        let mut conn = self.conn.lock().await;
        conn.query_drop("START TRANSACTION").await?;
        for e in edits {
            let step = async {
                let (sql, params) = update_sql(Engine::Mysql, e, Values::Params)?;
                let params: Vec<Value> = params.into_iter().map(|v| v.map_or(Value::NULL, Value::from)).collect();
                conn.exec_drop(sql, params).await?;
                // Rows matched, not rows changed: saving an unchanged value still counts.
                let matched = conn.info().split_whitespace().nth(2).and_then(|n| n.parse::<u64>().ok());
                let n = matched.unwrap_or(conn.affected_rows());
                if n != 1 {
                    return Err(not_one_row(e, n));
                }
                Ok::<_, Error>(())
            };
            if let Err(err) = step.await {
                let _ = conn.query_drop("ROLLBACK").await;
                return Err(err);
            }
        }
        conn.query_drop("COMMIT").await?;
        Ok(edits.len() as u64)
    }
}

/// `MYSQL_TYPE_VAR_STRING` -> `varchar`-ish short names for the grid header.
fn type_name(t: mysql_async::consts::ColumnType) -> String {
    let raw = format!("{t:?}");
    let s = raw.trim_start_matches("MYSQL_TYPE_").to_lowercase();
    match s.as_str() {
        "var_string" | "varchar" => "varchar".into(),
        "string" => "char".into(),
        "long" => "int".into(),
        "longlong" => "bigint".into(),
        "short" => "smallint".into(),
        "tiny" => "tinyint".into(),
        "int24" => "mediumint".into(),
        "newdecimal" => "decimal".into(),
        "blob" | "tiny_blob" | "medium_blob" | "long_blob" => "blob/text".into(),
        _ => s,
    }
}

fn text(v: Value) -> Option<String> {
    match v {
        Value::NULL => None,
        Value::Bytes(b) => Some(match String::from_utf8(b) {
            Ok(s) => s,
            Err(e) => {
                let bytes = e.into_bytes();
                let hex: String = bytes.iter().take(64).map(|b| format!("{b:02x}")).collect();
                format!("0x{hex}{}", if bytes.len() > 64 { "…" } else { "" })
            }
        }),
        Value::Int(i) => Some(i.to_string()),
        Value::UInt(u) => Some(u.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Double(d) => Some(d.to_string()),
        Value::Date(y, m, d, h, mi, s, us) => Some(if (h, mi, s, us) == (0, 0, 0, 0) {
            format!("{y:04}-{m:02}-{d:02}")
        } else {
            format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}{}", micros(us))
        }),
        Value::Time(neg, d, h, m, s, us) => {
            Some(format!("{}{:02}:{m:02}:{s:02}{}", if neg { "-" } else { "" }, d * 24 + u32::from(h), micros(us)))
        }
    }
}

/// Fractional seconds as MySQL prints them (`.123456`), or nothing for whole seconds.
fn micros(us: u32) -> String {
    if us == 0 {
        String::new()
    } else {
        format!(".{us:06}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_times_keep_fractional_seconds() {
        assert_eq!(text(Value::Date(2026, 3, 9, 0, 0, 0, 0)).as_deref(), Some("2026-03-09"));
        assert_eq!(text(Value::Date(2026, 3, 9, 14, 5, 7, 0)).as_deref(), Some("2026-03-09 14:05:07"));
        assert_eq!(text(Value::Date(2026, 3, 9, 14, 5, 7, 120)).as_deref(), Some("2026-03-09 14:05:07.000120"));
        assert_eq!(text(Value::Time(true, 1, 2, 3, 4, 500_000)).as_deref(), Some("-26:03:04.500000"));
        assert_eq!(text(Value::NULL), None);
    }
}
