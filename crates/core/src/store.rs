//! Saved connections, kept as JSON in the app's config folder
//! (`~/Library/Application Support/app.oneclient.desktop/connections.json` on macOS).
//! No secrets are written here.

use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::{json_file, ConnectionProfile, Result};

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct FileFormat {
    version: u32,
    connections: Vec<ConnectionProfile>,
}

pub struct ConnectionStore {
    path: PathBuf,
    profiles: Vec<ConnectionProfile>,
}

impl ConnectionStore {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("connections.json");
        let profiles = json_file::read::<FileFormat>(&path)?.map(|f| f.connections).unwrap_or_default();
        Ok(Self { path, profiles })
    }

    pub fn list(&self) -> &[ConnectionProfile] {
        &self.profiles
    }

    pub fn get(&self, id: Uuid) -> Option<&ConnectionProfile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    pub fn upsert(&mut self, profile: ConnectionProfile) -> Result<()> {
        match self.profiles.iter_mut().find(|p| p.id == profile.id) {
            Some(slot) => *slot = profile,
            None => self.profiles.push(profile),
        }
        self.flush()
    }

    pub fn remove(&mut self, id: Uuid) -> Result<Option<ConnectionProfile>> {
        let idx = self.profiles.iter().position(|p| p.id == id);
        let removed = idx.map(|i| self.profiles.remove(i));
        self.flush()?;
        Ok(removed)
    }

    /// Move connections whose environment no longer exists to `fallback`.
    pub fn reassign_environments(&mut self, known: &[String], fallback: &str) -> Result<()> {
        let mut changed = false;
        for p in &mut self.profiles {
            if !known.contains(&p.environment) {
                p.environment = fallback.to_string();
                changed = true;
            }
        }
        if changed {
            self.flush()?;
        }
        Ok(())
    }

    pub fn touch(&mut self, id: Uuid) -> Result<()> {
        let now =
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default();
        if let Some(p) = self.profiles.iter_mut().find(|p| p.id == id) {
            p.last_used_at = Some(now);
        }
        self.flush()
    }

    fn flush(&self) -> Result<()> {
        json_file::write(&self.path, &FileFormat { version: 1, connections: self.profiles.clone() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_files_with_a_storage_choice_still_load() {
        let dir = std::env::temp_dir().join(format!("oneclient-store-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // Files from earlier versions carry a "secretStorage" field; it is ignored now.
        std::fs::write(
            dir.join("connections.json"),
            r#"{"version":1,"connections":[{"id":"11111111-1111-4111-8111-111111111111","name":"old","engine":"postgres","host":"h","port":5432,"user":"u","secretStorage":"keychain"}]}"#,
        )
        .unwrap();
        let store = ConnectionStore::open(&dir).unwrap();
        assert_eq!(store.list()[0].name, "old");
        std::fs::remove_dir_all(dir).ok();
    }
}
