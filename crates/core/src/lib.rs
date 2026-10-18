//! 1Client core: connection profiles, saved passwords, SSH tunnels (including
//! multi-hop bastion chains) and the PostgreSQL / MySQL drivers.
//!
//! This crate has no UI or Tauri dependency, so it can be unit tested and reused
//! (for example by a CLI) on its own.

pub mod edit;
pub mod environments;
pub mod error;
pub mod known_hosts;
pub mod link;
pub mod model;
pub mod secrets;
pub mod session;
pub mod steps;
pub mod store;
pub mod tunnel;

mod db;

pub use environments::EnvironmentStore;
pub use error::{DbError, DbStage, Error, Result};
pub use model::*;
pub use session::{Session, TestReport};
pub use store::ConnectionStore;
