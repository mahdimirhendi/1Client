//! Where passwords and key passphrases live: an encrypted file in 1Client's own data
//! folder (`vault.json`, key in `vault.key`, both readable only by you). 1Client never uses
//! the macOS Keychain, so there are no system password prompts.
//!
//! The key sits next to the vault, so this protects the secrets from being read by accident
//! (a copied or synced file, a backup, a screen share), not from software running as you.
//!
//! A value that is a 1Password reference (`op://vault/item/field`) is read with the
//! 1Password CLI when connecting, so the real secret is never stored here.
//!
//! Item names are `<profile id>/db`, `<profile id>/hop/<hop id>/password` and
//! `<profile id>/hop/<hop id>/passphrase`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use data_encoding::BASE64;
use uuid::Uuid;

use crate::{ConnectionProfile, Error, Result, SecretsInput, SshAuth};

#[derive(Debug, Clone, Default)]
pub struct HopSecret {
    pub password: Option<String>,
    pub key_passphrase: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ProfileSecrets {
    pub db_password: Option<String>,
    pub hops: HashMap<Uuid, HopSecret>,
}

fn db_account(p: Uuid) -> String {
    format!("{p}/db")
}
fn hop_password_account(p: Uuid, h: Uuid) -> String {
    format!("{p}/hop/{h}/password")
}
fn hop_passphrase_account(p: Uuid, h: Uuid) -> String {
    format!("{p}/hop/{h}/passphrase")
}

pub struct SecretStore {
    vault: AppVault,
}

impl SecretStore {
    pub fn open(dir: &Path) -> Result<Self> {
        Ok(Self { vault: AppVault::open(dir)? })
    }

    /// Saved values as stored: 1Password references are not resolved yet.
    fn stored(&self, profile: &ConnectionProfile) -> ProfileSecrets {
        let mut out = ProfileSecrets { db_password: self.vault.get(&db_account(profile.id)), ..Default::default() };
        for hop in &profile.network.hops {
            out.hops.insert(
                hop.id,
                HopSecret {
                    password: self.vault.get(&hop_password_account(profile.id, hop.id)),
                    key_passphrase: self.vault.get(&hop_passphrase_account(profile.id, hop.id)),
                },
            );
        }
        out
    }

    /// Store what the user typed. `None` keeps the stored value, `""` deletes it.
    /// A typed `op://` reference is stored as the reference, never the secret behind it.
    pub fn save(&self, profile: &ConnectionProfile, input: &SecretsInput) -> Result<()> {
        let mut writes: Vec<(String, &Option<String>)> = vec![(db_account(profile.id), &input.db_password)];
        for (hop_id, s) in &input.hops {
            writes.push((hop_password_account(profile.id, *hop_id), &s.password));
            writes.push((hop_passphrase_account(profile.id, *hop_id), &s.key_passphrase));
        }
        self.vault.put_many(&writes)
    }

    /// The saved secrets to connect with (see [`SecretStore::merged`]).
    pub async fn load(&self, profile: &ConnectionProfile) -> Result<ProfileSecrets> {
        self.merged(profile, &SecretsInput::default()).await
    }

    /// The secrets to connect with: saved values with unsaved input laid on top (`None` keeps
    /// the saved value, `""` clears it). 1Password references are read here, which may show a
    /// Touch ID prompt; a reference that can't be read is an error, not a missing password.
    pub async fn merged(&self, profile: &ConnectionProfile, input: &SecretsInput) -> Result<ProfileSecrets> {
        let typed = |v: &String| Some(v.clone()).filter(|v| !v.is_empty());
        let mut s = self.stored(profile);
        if let Some(pw) = &input.db_password {
            s.db_password = typed(pw);
        }
        for (id, h) in &input.hops {
            let e = s.hops.entry(*id).or_default();
            if let Some(pw) = &h.password {
                e.password = typed(pw);
            }
            if let Some(pp) = &h.key_passphrase {
                e.key_passphrase = typed(pp);
            }
        }

        // Only hops the network mode uses: a Direct profile may keep hops for later, and their
        // references must not prompt for Touch ID or fail the connection.
        let active: HashSet<Uuid> = profile.network.active_hops().iter().map(|h| h.id).collect();
        s.hops.retain(|id, _| active.contains(id));

        s.db_password = resolve(s.db_password).await?;
        for h in s.hops.values_mut() {
            h.password = resolve(h.password.take()).await?;
            h.key_passphrase = resolve(h.key_passphrase.take()).await?;
        }
        Ok(s)
    }

    /// Remove every secret of a deleted profile.
    pub fn forget(&self, profile: &ConnectionProfile) -> Result<()> {
        let prefix = format!("{}/", profile.id);
        self.vault.remove_where(|account| account.starts_with(&prefix))
    }

    /// Drop secrets the profile no longer uses: those of removed hops, and a password or
    /// passphrase kept for a hop that now signs in another way.
    pub fn prune(&self, profile: &ConnectionProfile) -> Result<()> {
        let used: HashSet<String> = profile
            .network
            .hops
            .iter()
            .filter_map(|h| match h.auth {
                SshAuth::Password => Some(hop_password_account(profile.id, h.id)),
                SshAuth::KeyFile { .. } => Some(hop_passphrase_account(profile.id, h.id)),
                SshAuth::Agent { .. } => None,
            })
            .collect();
        let hops = format!("{}/hop/", profile.id);
        self.vault.remove_where(|account| account.starts_with(&hops) && !used.contains(account))
    }

    /// 1Password references saved for a profile, so the edit sheet can show them.
    /// Real passwords are never returned.
    pub fn references(&self, profile: &ConnectionProfile) -> SecretsInput {
        let reference = |account: String| self.vault.get(&account).filter(|v| v.starts_with("op://"));
        let mut out = SecretsInput { db_password: reference(db_account(profile.id)), ..Default::default() };
        for hop in &profile.network.hops {
            out.hops.insert(
                hop.id,
                crate::HopSecretInput {
                    password: reference(hop_password_account(profile.id, hop.id)),
                    key_passphrase: reference(hop_passphrase_account(profile.id, hop.id)),
                },
            );
        }
        out
    }
}

/// A 1Password reference is read from 1Password; anything else is the secret itself.
async fn resolve(value: Option<String>) -> Result<Option<String>> {
    match value {
        Some(reference) if reference.starts_with("op://") => one_password::read(&reference).await.map(Some),
        other => Ok(other),
    }
}

// ---------- App vault: encrypted file ----------

struct AppVault {
    file: PathBuf,
    cipher: ChaCha20Poly1305,
    items: Mutex<BTreeMap<String, String>>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct VaultFile {
    v: u32,
    nonce: String,
    data: String,
}

impl AppVault {
    fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let key_path = dir.join("vault.key");
        let key_bytes = match std::fs::read(&key_path) {
            Ok(k) if k.len() == 32 => k,
            Ok(_) => return Err(Error::Secret(format!("{} is damaged", key_path.display()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut k = vec![0u8; 32];
                getrandom::fill(&mut k).map_err(|e| Error::Secret(e.to_string()))?;
                write_private(&key_path, &k)?;
                k
            }
            Err(e) => return Err(e.into()),
        };
        let key = Key::try_from(&key_bytes[..]).map_err(|_| Error::Secret("bad vault key".into()))?;
        let cipher = ChaCha20Poly1305::new(&key);
        let file = dir.join("vault.json");

        let items = match std::fs::read(&file) {
            Ok(bytes) => {
                let f: VaultFile = serde_json::from_slice(&bytes).map_err(|e| Error::Secret(e.to_string()))?;
                let nonce_bytes = BASE64.decode(f.nonce.as_bytes()).map_err(|e| Error::Secret(e.to_string()))?;
                let data = BASE64.decode(f.data.as_bytes()).map_err(|e| Error::Secret(e.to_string()))?;
                let nonce = Nonce::try_from(&nonce_bytes[..]).map_err(|_| Error::Secret("bad vault nonce".into()))?;
                let plain = cipher
                    .decrypt(&nonce, data.as_ref())
                    .map_err(|_| Error::Secret("the saved passwords could not be decrypted".into()))?;
                serde_json::from_slice(&plain).map_err(|e| Error::Secret(e.to_string()))?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self { file, cipher, items: Mutex::new(items) })
    }

    fn get(&self, account: &str) -> Option<String> {
        self.items.lock().unwrap().get(account).cloned()
    }

    /// Apply writes: `None` keeps an item, `""` removes it, anything else sets it.
    fn put_many(&self, writes: &[(String, &Option<String>)]) -> Result<()> {
        let mut items = self.items.lock().unwrap();
        let mut next = items.clone();
        for (account, value) in writes {
            match value {
                None => {}
                Some(v) if v.is_empty() => {
                    next.remove(account);
                }
                Some(v) => {
                    next.insert(account.clone(), v.clone());
                }
            }
        }
        if next != *items {
            self.persist(&next)?;
            *items = next;
        }
        Ok(())
    }

    fn remove_where(&self, unused: impl Fn(&str) -> bool) -> Result<()> {
        let mut items = self.items.lock().unwrap();
        let mut next = items.clone();
        next.retain(|account, _| !unused(account));
        if next.len() != items.len() {
            self.persist(&next)?;
            *items = next;
        }
        Ok(())
    }

    /// Encrypt with a fresh nonce and replace the file atomically. Memory is only updated by
    /// the callers once this succeeded, so it never disagrees with the file.
    fn persist(&self, items: &BTreeMap<String, String>) -> Result<()> {
        let plain = serde_json::to_vec(items).map_err(|e| Error::Secret(e.to_string()))?;
        let mut nonce_bytes = [0u8; 12];
        getrandom::fill(&mut nonce_bytes).map_err(|e| Error::Secret(e.to_string()))?;
        let nonce = Nonce::try_from(&nonce_bytes[..]).map_err(|_| Error::Secret("bad nonce".into()))?;
        let data =
            self.cipher.encrypt(&nonce, plain.as_ref()).map_err(|_| Error::Secret("encryption failed".into()))?;
        let f = VaultFile { v: 1, nonce: BASE64.encode(&nonce_bytes), data: BASE64.encode(&data) };
        let json = serde_json::to_vec(&f).map_err(|e| Error::Secret(e.to_string()))?;
        let tmp = self.file.with_extension("json.tmp");
        write_private(&tmp, &json)?;
        std::fs::rename(&tmp, &self.file)?;
        Ok(())
    }
}

/// Write a file readable only by the current user.
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)?;
    Ok(())
}

// ---------- 1Password CLI ----------

pub mod one_password {
    use std::path::PathBuf;

    use crate::{Error, Result};

    const HELP: &str = "Install the 1Password CLI (`brew install 1password-cli`) and turn on \
        1Password › Settings › Developer › Integrate with 1Password CLI.";

    /// Apps opened from Finder get a minimal PATH, so look in the usual places too.
    fn op_binary() -> Option<PathBuf> {
        let mut dirs: Vec<PathBuf> =
            std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
        dirs.into_iter().map(|d| d.join("op")).find(|p| p.is_file())
    }

    /// Resolve an `op://vault/item/field` reference.
    pub async fn read(reference: &str) -> Result<String> {
        if !reference.starts_with("op://") {
            return Err(Error::Secret(format!("“{reference}” is not a 1Password reference (op://vault/item/field)")));
        }
        let op = op_binary().ok_or_else(|| Error::Secret(format!("1Password CLI not found. {HELP}")))?;
        let out = tokio::process::Command::new(op)
            .args(["read", "--no-newline", reference])
            .output()
            .await
            .map_err(|e| Error::Secret(format!("1Password CLI failed to start: {e}")))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(Error::Secret(format!("1Password: {msg}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_round_trip_and_delete() {
        let dir = std::env::temp_dir().join(format!("oneclient-vault-{}", Uuid::new_v4()));
        let v = AppVault::open(&dir).unwrap();
        v.put_many(&[("a".into(), &Some("s3cret".into())), ("b".into(), &Some("x".into()))]).unwrap();
        v.put_many(&[("b".into(), &Some(String::new())), ("a".into(), &None)]).unwrap();

        let raw = std::fs::read_to_string(dir.join("vault.json")).unwrap();
        assert!(!raw.contains("s3cret"), "vault must be encrypted");

        let again = AppVault::open(&dir).unwrap();
        assert_eq!(again.get("a").as_deref(), Some("s3cret"));
        assert_eq!(again.get("b"), None);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn unused_secrets_are_dropped() {
        use crate::{Engine, HopSecretInput, Network, NetworkMode, SshHop, SslMode};

        let dir = std::env::temp_dir().join(format!("oneclient-prune-{}", Uuid::new_v4()));
        let store = SecretStore::open(&dir).unwrap();
        let hop = |auth: SshAuth| SshHop { id: Uuid::new_v4(), host: "h".into(), port: 22, user: "u".into(), auth };
        let (a, b) = (hop(SshAuth::Password), hop(SshAuth::KeyFile { path: "~/.ssh/id_ed25519".into() }));
        let mut p = ConnectionProfile {
            id: Uuid::new_v4(),
            name: "app".into(),
            engine: Engine::Postgres,
            environment: "local".into(),
            host: "db".into(),
            port: 5432,
            user: "app".into(),
            database: String::new(),
            ssl_mode: SslMode::Prefer,
            network: Network { mode: NetworkMode::Bastion, hops: vec![a.clone(), b.clone()] },
            confirm_writes: true,
            read_only: false,
            last_used_at: None,
        };
        let secret = |password: Option<&str>, key_passphrase: Option<&str>| HopSecretInput {
            password: password.map(Into::into),
            key_passphrase: key_passphrase.map(Into::into),
        };
        let input = SecretsInput {
            db_password: Some("db-pw".into()),
            hops: HashMap::from([(a.id, secret(Some("a-pw"), None)), (b.id, secret(None, Some("b-pass")))]),
        };
        store.save(&p, &input).unwrap();

        // Hop b is removed and hop a now signs in with the agent: both secrets go.
        p.network.hops = vec![SshHop { auth: SshAuth::Agent { socket: None }, ..a.clone() }];
        store.prune(&p).unwrap();
        assert_eq!(store.vault.get(&hop_password_account(p.id, a.id)), None);
        assert_eq!(store.vault.get(&hop_passphrase_account(p.id, b.id)), None);

        let s = store.merged(&p, &SecretsInput::default()).await.unwrap();
        assert_eq!(s.db_password.as_deref(), Some("db-pw"));
        let cleared = SecretsInput { db_password: Some(String::new()), ..Default::default() };
        assert_eq!(store.merged(&p, &cleared).await.unwrap().db_password, None);

        // Hops kept by a Direct profile are not read (a broken reference must not block connecting).
        store
            .save(
                &p,
                &SecretsInput { hops: HashMap::from([(a.id, secret(Some("op://x"), None))]), ..Default::default() },
            )
            .unwrap();
        p.network.mode = NetworkMode::Direct;
        assert!(store.merged(&p, &SecretsInput::default()).await.unwrap().hops.is_empty());

        store.forget(&p).unwrap();
        assert_eq!(store.vault.get(&db_account(p.id)), None);
        std::fs::remove_dir_all(dir).ok();
    }

    /// A fake `op` on PATH stands in for the 1Password CLI.
    #[tokio::test]
    async fn one_password_reads_references() {
        let dir = std::env::temp_dir().join(format!("oneclient-op-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let op = dir.join("op");
        std::fs::write(&op, "#!/bin/sh\n[ \"$1 $2 $3\" = \"read --no-newline op://Dev/db/password\" ] && printf pw123 && exit 0\necho \"[ERROR] item not found\" >&2; exit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&op, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = format!("{}:{}", dir.display(), std::env::var("PATH").unwrap_or_default());
        std::env::set_var("PATH", path);

        assert_eq!(one_password::read("op://Dev/db/password").await.unwrap(), "pw123");
        let err = one_password::read("op://Dev/nope/password").await.unwrap_err().to_string();
        assert!(err.contains("item not found"), "{err}");
        assert!(one_password::read("plain").await.is_err());
        std::fs::remove_dir_all(dir).ok();
    }
}
