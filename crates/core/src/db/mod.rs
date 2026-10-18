//! Database drivers. Both return results as text so the grid can show any type
//! exactly as the server prints it.

pub(crate) mod mysql;
pub(crate) mod postgres;

use crate::{ColumnInfo, Engine, ResultSet, TableInfo};

pub(crate) enum DbConn {
    Postgres(postgres::PgConn),
    Mysql(mysql::MyConn),
}

/// Columns of every user table and view, with key flags.
pub(crate) fn introspection_sql(engine: Engine) -> &'static str {
    match engine {
        Engine::Postgres => {
            r#"SELECT c.table_schema, c.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable,
       COALESCE(bool_or(tc.constraint_type = 'PRIMARY KEY'), false) AS pk,
       COALESCE(bool_or(tc.constraint_type = 'FOREIGN KEY'), false) AS fk,
       MAX(CASE WHEN tc.constraint_type = 'FOREIGN KEY'
                THEN ccu.table_schema || '.' || ccu.table_name || '.' || ccu.column_name END) AS ref
FROM information_schema.columns c
JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
LEFT JOIN information_schema.key_column_usage k
  ON k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name = c.column_name
LEFT JOIN information_schema.table_constraints tc
  ON tc.constraint_schema = k.constraint_schema AND tc.constraint_name = k.constraint_name
LEFT JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_type = 'FOREIGN KEY' AND ccu.constraint_schema = tc.constraint_schema
 AND ccu.constraint_name = tc.constraint_name
WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema NOT LIKE 'pg_toast%'
GROUP BY c.table_schema, c.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable, c.ordinal_position
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
