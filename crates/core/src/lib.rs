//! 1Client core: connection profiles, saved passwords, SSH tunnels (including
//! multi-hop bastion chains), the PostgreSQL / MySQL drivers and the app's saved data.
//!
//! This crate has no UI or Tauri dependency, so it can be unit tested and reused
//! (for example by a CLI) on its own.

pub mod diagrams;
pub mod edit;
pub mod environments;
pub mod error;
pub mod known_hosts;
pub mod link;
pub mod model;
pub mod queries;
pub mod secrets;
pub mod session;
pub mod steps;
pub mod store;
pub mod tunnel;

mod db;
mod json_file;

pub use diagrams::{Canvas, DiagramStore};
pub use environments::EnvironmentStore;
pub use error::{DbError, DbStage, Error, Result};
pub use model::*;
pub use queries::{HistoryEntry, QueryStore, SavedQuery};
pub use session::{Session, TestReport};
pub use store::ConnectionStore;
