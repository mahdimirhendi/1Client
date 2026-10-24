//! Data types shared with the frontend. Field names are camelCase on the wire.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Engine {
    Postgres,
    Mysql,
}

impl Engine {
    pub fn default_port(self) -> u16 {
        match self {
            Engine::Postgres => 5432,
            Engine::Mysql => 3306,
        }
    }
}

/// An environment tag (Local, Staging, Production or one the user made), with its color.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentDef {
    /// Stable id stored in connections ("local", "staging", "production", or a generated one).
    pub id: String,
    pub name: String,
    /// `#RRGGBB`
    pub color: String,
    /// New connections in this environment ask before running writes.
    #[serde(default)]
    pub confirm_writes: bool,
}

pub fn default_environments() -> Vec<EnvironmentDef> {
    let e = |id: &str, name: &str, color: &str, confirm: bool| EnvironmentDef {
        id: id.into(),
        name: name.into(),
        color: color.into(),
        confirm_writes: confirm,
    };
    vec![
        e("local", "Local", "#8E8E93", false),
        e("staging", "Staging", "#F08C00", false),
        e("production", "Production", "#E5484D", true),
    ]
}

fn local_env() -> String {
    "local".into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SslMode {
    Disable,
    /// Try TLS without verifying the certificate, fall back to plain.
    #[default]
    Prefer,
    /// TLS required, certificate not verified (libpq `require`).
    Require,
    /// TLS required, certificate and host name verified.
    VerifyFull,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum NetworkMode {
    #[default]
    Direct,
    /// One SSH server forwards to the database. Uses `hops[0]` only.
    SshTunnel,
    /// Ordered jump hosts, like OpenSSH `ProxyJump`. The last hop forwards to the database.
    Bastion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SshAuth {
    /// Keys held by an SSH agent. `socket` overrides `SSH_AUTH_SOCK`
    /// (for example the 1Password agent socket).
    Agent {
        #[serde(default)]
        socket: Option<String>,
    },
    /// A private key file. Its passphrase, if any, is saved with the other passwords.
    KeyFile { path: String },
    /// Password, saved with the other passwords.
    Password,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHop {
    pub id: Uuid,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
}

fn default_ssh_port() -> u16 {
    22
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub mode: NetworkMode,
    #[serde(default)]
    pub hops: Vec<SshHop>,
}

impl Network {
    /// The hops actually used for the current mode.
    pub fn active_hops(&self) -> &[SshHop] {
        match self.mode {
            NetworkMode::Direct => &[],
            NetworkMode::SshTunnel => &self.hops[..self.hops.len().min(1)],
            NetworkMode::Bastion => &self.hops,
        }
    }
}

/// A saved connection. Passwords are never part of this struct; see `secrets`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: Uuid,
    pub name: String,
    pub engine: Engine,
    /// Id of an [`EnvironmentDef`].
    #[serde(default = "local_env")]
    pub environment: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub ssl_mode: SslMode,
    #[serde(default)]
    pub network: Network,
    /// Ask in the UI before running statements that change data or schema.
    #[serde(default = "yes")]
    pub confirm_writes: bool,
    /// Open the database session as read-only.
    #[serde(default)]
    pub read_only: bool,
    /// Unix seconds of the last successful connect.
    #[serde(default)]
    pub last_used_at: Option<u64>,
}

fn yes() -> bool {
    true
}

/// Secrets typed into the connection sheet. `None` keeps what is saved,
/// an empty string deletes it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsInput {
    #[serde(default)]
    pub db_password: Option<String>,
    /// Keyed by hop id.
    #[serde(default)]
    pub hops: std::collections::HashMap<Uuid, HopSecretInput>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HopSecretInput {
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub key_passphrase: Option<String>,
}

// ---------- Query results ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    /// Database type name when known (`int8`, `varchar`, ...).
    pub type_name: Option<String>,
    /// The table column this value comes from, when the server says so. Computed values,
    /// views and multi-statement runs have none. The grid uses it to allow editing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ColumnSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSource {
    pub schema: String,
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub columns: Vec<ColumnMeta>,
    /// Values as text, `None` for SQL NULL.
    pub rows: Vec<Vec<Option<String>>>,
    /// Rows returned or affected, as reported by the server.
    pub row_count: Option<u64>,
    /// More rows existed than `ROW_LIMIT`; only the first ones are in `rows`.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryOutput {
    pub sets: Vec<ResultSet>,
    pub elapsed_ms: u64,
}

/// Rows kept per result set. The drivers read rows as they arrive and stop keeping them after
/// this many, so a large `SELECT` never has to fit in memory.
pub const ROW_LIMIT: usize = 10_000;

// ---------- Schema ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    /// `table` or `view`.
    pub kind: String,
    pub columns: Vec<ColumnInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub foreign_key: bool,
    /// For foreign keys: the referenced `schema.table.column`.
    pub references: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: Uuid,
    pub profile_id: Uuid,
    pub server_version: String,
    /// The database the session is in ("" on MySQL when none is chosen).
    pub database: String,
    pub hops: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The JSON shape must match `src/types.ts`.
    #[test]
    fn profile_json_matches_frontend() {
        let json = r#"{
            "id": "11111111-1111-4111-8111-111111111111", "name": "shop-api", "engine": "postgres",
            "environment": "production", "host": "db.internal", "port": 5432, "user": "shop_rw",
            "database": "shop", "sslMode": "verifyFull", "confirmWrites": true, "readOnly": false,
            "network": { "mode": "bastion", "hops": [
                { "id": "22222222-2222-4222-8222-222222222222", "host": "bastion.example.com", "port": 22, "user": "me", "auth": { "kind": "agent" } },
                { "id": "33333333-3333-4333-8333-333333333333", "host": "10.0.4.12", "user": "deploy", "auth": { "kind": "keyFile", "path": "~/.ssh/id_ed25519" } }
            ] }
        }"#;
        let p: ConnectionProfile = serde_json::from_str(json).unwrap();
        assert_eq!(p.ssl_mode, SslMode::VerifyFull);
        assert_eq!(p.network.active_hops().len(), 2);
        assert_eq!(p.network.hops[1].port, 22);
        assert_eq!(p.network.hops[0].auth, SshAuth::Agent { socket: None });

        let back = serde_json::to_value(&p).unwrap();
        assert_eq!(back["network"]["mode"], "bastion");
        assert_eq!(back["sslMode"], "verifyFull");
    }

    #[test]
    fn ssh_tunnel_uses_only_first_hop() {
        let hop = |h: &str| SshHop {
            id: Uuid::new_v4(),
            host: h.into(),
            port: 22,
            user: "u".into(),
            auth: SshAuth::Password,
        };
        let n = Network { mode: NetworkMode::SshTunnel, hops: vec![hop("a"), hop("b")] };
        assert_eq!(n.active_hops().len(), 1);
        assert!(Network { mode: NetworkMode::Direct, hops: vec![hop("a")] }.active_hops().is_empty());
    }
}
