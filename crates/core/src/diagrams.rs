//! Diagram canvases, per connection, in `diagrams/<connection id>.json` in the app's data folder.
//!
//! A canvas keeps only what the user chose and arranged: which tables it is about (its scope),
//! where each table sits, what is hidden, the notes and the zoom. It never holds a copy of the
//! schema: the UI rebuilds every canvas from the live database each time it shows it. `seen` keeps
//! the table and column names the user last acknowledged, so the UI can say what changed since.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::queries::now_ms;
use crate::{json_file, Error, Result};

pub const MIN_ZOOM: f64 = 0.1;
pub const MAX_ZOOM: f64 = 2.0;

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Which tables a canvas is about. Tables are named `schema.table`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Scope {
    /// Every table, now and later.
    All,
    /// Tables whose name matches one of the patterns (`legal_*`, `*_audit`, `mart.*`).
    Pattern { patterns: Vec<String> },
    /// The tables the user put on the canvas, nothing else.
    Picked,
    /// A table and the tables up to `depth` foreign-key links away from it.
    Neighbours { root: String, depth: u8 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub x: f64,
    pub y: f64,
    /// Width; the height follows the text.
    pub w: f64,
    #[serde(default)]
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Canvas {
    pub id: Uuid,
    pub name: String,
    pub scope: Scope,
    /// Put tables that are new in the database and in scope on the canvas by themselves.
    #[serde(default)]
    pub auto_add: bool,
    #[serde(default = "default_zoom")]
    pub zoom: f64,
    /// Canvas point shown at the top left of the view.
    #[serde(default)]
    pub pan: Point,
    /// Where each table sits, by `schema.table`. A table is on the canvas when it has a position.
    #[serde(default)]
    pub positions: BTreeMap<String, Point>,
    /// Tables on the canvas but hidden. They keep their position for when they are shown again.
    #[serde(default)]
    pub hidden_tables: Vec<String>,
    /// Hidden columns, by `schema.table`.
    #[serde(default)]
    pub hidden_columns: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub notes: Vec<Note>,
    /// Column names of each table, by `schema.table`, as the user last acknowledged them.
    #[serde(default)]
    pub seen: BTreeMap<String, Vec<String>>,
    /// Unix time in milliseconds.
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

fn default_zoom() -> f64 {
    1.0
}

impl Canvas {
    /// Clean up what the UI sent, or say what is wrong with it.
    fn validated(mut self) -> Result<Self> {
        self.name = self.name.trim().to_string();
        if self.name.is_empty() {
            return Err(Error::Config("Give the canvas a name".into()));
        }
        match &mut self.scope {
            Scope::Pattern { patterns } => {
                patterns.iter_mut().for_each(|p| *p = p.trim().to_string());
                patterns.retain(|p| !p.is_empty());
                if patterns.is_empty() {
                    return Err(Error::Config("Enter a table name pattern, for example legal_*".into()));
                }
            }
            Scope::Neighbours { root, depth } => {
                if root.trim().is_empty() {
                    return Err(Error::Config("Pick the table to start from".into()));
                }
                if !(1..=2).contains(depth) {
                    return Err(Error::Config("Neighbours can be 1 or 2 links away".into()));
                }
            }
            Scope::Picked => self.auto_add = false,
            Scope::All => {}
        }
        if !self.zoom.is_finite() {
            self.zoom = default_zoom();
        }
        self.zoom = self.zoom.clamp(MIN_ZOOM, MAX_ZOOM);
        Ok(self)
    }
}

#[derive(Serialize, Deserialize, Default)]
struct FileFormat {
    version: u32,
    canvases: Vec<Canvas>,
}

pub struct DiagramStore {
    dir: PathBuf,
}

impl DiagramStore {
    /// `dir` is the app's data folder; canvases go in its `diagrams` folder.
    pub fn open(dir: &Path) -> Result<Self> {
        let dir = dir.join("diagrams");
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    fn path(&self, profile_id: Uuid) -> PathBuf {
        self.dir.join(format!("{profile_id}.json"))
    }

    /// A connection's canvases in the order they were made, or `None` when it never had any
    /// (the UI then starts one for the whole database).
    pub fn list(&self, profile_id: Uuid) -> Result<Option<Vec<Canvas>>> {
        Ok(json_file::read_or_set_aside::<FileFormat>(&self.path(profile_id))?.map(|f| f.canvases))
    }

    /// Add a canvas, or replace the one with the same id. Returns it as saved.
    pub fn save(&self, profile_id: Uuid, canvas: Canvas) -> Result<Canvas> {
        let mut canvas = canvas.validated()?;
        let mut list = self.list(profile_id)?.unwrap_or_default();
        let now = now_ms();
        canvas.updated_at = now;
        match list.iter_mut().find(|c| c.id == canvas.id) {
            Some(slot) => {
                canvas.created_at = slot.created_at;
                *slot = canvas.clone();
            }
            None => {
                canvas.created_at = now;
                list.push(canvas.clone());
            }
        }
        self.write(profile_id, list)?;
        Ok(canvas)
    }

    pub fn delete(&self, profile_id: Uuid, id: Uuid) -> Result<()> {
        let Some(mut list) = self.list(profile_id)? else { return Ok(()) };
        list.retain(|c| c.id != id);
        // An empty file (rather than none) remembers that the canvases were deleted on purpose.
        self.write(profile_id, list)
    }

    /// Remove the canvases of a deleted connection.
    pub fn forget(&self, profile_id: Uuid) -> Result<()> {
        let path = self.path(profile_id);
        for p in [path.with_extension("json.invalid"), path] {
            if let Err(e) = std::fs::remove_file(&p) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(e.into());
                }
            }
        }
        Ok(())
    }

    fn write(&self, profile_id: Uuid, canvases: Vec<Canvas>) -> Result<()> {
        json_file::write(&self.path(profile_id), &FileFormat { version: 1, canvases })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("oneclient-diagrams-{}", Uuid::new_v4()))
    }

    fn canvas(name: &str, scope: Scope) -> Canvas {
        Canvas {
            id: Uuid::new_v4(),
            name: name.into(),
            scope,
            auto_add: true,
            zoom: 0.75,
            pan: Point { x: -40.0, y: 12.5 },
            positions: BTreeMap::from([
                ("public.orders".into(), Point { x: 340.0, y: 70.0 }),
                ("mart.orders".into(), Point { x: 40.0, y: 330.0 }),
            ]),
            hidden_tables: vec!["mart.orders".into()],
            hidden_columns: BTreeMap::from([("public.orders".into(), vec!["note".into()])]),
            notes: vec![Note { id: "n1".into(), x: 640.0, y: 290.0, w: 210.0, text: "Refunds → status".into() }],
            seen: BTreeMap::from([("public.orders".into(), vec!["id".into(), "note".into()])]),
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn canvases_round_trip_per_connection() {
        let dir = temp_dir();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let store = DiagramStore::open(&dir).unwrap();
        let whole = store.save(a, canvas(" Whole database ", Scope::All)).unwrap();
        let pattern = Scope::Pattern { patterns: vec!["legal_*".into(), " ".into()] };
        let legal = store.save(a, canvas("Legal", pattern)).unwrap();
        store.save(b, canvas("Elsewhere", Scope::Picked)).unwrap();
        assert_eq!(whole.name, "Whole database");
        assert!(whole.created_at > 0 && whole.updated_at >= whole.created_at);
        assert_eq!(legal.scope, Scope::Pattern { patterns: vec!["legal_*".into()] });

        let again = DiagramStore::open(&dir).unwrap();
        let list = again.list(a).unwrap().unwrap();
        assert_eq!(list, [whole.clone(), legal.clone()], "everything comes back, in the order made");
        let picked = &again.list(b).unwrap().unwrap()[0];
        assert!(!picked.auto_add, "picked tables never grow by themselves");

        // Updating keeps the creation time and the place in the list.
        let moved = Canvas { name: "Everything".into(), ..whole.clone() };
        let saved = again.save(a, moved).unwrap();
        assert_eq!(saved.created_at, whole.created_at);
        let names: Vec<_> = again.list(a).unwrap().unwrap().into_iter().map(|c| c.name).collect();
        assert_eq!(names, ["Everything", "Legal"]);

        again.delete(a, legal.id).unwrap();
        again.delete(a, whole.id).unwrap();
        assert_eq!(again.list(a).unwrap(), Some(vec![]), "deleting them all is not the same as never having any");

        again.forget(b).unwrap();
        assert_eq!(again.list(b).unwrap(), None);
        again.forget(b).unwrap();
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_missing_empty_or_damaged_file_starts_fresh() {
        let dir = temp_dir();
        let store = DiagramStore::open(&dir).unwrap();
        let (missing, empty, damaged) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        assert_eq!(store.list(missing).unwrap(), None);

        std::fs::write(store.path(empty), "\n").unwrap();
        assert_eq!(store.list(empty).unwrap(), None);
        store.save(empty, canvas("First", Scope::All)).unwrap();
        assert_eq!(store.list(empty).unwrap().unwrap().len(), 1);

        std::fs::write(store.path(damaged), "{ \"version\": 1, \"canvases\": [ {").unwrap();
        assert_eq!(store.list(damaged).unwrap(), None);
        assert!(store.path(damaged).with_extension("json.invalid").exists(), "kept for recovery");
        store.forget(damaged).unwrap();
        assert!(!store.path(damaged).with_extension("json.invalid").exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn older_files_without_newer_fields_still_load() {
        let dir = temp_dir();
        let store = DiagramStore::open(&dir).unwrap();
        let p = Uuid::new_v4();
        let id = Uuid::new_v4();
        let json = format!(r#"{{"version":1,"canvases":[{{"id":"{id}","name":"Old","scope":{{"kind":"all"}}}}]}}"#);
        std::fs::write(store.path(p), json).unwrap();
        let c = &store.list(p).unwrap().unwrap()[0];
        assert_eq!((c.zoom, c.pan, c.auto_add), (1.0, Point::default(), false));
        assert!(c.positions.is_empty() && c.notes.is_empty() && c.seen.is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn what_cannot_be_saved() {
        let dir = temp_dir();
        let store = DiagramStore::open(&dir).unwrap();
        let p = Uuid::new_v4();
        assert!(store.save(p, canvas("  ", Scope::All)).is_err());
        assert!(store.save(p, canvas("No pattern", Scope::Pattern { patterns: vec![" ".into()] })).is_err());
        assert!(store.save(p, canvas("No root", Scope::Neighbours { root: " ".into(), depth: 1 })).is_err());
        let far = Scope::Neighbours { root: "public.orders".into(), depth: 3 };
        assert!(store.save(p, canvas("Too far", far)).is_err());
        assert_eq!(store.list(p).unwrap(), None, "nothing was written");

        let zoomed = store.save(p, Canvas { zoom: 9.0, ..canvas("Zoomed", Scope::All) }).unwrap();
        assert_eq!(zoomed.zoom, MAX_ZOOM);
        std::fs::remove_dir_all(dir).ok();
    }
}
