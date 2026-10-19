//! The user's environment tags, kept in `environments.json` next to the connections.

use std::path::{Path, PathBuf};

use crate::{default_environments, json_file, EnvironmentDef, Error, Result};

pub struct EnvironmentStore {
    path: PathBuf,
    list: Vec<EnvironmentDef>,
}

impl EnvironmentStore {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("environments.json");
        let list: Vec<EnvironmentDef> = json_file::read(&path)?.unwrap_or_default();
        // The app always needs at least one environment (see `fallback_id`).
        let list = if list.is_empty() { default_environments() } else { list };
        Ok(Self { path, list })
    }

    pub fn list(&self) -> &[EnvironmentDef] {
        &self.list
    }

    /// Replace the whole list (order matters: it is the order shown in the app).
    pub fn save(&mut self, list: Vec<EnvironmentDef>) -> Result<()> {
        if list.is_empty() {
            return Err(Error::Config("Keep at least one environment".into()));
        }
        for e in &list {
            if e.name.trim().is_empty() {
                return Err(Error::Config("Every environment needs a name".into()));
            }
            let hex = e.color.strip_prefix('#').unwrap_or("");
            if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(Error::Config(format!("“{}” has an invalid color", e.name)));
            }
        }
        let mut ids: Vec<&str> = list.iter().map(|e| e.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        if ids.len() != list.len() {
            return Err(Error::Config("Two environments share the same id".into()));
        }
        json_file::write(&self.path, &list)?;
        self.list = list;
        Ok(())
    }

    /// Where connections go when their environment is removed.
    pub fn fallback_id(&self) -> String {
        self.list.iter().find(|e| e.id == "local").unwrap_or(&self.list[0]).id.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_then_custom() {
        let dir = std::env::temp_dir().join(format!("oneclient-env-{}", uuid::Uuid::new_v4()));
        let mut s = EnvironmentStore::open(&dir).unwrap();
        assert_eq!(s.list().len(), 3);
        let mut list = s.list().to_vec();
        list.push(EnvironmentDef {
            id: "qa".into(),
            name: "QA".into(),
            color: "#12A594".into(),
            confirm_writes: false,
        });
        s.save(list).unwrap();
        assert_eq!(EnvironmentStore::open(&dir).unwrap().list()[3].name, "QA");

        let bad = vec![EnvironmentDef { id: "x".into(), name: "X".into(), color: "red".into(), confirm_writes: false }];
        assert!(s.save(bad).is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn an_empty_file_falls_back_to_the_defaults() {
        let dir = std::env::temp_dir().join(format!("oneclient-env-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("environments.json"), "[]").unwrap();
        let s = EnvironmentStore::open(&dir).unwrap();
        assert_eq!(s.list().len(), 3);
        assert_eq!(s.fallback_id(), "local");
        std::fs::remove_dir_all(dir).ok();
    }
}
