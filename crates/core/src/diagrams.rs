//! Diagram canvases, per connection, in `diagrams/<connection id>.json` in the app's data folder.
//! On PostgreSQL each database of a connection has its own canvases; on MySQL they cover every
//! database the connection shows, so there is one set.
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
use crate::{json_file, ConnectionProfile, Engine, Error, Result};

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
    /// Version 1: the canvases of the database the connection opens.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    canvases: Vec<Canvas>,
    /// By database (see `place`).
    #[serde(default)]
    databases: BTreeMap<String, Vec<Canvas>>,
}

impl FileFormat {
    /// Canvases saved before they were kept per database belong to the one the connection opens.
    fn upgraded(mut self, profile: &ConnectionProfile) -> Self {
        if self.version < 2 {
            let opens = match profile.engine {
                // PostgreSQL opens the database named after the user when none is set.
                Engine::Postgres if profile.database.is_empty() => &profile.user,
                _ => &profile.database,
            };
            let canvases = std::mem::take(&mut self.canvases);
            self.databases.insert(place(profile, opens), canvases);
        }
        self
    }
}

/// Where the canvases of `database` are kept: under its name on PostgreSQL, under "" on MySQL.
fn place(profile: &ConnectionProfile, database: &str) -> String {
    match profile.engine {
        Engine::Postgres => database.to_string(),
        Engine::Mysql => String::new(),
    }
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

    /// The canvases of a connection's database in the order they were made, or `None` when it
    /// never had any (the UI then starts one for the whole database).
    pub fn list(&self, profile: &ConnectionProfile, database: &str) -> Result<Option<Vec<Canvas>>> {
        Ok(self.read(profile)?.and_then(|mut f| f.databases.remove(&place(profile, database))))
    }

    /// Add a canvas, or replace the one with the same id. Returns it as saved.
    pub fn save(&self, profile: &ConnectionProfile, database: &str, canvas: Canvas) -> Result<Canvas> {
        let mut canvas = canvas.validated()?;
        let mut file = self.read(profile)?.unwrap_or_default();
        let list = file.databases.entry(place(profile, database)).or_default();
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
        self.write(profile.id, file)?;
        Ok(canvas)
    }

    pub fn delete(&self, profile: &ConnectionProfile, database: &str, id: Uuid) -> Result<()> {
        let Some(mut file) = self.read(profile)? else { return Ok(()) };
        // An empty list (rather than none) remembers that the canvases were deleted on purpose.
        if let Some(list) = file.databases.get_mut(&place(profile, database)) {
            list.retain(|c| c.id != id);
        }
        self.write(profile.id, file)
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

    fn read(&self, profile: &ConnectionProfile) -> Result<Option<FileFormat>> {
        Ok(json_file::read_or_set_aside::<FileFormat>(&self.path(profile.id))?.map(|f| f.upgraded(profile)))
    }

    fn write(&self, profile_id: Uuid, file: FileFormat) -> Result<()> {
        json_file::write(&self.path(profile_id), &FileFormat { version: 2, ..file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Network;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("oneclient-diagrams-{}", Uuid::new_v4()))
    }

    fn profile(engine: Engine, database: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: Uuid::new_v4(),
            name: "test".into(),
            engine,
            environment: "local".into(),
            host: "db.internal".into(),
            port: 5432,
            user: "app".into(),
            database: database.into(),
            ssl_mode: Default::default(),
            network: Network::default(),
            confirm_writes: true,
            read_only: false,
            last_used_at: None,
        }
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
        let (a, b) = (profile(Engine::Postgres, "shop"), profile(Engine::Postgres, "shop"));
        let store = DiagramStore::open(&dir).unwrap();
        let whole = store.save(&a, "shop", canvas(" Whole database ", Scope::All)).unwrap();
        let pattern = Scope::Pattern { patterns: vec!["legal_*".into(), " ".into()] };
        let legal = store.save(&a, "shop", canvas("Legal", pattern)).unwrap();
        store.save(&b, "shop", canvas("Elsewhere", Scope::Picked)).unwrap();
        assert_eq!(whole.name, "Whole database");
        assert!(whole.created_at > 0 && whole.updated_at >= whole.created_at);
        assert_eq!(legal.scope, Scope::Pattern { patterns: vec!["legal_*".into()] });

        let again = DiagramStore::open(&dir).unwrap();
        let list = again.list(&a, "shop").unwrap().unwrap();
        assert_eq!(list, [whole.clone(), legal.clone()], "everything comes back, in the order made");
        let picked = &again.list(&b, "shop").unwrap().unwrap()[0];
        assert!(!picked.auto_add, "picked tables never grow by themselves");

        // Updating keeps the creation time and the place in the list.
        let moved = Canvas { name: "Everything".into(), ..whole.clone() };
        let saved = again.save(&a, "shop", moved).unwrap();
        assert_eq!(saved.created_at, whole.created_at);
        let names: Vec<_> = again.list(&a, "shop").unwrap().unwrap().into_iter().map(|c| c.name).collect();
        assert_eq!(names, ["Everything", "Legal"]);

        again.delete(&a, "shop", legal.id).unwrap();
        again.delete(&a, "shop", whole.id).unwrap();
        assert_eq!(
            again.list(&a, "shop").unwrap(),
            Some(vec![]),
            "deleting them all is not the same as never having any"
        );

        again.forget(b.id).unwrap();
        assert_eq!(again.list(&b, "shop").unwrap(), None);
        again.forget(b.id).unwrap();
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn postgres_keeps_canvases_per_database_and_mysql_one_set() {
        let dir = temp_dir();
        let store = DiagramStore::open(&dir).unwrap();
        let pg = profile(Engine::Postgres, "shop");
        let shop = store.save(&pg, "shop", canvas("Shop", Scope::All)).unwrap();
        let billing = store.save(&pg, "billing", canvas("Billing", Scope::All)).unwrap();
        assert_eq!(store.list(&pg, "shop").unwrap(), Some(vec![shop]));
        assert_eq!(store.list(&pg, "billing").unwrap(), Some(vec![billing]));
        assert_eq!(store.list(&pg, "analytics").unwrap(), None, "a database without canvases yet");

        let my = profile(Engine::Mysql, "shop");
        let all = store.save(&my, "shop", canvas("All", Scope::All)).unwrap();
        assert_eq!(store.list(&my, "crm").unwrap(), Some(vec![all.clone()]), "MySQL canvases cover every database");
        assert_eq!(store.list(&my, "").unwrap(), Some(vec![all]));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn canvases_from_before_databases_belong_to_the_one_the_connection_opens() {
        let dir = temp_dir();
        let store = DiagramStore::open(&dir).unwrap();
        let old = |p: &ConnectionProfile| {
            let json = format!(
                r#"{{"version":1,"canvases":[{{"id":"{}","name":"Old","scope":{{"kind":"all"}}}}]}}"#,
                Uuid::new_v4()
            );
            std::fs::write(store.path(p.id), json).unwrap();
        };
        let named = profile(Engine::Postgres, "shop");
        old(&named);
        assert_eq!(store.list(&named, "shop").unwrap().unwrap()[0].name, "Old");
        assert_eq!(store.list(&named, "billing").unwrap(), None);
        // Saving in another database keeps them where they belong.
        store.save(&named, "billing", canvas("Billing", Scope::All)).unwrap();
        assert_eq!(store.list(&named, "shop").unwrap().unwrap()[0].name, "Old");

        let unnamed = profile(Engine::Postgres, "");
        old(&unnamed);
        assert_eq!(store.list(&unnamed, "app").unwrap().unwrap().len(), 1, "PostgreSQL opens the user's database");

        let mysql = profile(Engine::Mysql, "shop");
        old(&mysql);
        assert_eq!(store.list(&mysql, "crm").unwrap().unwrap().len(), 1);

        // Fields added later get their defaults.
        let c = &store.list(&named, "shop").unwrap().unwrap()[0];
        assert_eq!((c.zoom, c.pan, c.auto_add), (1.0, Point::default(), false));
        assert!(c.positions.is_empty() && c.notes.is_empty() && c.seen.is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_missing_empty_or_damaged_file_starts_fresh() {
        let dir = temp_dir();
        let store = DiagramStore::open(&dir).unwrap();
        let (missing, empty, damaged) =
            (profile(Engine::Postgres, "shop"), profile(Engine::Postgres, "shop"), profile(Engine::Postgres, "shop"));
        assert_eq!(store.list(&missing, "shop").unwrap(), None);

        std::fs::write(store.path(empty.id), "\n").unwrap();
        assert_eq!(store.list(&empty, "shop").unwrap(), None);
        store.save(&empty, "shop", canvas("First", Scope::All)).unwrap();
        assert_eq!(store.list(&empty, "shop").unwrap().unwrap().len(), 1);

        std::fs::write(store.path(damaged.id), "{ \"version\": 2, \"databases\": { \"shop\": [ {").unwrap();
        assert_eq!(store.list(&damaged, "shop").unwrap(), None);
        assert!(store.path(damaged.id).with_extension("json.invalid").exists(), "kept for recovery");
        store.forget(damaged.id).unwrap();
        assert!(!store.path(damaged.id).with_extension("json.invalid").exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn what_cannot_be_saved() {
        let dir = temp_dir();
        let store = DiagramStore::open(&dir).unwrap();
        let p = profile(Engine::Postgres, "shop");
        assert!(store.save(&p, "shop", canvas("  ", Scope::All)).is_err());
        assert!(store.save(&p, "shop", canvas("No pattern", Scope::Pattern { patterns: vec![" ".into()] })).is_err());
        assert!(store.save(&p, "shop", canvas("No root", Scope::Neighbours { root: " ".into(), depth: 1 })).is_err());
        let far = Scope::Neighbours { root: "public.orders".into(), depth: 3 };
        assert!(store.save(&p, "shop", canvas("Too far", far)).is_err());
        assert_eq!(store.list(&p, "shop").unwrap(), None, "nothing was written");

        let zoomed = store.save(&p, "shop", Canvas { zoom: 9.0, ..canvas("Zoomed", Scope::All) }).unwrap();
        assert_eq!(zoomed.zoom, MAX_ZOOM);
        std::fs::remove_dir_all(dir).ok();
    }
}
