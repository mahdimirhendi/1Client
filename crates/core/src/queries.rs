//! Query history and saved queries, per connection, kept as JSON next to the connections
//! (`history.json` and `saved_queries.json`).
//!
//! The history only holds what the user ran from a query tab. Running the same SQL again moves it
//! to the top instead of adding a copy, and each connection keeps its latest `HISTORY_LIMIT` runs.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{json_file, Error, QueryOutput, Result};

/// Runs kept per connection; older ones are dropped.
pub const HISTORY_LIMIT: usize = 500;
/// Longer SQL (a pasted dump, a huge INSERT) is run but not kept in the history.
pub const HISTORY_MAX_SQL: usize = 100_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: Uuid,
    pub profile_id: Uuid,
    pub sql: String,
    /// Unix time in milliseconds.
    pub ran_at: u64,
    pub elapsed_ms: u64,
    /// Rows returned or changed by the last statement, when it succeeded.
    pub rows: Option<u64>,
    /// What went wrong, when it failed.
    pub error: Option<String>,
}

impl HistoryEntry {
    /// The entry for a run that just finished.
    pub fn of_run(profile_id: Uuid, sql: &str, elapsed_ms: u64, result: &Result<QueryOutput>) -> Self {
        Self {
            id: Uuid::new_v4(),
            profile_id,
            sql: sql.to_string(),
            ran_at: now_ms(),
            elapsed_ms,
            rows: result.as_ref().ok().and_then(|o| o.sets.last()).and_then(|s| s.row_count),
            error: result.as_ref().err().map(ToString::to_string),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: Uuid,
    pub profile_id: Uuid,
    pub name: String,
    pub sql: String,
    /// Unix time in milliseconds of the last save.
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct HistoryFile {
    version: u32,
    history: Vec<HistoryEntry>,
}

#[derive(Serialize, Deserialize, Default)]
struct SavedFile {
    version: u32,
    queries: Vec<SavedQuery>,
}

pub struct QueryStore {
    history_path: PathBuf,
    saved_path: PathBuf,
    /// Oldest first.
    history: Vec<HistoryEntry>,
    saved: Vec<SavedQuery>,
}

/// Unix time in milliseconds.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or_default()
}

impl QueryStore {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let history_path = dir.join("history.json");
        let saved_path = dir.join("saved_queries.json");
        let history = json_file::read_or_set_aside::<HistoryFile>(&history_path)?.unwrap_or_default().history;
        let saved = json_file::read_or_set_aside::<SavedFile>(&saved_path)?.unwrap_or_default().queries;
        Ok(Self { history_path, saved_path, history, saved })
    }

    /// A connection's history, newest first.
    pub fn history(&self, profile_id: Uuid) -> Vec<HistoryEntry> {
        self.history.iter().rev().filter(|e| e.profile_id == profile_id).cloned().collect()
    }

    /// Keep a run. The same SQL run again replaces its older entry, so it moves to the top.
    pub fn record(&mut self, entry: HistoryEntry) -> Result<()> {
        if entry.sql.trim().is_empty() || entry.sql.len() > HISTORY_MAX_SQL {
            return Ok(());
        }
        self.history.retain(|e| !(e.profile_id == entry.profile_id && e.sql == entry.sql));
        let profile_id = entry.profile_id;
        self.history.push(entry);
        let mine = self.history.iter().filter(|e| e.profile_id == profile_id).count();
        if mine > HISTORY_LIMIT {
            let mut drop = mine - HISTORY_LIMIT;
            self.history.retain(|e| {
                let old = drop > 0 && e.profile_id == profile_id;
                if old {
                    drop -= 1;
                }
                !old
            });
        }
        self.flush_history()
    }

    pub fn delete_history(&mut self, id: Uuid) -> Result<()> {
        self.history.retain(|e| e.id != id);
        self.flush_history()
    }

    pub fn clear_history(&mut self, profile_id: Uuid) -> Result<()> {
        self.history.retain(|e| e.profile_id != profile_id);
        self.flush_history()
    }

    /// A connection's saved queries, by name.
    pub fn saved(&self, profile_id: Uuid) -> Vec<SavedQuery> {
        let mut list: Vec<SavedQuery> = self.saved.iter().filter(|q| q.profile_id == profile_id).cloned().collect();
        list.sort_by_key(|q| q.name.to_lowercase());
        list
    }

    /// Add a saved query, or update the one with the same id.
    pub fn save(&mut self, mut query: SavedQuery) -> Result<SavedQuery> {
        query.name = query.name.trim().to_string();
        if query.name.is_empty() {
            return Err(Error::Config("Give the query a name".into()));
        }
        if query.sql.trim().is_empty() {
            return Err(Error::Config("There is no SQL to save".into()));
        }
        query.updated_at = now_ms();
        match self.saved.iter_mut().find(|q| q.id == query.id) {
            Some(slot) => *slot = query.clone(),
            None => self.saved.push(query.clone()),
        }
        self.flush_saved()?;
        Ok(query)
    }

    pub fn delete_saved(&mut self, id: Uuid) -> Result<()> {
        self.saved.retain(|q| q.id != id);
        self.flush_saved()
    }

    /// Remove the history and saved queries of a deleted connection.
    pub fn forget(&mut self, profile_id: Uuid) -> Result<()> {
        self.history.retain(|e| e.profile_id != profile_id);
        self.saved.retain(|q| q.profile_id != profile_id);
        self.flush_history()?;
        self.flush_saved()
    }

    fn flush_history(&self) -> Result<()> {
        json_file::write(&self.history_path, &HistoryFile { version: 1, history: self.history.clone() })
    }

    fn flush_saved(&self) -> Result<()> {
        json_file::write(&self.saved_path, &SavedFile { version: 1, queries: self.saved.clone() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("oneclient-queries-{}", Uuid::new_v4()))
    }

    fn run(profile_id: Uuid, sql: &str) -> HistoryEntry {
        HistoryEntry::of_run(profile_id, sql, 3, &Ok(QueryOutput { sets: vec![], elapsed_ms: 3 }))
    }

    #[test]
    fn an_entry_keeps_rows_or_the_error() {
        let p = Uuid::new_v4();
        let set = crate::ResultSet { row_count: Some(24), ..Default::default() };
        let ok = HistoryEntry::of_run(p, "SELECT 1", 5, &Ok(QueryOutput { sets: vec![set], elapsed_ms: 5 }));
        assert_eq!((ok.rows, ok.error), (Some(24), None));
        let failed = HistoryEntry::of_run(p, "SELEC 1", 2, &Err(Error::Config("syntax error".into())));
        assert_eq!((failed.rows, failed.error.as_deref()), (None, Some("syntax error")));
    }

    #[test]
    fn history_is_per_connection_newest_first_without_repeats() {
        let dir = temp_dir();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut store = QueryStore::open(&dir).unwrap();
        store.record(run(a, "SELECT 1")).unwrap();
        store.record(run(a, "SELECT 2")).unwrap();
        store.record(run(b, "SELECT 1")).unwrap();
        store.record(run(a, "SELECT 1")).unwrap(); // again: moves to the top
        store.record(run(a, "   ")).unwrap(); // nothing to keep

        let sqls = |p| QueryStore::open(&dir).unwrap().history(p).into_iter().map(|e| e.sql).collect::<Vec<_>>();
        assert_eq!(sqls(a), ["SELECT 1", "SELECT 2"]);
        assert_eq!(sqls(b), ["SELECT 1"]);

        store.clear_history(a).unwrap();
        assert!(sqls(a).is_empty());
        assert_eq!(sqls(b), ["SELECT 1"]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn history_keeps_the_latest_runs_of_each_connection() {
        let dir = temp_dir();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut store = QueryStore::open(&dir).unwrap();
        store.record(run(b, "SELECT 'other'")).unwrap();
        for i in 0..HISTORY_LIMIT + 3 {
            store.record(run(a, &format!("SELECT {i}"))).unwrap();
        }
        let h = store.history(a);
        assert_eq!(h.len(), HISTORY_LIMIT);
        assert_eq!(h[0].sql, format!("SELECT {}", HISTORY_LIMIT + 2));
        assert_eq!(h[HISTORY_LIMIT - 1].sql, "SELECT 3");
        assert_eq!(store.history(b).len(), 1, "other connections are not trimmed");

        store.record(run(a, &"x".repeat(HISTORY_MAX_SQL + 1))).unwrap();
        assert_eq!(store.history(a)[0].sql, format!("SELECT {}", HISTORY_LIMIT + 2), "huge SQL is not kept");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn saved_queries_are_added_updated_and_removed() {
        let dir = temp_dir();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut store = QueryStore::open(&dir).unwrap();
        let q = |name: &str| SavedQuery {
            id: Uuid::new_v4(),
            profile_id: a,
            name: name.into(),
            sql: "SELECT 1".into(),
            updated_at: 0,
        };

        let top = store.save(q("  top customers ")).unwrap();
        assert_eq!(top.name, "top customers");
        assert!(top.updated_at > 0);
        store.save(q("Active orders")).unwrap();
        store.save(SavedQuery { profile_id: b, ..q("elsewhere") }).unwrap();
        store.save(SavedQuery { sql: "SELECT 2".into(), ..top.clone() }).unwrap();

        let again = QueryStore::open(&dir).unwrap();
        let names: Vec<_> = again.saved(a).into_iter().map(|q| (q.name, q.sql)).collect();
        assert_eq!(names, [("Active orders".into(), "SELECT 1".into()), ("top customers".into(), "SELECT 2".into())]);
        assert!(store.save(q("  ")).is_err());
        assert!(store.save(SavedQuery { sql: " ".into(), ..q("empty") }).is_err());

        store.delete_saved(top.id).unwrap();
        store.record(run(a, "SELECT 1")).unwrap();
        store.forget(a).unwrap();
        let after = QueryStore::open(&dir).unwrap();
        assert!(after.saved(a).is_empty() && after.history(a).is_empty());
        assert_eq!(after.saved(b).len(), 1);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_damaged_file_is_moved_aside() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("saved_queries.json"), "{ not json").unwrap();
        let store = QueryStore::open(&dir).unwrap();
        assert!(store.saved(Uuid::new_v4()).is_empty());
        assert!(dir.join("saved_queries.json.invalid").exists());
        std::fs::remove_dir_all(dir).ok();
    }
}
