//! Saving cells edited in the results grid.
//!
//! Each edited row becomes one `UPDATE <table> SET ... WHERE <primary key> = ...`.
//! All rows are saved in one transaction, and each statement must change exactly one row,
//! otherwise nothing is saved (the row was changed or deleted by someone else meanwhile).

use serde::{Deserialize, Serialize};

use crate::{Engine, Error, Result};

/// One column and its value. `None` is SQL NULL.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellValue {
    pub column: String,
    pub value: Option<String>,
}

/// New values for one row, found by its primary key.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowEdit {
    pub schema: String,
    pub table: String,
    /// Primary key columns with the row's current values.
    pub key: Vec<CellValue>,
    /// Columns to change.
    pub values: Vec<CellValue>,
}

pub fn quote_ident(engine: Engine, name: &str) -> String {
    match engine {
        Engine::Postgres => format!("\"{}\"", name.replace('"', "\"\"")),
        Engine::Mysql => format!("`{}`", name.replace('`', "``")),
    }
}

/// A string literal that is safe whatever the server settings are.
fn literal(engine: Engine, v: &Option<String>) -> String {
    match v {
        None => "NULL".into(),
        // E'' strings always treat backslash as an escape, so doubling both is always correct.
        Some(s) if engine == Engine::Postgres && s.contains('\\') => {
            format!("E'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
        }
        Some(s) if engine == Engine::Postgres => format!("'{}'", s.replace('\'', "''")),
        // MySQL: shown in the preview only; saving uses parameters.
        Some(s) => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'")),
    }
}

/// How values go into the statement.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Values {
    /// Inline literals (Postgres saving, and the preview for both engines).
    Inline,
    /// `?` placeholders with the values returned separately (MySQL saving).
    Params,
}

pub(crate) fn update_sql(engine: Engine, e: &RowEdit, mode: Values) -> Result<(String, Vec<Option<String>>)> {
    if e.values.is_empty() {
        return Err(Error::Config("Nothing to save for this row".into()));
    }
    if e.key.is_empty() || e.key.iter().any(|k| k.value.is_none()) {
        return Err(Error::Config(format!("{} has no primary key value for this row, so it can't be edited", e.table)));
    }
    let q = |n: &str| quote_ident(engine, n);
    let mut params = Vec::new();
    let mut val = |v: &Option<String>| match mode {
        Values::Inline => literal(engine, v),
        Values::Params => {
            params.push(v.clone());
            "?".into()
        }
    };
    let set: Vec<String> = e.values.iter().map(|c| format!("{} = {}", q(&c.column), val(&c.value))).collect();
    let cond: Vec<String> = e.key.iter().map(|c| format!("{} = {}", q(&c.column), val(&c.value))).collect();
    let table = if e.schema.is_empty() { q(&e.table) } else { format!("{}.{}", q(&e.schema), q(&e.table)) };
    Ok((format!("UPDATE {table} SET {} WHERE {}", set.join(", "), cond.join(" AND ")), params))
}

/// The statements that saving would run, for the confirmation dialog.
pub fn preview(engine: Engine, edits: &[RowEdit]) -> Result<String> {
    let mut out = Vec::new();
    for e in edits {
        out.push(update_sql(engine, e, Values::Inline)?.0 + ";");
    }
    Ok(out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(v: &str) -> RowEdit {
        RowEdit {
            schema: "public".into(),
            table: "users".into(),
            key: vec![CellValue { column: "id".into(), value: Some("7".into()) }],
            values: vec![
                CellValue { column: "lang".into(), value: Some(v.into()) },
                CellValue { column: "note".into(), value: None },
            ],
        }
    }

    #[test]
    fn postgres_quotes_values_and_names() {
        let (sql, p) = update_sql(Engine::Postgres, &edit("it's"), Values::Inline).unwrap();
        assert_eq!(sql, r#"UPDATE "public"."users" SET "lang" = 'it''s', "note" = NULL WHERE "id" = '7'"#);
        assert!(p.is_empty());
        let (sql, _) = update_sql(Engine::Postgres, &edit(r"a\'b"), Values::Inline).unwrap();
        assert!(sql.contains(r#""lang" = E'a\\''b'"#), "{sql}");
    }

    #[test]
    fn mysql_uses_parameters() {
        let (sql, p) = update_sql(Engine::Mysql, &edit("en"), Values::Params).unwrap();
        assert_eq!(sql, "UPDATE `public`.`users` SET `lang` = ?, `note` = ? WHERE `id` = ?");
        assert_eq!(p, vec![Some("en".into()), None, Some("7".into())]);
    }

    #[test]
    fn needs_a_key() {
        let mut e = edit("x");
        e.key.clear();
        assert!(update_sql(Engine::Postgres, &e, Values::Inline).is_err());
    }
}
