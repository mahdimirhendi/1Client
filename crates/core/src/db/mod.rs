//! Database drivers. Both return results as text so the grid can show any type
//! exactly as the server prints it.

pub(crate) mod mysql;
pub(crate) mod postgres;

use crate::edit::RowEdit;
use crate::{ColumnInfo, Engine, Result, ResultSet, TableInfo};

pub(crate) enum DbConn {
    Postgres(postgres::PgConn),
    Mysql(mysql::MyConn),
}

impl DbConn {
    pub(crate) async fn run(&self, sql: &str) -> Result<Vec<ResultSet>> {
        match self {
            DbConn::Postgres(c) => c.run(sql).await,
            DbConn::Mysql(c) => c.run(sql).await,
        }
    }

    pub(crate) async fn apply(&self, edits: &[RowEdit]) -> Result<u64> {
        match self {
            DbConn::Postgres(c) => c.apply(edits).await,
            DbConn::Mysql(c) => c.apply(edits).await,
        }
    }

    /// The driver already knows the connection is gone (MySQL only finds out when it is used).
    pub(crate) fn is_closed(&self) -> bool {
        match self {
            DbConn::Postgres(c) => c.is_closed(),
            DbConn::Mysql(_) => false,
        }
    }

    /// The cheapest round trip to the server.
    pub(crate) async fn ping(&self) -> Result<()> {
        match self {
            DbConn::Postgres(c) => c.ping().await,
            DbConn::Mysql(c) => c.ping().await,
        }
    }
}

/// The databases this user can open, system ones left out.
pub(crate) fn databases_sql(engine: Engine) -> &'static str {
    match engine {
        Engine::Postgres => {
            "SELECT datname FROM pg_database \
             WHERE datallowconn AND NOT datistemplate AND has_database_privilege(datname, 'CONNECT') \
             ORDER BY datname"
        }
        // SCHEMATA lists only the databases the user has some privilege on.
        Engine::Mysql => {
            "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA \
             WHERE SCHEMA_NAME NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys') \
             ORDER BY SCHEMA_NAME"
        }
    }
}

/// The database the connection is in (MySQL: NULL when none is chosen).
pub(crate) fn current_database_sql(engine: Engine) -> &'static str {
    match engine {
        Engine::Postgres => "SELECT current_database()",
        Engine::Mysql => "SELECT DATABASE()",
    }
}

/// Columns of every user table and view, with key flags.
pub(crate) fn introspection_sql(engine: Engine) -> &'static str {
    match engine {
        // Keys come from pg_constraint: it pairs each column of a composite foreign key with the
        // column it references, and ties constraints to their table (two tables in a schema may
        // have foreign keys of the same name).
        Engine::Postgres => {
            r#"SELECT c.table_schema, c.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable,
       EXISTS (SELECT 1 FROM pg_constraint p
               WHERE p.contype = 'p' AND p.conrelid = cls.oid AND a.attnum = ANY (p.conkey)) AS pk,
       fk.ref IS NOT NULL AS fk,
       fk.ref
FROM information_schema.columns c
JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
JOIN pg_namespace ns ON ns.nspname = c.table_schema
JOIN pg_class cls ON cls.relnamespace = ns.oid AND cls.relname = c.table_name
JOIN pg_attribute a ON a.attrelid = cls.oid AND a.attname = c.column_name
LEFT JOIN LATERAL (
  SELECT rn.nspname || '.' || rc.relname || '.' || ra.attname AS ref
  FROM pg_constraint f
  CROSS JOIN LATERAL unnest(f.conkey, f.confkey) AS u(src, dst)
  JOIN pg_class rc ON rc.oid = f.confrelid
  JOIN pg_namespace rn ON rn.oid = rc.relnamespace
  JOIN pg_attribute ra ON ra.attrelid = f.confrelid AND ra.attnum = u.dst
  WHERE f.contype = 'f' AND f.conrelid = cls.oid AND u.src = a.attnum
  ORDER BY f.conname
  LIMIT 1
) fk ON true
WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema NOT LIKE 'pg_toast%'
ORDER BY c.table_schema, c.table_name, c.ordinal_position"#
        }
        Engine::Mysql => {
            r#"SELECT c.TABLE_SCHEMA AS table_schema, c.TABLE_NAME AS table_name, t.TABLE_TYPE AS table_type,
       c.COLUMN_NAME AS column_name, c.COLUMN_TYPE AS data_type, c.IS_NULLABLE AS is_nullable,
       c.COLUMN_KEY = 'PRI' AS pk,
       EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k
               WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME
                 AND k.COLUMN_NAME = c.COLUMN_NAME AND k.REFERENCED_TABLE_NAME IS NOT NULL) AS fk,
       (SELECT CONCAT(k.REFERENCED_TABLE_SCHEMA, '.', k.REFERENCED_TABLE_NAME, '.', k.REFERENCED_COLUMN_NAME)
          FROM information_schema.KEY_COLUMN_USAGE k
         WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME
           AND k.COLUMN_NAME = c.COLUMN_NAME AND k.REFERENCED_TABLE_NAME IS NOT NULL LIMIT 1) AS ref
FROM information_schema.COLUMNS c
JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
WHERE c.TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION"#
        }
    }
}

/// Fold the flat introspection rows into tables.
pub(crate) fn fold_tables(set: &ResultSet) -> Vec<TableInfo> {
    let truthy = |v: &Option<String>| matches!(v.as_deref(), Some("t" | "true" | "1" | "YES"));
    let text = |v: &Option<String>| v.clone().unwrap_or_default();
    let mut out: Vec<TableInfo> = Vec::new();
    for row in &set.rows {
        if row.len() < 8 {
            continue;
        }
        let (schema, name) = (text(&row[0]), text(&row[1]));
        let kind = if text(&row[2]).to_uppercase().contains("VIEW") { "view" } else { "table" };
        let col = ColumnInfo {
            name: text(&row[3]),
            data_type: text(&row[4]),
            nullable: truthy(&row[5]),
            primary_key: truthy(&row[6]),
            foreign_key: truthy(&row[7]),
            references: row.get(8).cloned().flatten().filter(|r| !r.is_empty()),
        };
        match out.last_mut() {
            Some(t) if t.schema == schema && t.name == name => t.columns.push(col),
            _ => out.push(TableInfo { schema, name, kind: kind.into(), columns: vec![col] }),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_rows_into_tables() {
        let r = |v: [&str; 8]| v.iter().map(|s| Some(s.to_string())).collect::<Vec<_>>();
        let set = ResultSet {
            rows: vec![
                r(["public", "orders", "BASE TABLE", "id", "bigint", "NO", "t", "f"]),
                r(["public", "orders", "BASE TABLE", "customer_id", "bigint", "YES", "f", "t"]),
                r(["shop", "v_sales", "VIEW", "total", "decimal(12,2)", "YES", "0", "0"]),
            ],
            ..Default::default()
        };
        let t = fold_tables(&set);
        assert_eq!(t.len(), 2);
        assert!(t[0].columns[0].primary_key && !t[0].columns[0].nullable);
        assert!(t[0].columns[1].foreign_key);
        assert_eq!(t[1].kind, "view");
    }
}
