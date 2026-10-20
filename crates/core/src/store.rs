//! Saved connections, kept as JSON in the app's config folder
//! (`~/Library/Application Support/app.oneclient.desktop/connections.json` on macOS).
//! No secrets are written here.

use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::{json_file, ConnectionProfile, Error, Result};

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct FileFormat {
    version: u32,
    connections: Vec<ConnectionProfile>,
}

pub struct ConnectionStore {
    path: PathBuf,
    profiles: Vec<ConnectionProfile>,
    problem: Option<String>,
}

impl ConnectionStore {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("connections.json");
        // A damaged file is kept aside and the app starts without it, saying so (`problem`).
        let (profiles, problem) = match json_file::read::<FileFormat>(&path) {
            Ok(f) => (f.map(|f| f.connections).unwrap_or_default(), None),
            Err(Error::Config(why)) => {
                let kept = json_file::set_aside(&path, &why)?;
                let problem = format!(
                    "Your saved connections could not be read, so 1Client started without them. The file was kept as {}.",
                    kept.display()
                );
                (Vec::new(), Some(problem))
            }
            Err(e) => return Err(e),
        };
        Ok(Self { path, profiles, problem })
    }

    /// Why the saved connections were not loaded, when their file was damaged.
    pub fn problem(&self) -> Option<&str> {
        self.problem.as_deref()
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
        assert_eq!(store.problem(), None);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_damaged_file_is_kept_aside_and_the_app_still_starts() {
        let dir = std::env::temp_dir().join(format!("oneclient-store-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("connections.json"), "{\"version\":1,\"connec").unwrap();
        let store = ConnectionStore::open(&dir).unwrap();
        assert!(store.list().is_empty());
        assert!(store.problem().unwrap().contains("connections.json.invalid"));
        assert!(dir.join("connections.json.invalid").exists() && !dir.join("connections.json").exists());
        std::fs::remove_dir_all(dir).ok();
    }
}
