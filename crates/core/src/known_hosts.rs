//! `~/.ssh/known_hosts` checking with OpenSSH semantics.
//!
//! russh's built-in check fails as soon as *any* line for the host holds a different key of
//! the same type, even when another line holds the right one. OpenSSH accepts the host if
//! any line matches, so a known_hosts file with an old and a new entry works in the terminal
//! but failed in 1Client. This module follows OpenSSH instead:
//!
//! - any matching line with the same key → trusted
//! - a matching `@revoked` line with the same key → refused
//! - no same key, but a same-type key is recorded → changed (refused; the UI offers to replace it)
//! - nothing recorded for this key type → unknown (trusted and added, like `StrictHostKeyChecking=accept-new`)
//!
//! Supports hashed hosts (`|1|…`), `[host]:port`, comma lists, `*`/`?` wildcards and `!` negation.
//! `@cert-authority` lines are skipped (host certificates are not supported yet).

use std::path::{Path, PathBuf};

use data_encoding::BASE64;
use hmac::{Hmac, KeyInit, Mac};
use russh::keys::PublicKey;
use sha1::Sha1;

use crate::{Error, Result};

#[derive(Debug, PartialEq, Eq)]
pub enum HostKeyStatus {
    Trusted,
    Unknown,
    /// A different key of the same type is recorded at this line (1-based).
    Changed {
        line: usize,
    },
    Revoked {
        line: usize,
    },
}

/// How OpenSSH names a host in known_hosts: `host` on port 22, `[host]:port` otherwise.
pub fn entry_name(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

pub fn default_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".ssh").join("known_hosts"))
}

/// Add `key` for the host to ~/.ssh/known_hosts, as `ssh` does when it meets a server for the
/// first time.
pub fn learn(host: &str, port: u16, key: &PublicKey) -> Result<()> {
    learn_at(&file(host)?, host, port, key)
}

/// The server's key changed and the user confirmed that was expected (the server was rebuilt):
/// remove its old keys with `ssh-keygen -R`, which keeps the previous file as `known_hosts.old`,
/// and add the new one.
pub async fn replace(host: &str, port: u16, key_openssh: &str) -> Result<()> {
    replace_at(&file(host)?, host, port, key_openssh).await
}

fn file(host: &str) -> Result<PathBuf> {
    default_path().ok_or_else(|| Error::ssh(host, "HOME is not set"))
}

fn learn_at(path: &Path, host: &str, port: u16, key: &PublicKey) -> Result<()> {
    russh::keys::known_hosts::learn_known_hosts_path(&host.to_ascii_lowercase(), port, key, path)
        .map_err(|e| Error::ssh(host, format!("could not add the host key to {}: {e}", path.display())))
}

async fn replace_at(path: &Path, host: &str, port: u16, key_openssh: &str) -> Result<()> {
    let key = PublicKey::from_openssh(key_openssh).map_err(|e| Error::ssh(host, e))?;
    let out = tokio::process::Command::new("ssh-keygen")
        .arg("-R")
        .arg(entry_name(&host.to_ascii_lowercase(), port))
        .arg("-f")
        .arg(path)
        .output()
        .await
        .map_err(|e| Error::ssh(host, format!("could not run ssh-keygen: {e}")))?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr);
        return Err(Error::ssh(host, format!("ssh-keygen -R failed: {}", why.trim())));
    }
    learn_at(path, host, port, &key)
}

pub fn check(host: &str, port: u16, key: &PublicKey) -> HostKeyStatus {
    match default_path() {
        Some(p) => check_path(host, port, key, &p),
        None => HostKeyStatus::Unknown,
    }
}

pub fn check_path(host: &str, port: u16, key: &PublicKey, path: &Path) -> HostKeyStatus {
    let Ok(text) = std::fs::read_to_string(path) else { return HostKeyStatus::Unknown };
    check_text(host, port, key, &text)
}

pub fn check_text(host: &str, port: u16, key: &PublicKey, text: &str) -> HostKeyStatus {
    // OpenSSH lowercases the host name before matching, which matters for hashed entries.
    let name = entry_name(&host.to_ascii_lowercase(), port);
    let mut changed: Option<usize> = None;
    let mut trusted = false;

    for (i, raw) in text.lines().enumerate() {
        let line_no = i + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let mut first = parts.next().unwrap_or_default();
        let marker = if first.starts_with('@') {
            let m = first;
            first = parts.next().unwrap_or_default();
            Some(m)
        } else {
            None
        };
        let (Some(kind), Some(b64)) = (parts.next(), parts.next()) else { continue };
        if marker == Some("@cert-authority") || !hosts_match(&name, first) {
            continue;
        }
        let Ok(recorded) = PublicKey::from_openssh(&format!("{kind} {b64}")) else { continue };

        let same_key = recorded.key_data() == key.key_data();
        if marker == Some("@revoked") {
            if same_key {
                return HostKeyStatus::Revoked { line: line_no };
            }
            continue;
        }
        if same_key {
            trusted = true;
        } else if recorded.algorithm() == key.algorithm() && changed.is_none() {
            changed = Some(line_no);
        }
    }

    match (trusted, changed) {
        (true, _) => HostKeyStatus::Trusted,
        (false, Some(line)) => HostKeyStatus::Changed { line },
        (false, None) => HostKeyStatus::Unknown,
    }
}

/// OpenSSH host list: comma separated, `!` negates, hashed entries start with `|1|`.
fn hosts_match(name: &str, list: &str) -> bool {
    let mut matched = false;
    for pat in list.split(',') {
        if let Some(neg) = pat.strip_prefix('!') {
            if pattern_match(name, neg) {
                return false;
            }
        } else if pattern_match(name, pat) {
            matched = true;
        }
    }
    matched
}

fn pattern_match(name: &str, pat: &str) -> bool {
    if let Some(rest) = pat.strip_prefix("|1|") {
        let mut it = rest.split('|');
        let (Some(Ok(salt)), Some(Ok(hash))) =
            (it.next().map(|s| BASE64.decode(s.as_bytes())), it.next().map(|s| BASE64.decode(s.as_bytes())))
        else {
            return false;
        };
        let Ok(mac) = Hmac::<Sha1>::new_from_slice(&salt) else { return false };
        return mac.chain_update(name.as_bytes()).verify_slice(&hash).is_ok();
    }
    glob(name.as_bytes(), pat.to_ascii_lowercase().as_bytes())
}

fn glob(s: &[u8], p: &[u8]) -> bool {
    match (p.first(), s.first()) {
        (None, None) => true,
        (Some(b'*'), _) => glob(s, &p[1..]) || (!s.is_empty() && glob(&s[1..], p)),
        (Some(b'?'), Some(_)) => glob(&s[1..], &p[1..]),
        (Some(a), Some(b)) if a == b => glob(&s[1..], &p[1..]),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHHhzL1nicGVi3EW9j5GVP8W+dZWDUTOAKSn9JlhzhTV";
    const B: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKBxUWKEwcouxtksE8aGUUdx7FYOyBn4tUQlurbvM4/i";

    fn key(s: &str) -> PublicKey {
        PublicKey::from_openssh(s).unwrap()
    }

    #[test]
    fn old_and_new_entries_trust_the_new_key() {
        // OpenSSH accepts this; russh's own check reported "changed" at line 1.
        let file = format!("db.example.com {A}\ndb.example.com {B}\n");
        assert_eq!(check_text("db.example.com", 22, &key(B), &file), HostKeyStatus::Trusted);
    }

    #[test]
    fn only_a_different_key_is_changed() {
        let file = format!("# comment\ndb.example.com {A}\n");
        assert_eq!(check_text("db.example.com", 22, &key(B), &file), HostKeyStatus::Changed { line: 2 });
    }

    #[test]
    fn unknown_host_and_ports() {
        let file = format!("other.example.com {A}\n[db.example.com]:2222 {A}\n");
        assert_eq!(check_text("db.example.com", 22, &key(A), &file), HostKeyStatus::Unknown);
        assert_eq!(check_text("db.example.com", 2222, &key(A), &file), HostKeyStatus::Trusted);
    }

    #[test]
    fn lists_wildcards_negation_and_markers() {
        let file =
            format!("web,*.example.com,!bad.example.com {A}\n@revoked db.example.com {B}\n@cert-authority * {B}\n");
        assert_eq!(check_text("db.example.com", 22, &key(A), &file), HostKeyStatus::Trusted);
        assert_eq!(check_text("bad.example.com", 22, &key(A), &file), HostKeyStatus::Unknown);
        assert_eq!(check_text("db.example.com", 22, &key(B), &file), HostKeyStatus::Revoked { line: 2 });
    }

    #[test]
    fn entry_names() {
        assert_eq!(entry_name("db.example.com", 22), "db.example.com");
        assert_eq!(entry_name("10.0.0.5", 2222), "[10.0.0.5]:2222");
    }

    #[tokio::test]
    async fn replacing_a_changed_key_keeps_other_hosts() {
        let dir = std::env::temp_dir().join(format!("oneclient-kh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("known_hosts");
        std::fs::write(&path, format!("[db.example.com]:2222 {A}\nother.example.com {A}\n")).unwrap();
        assert_eq!(check_path("db.example.com", 2222, &key(B), &path), HostKeyStatus::Changed { line: 1 });

        replace_at(&path, "DB.example.com", 2222, B).await.unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(check_text("db.example.com", 2222, &key(B), &text), HostKeyStatus::Trusted);
        assert_eq!(check_text("db.example.com", 2222, &key(A), &text), HostKeyStatus::Changed { line: 2 });
        assert_eq!(check_text("other.example.com", 22, &key(A), &text), HostKeyStatus::Trusted);
        assert!(dir.join("known_hosts.old").exists(), "ssh-keygen keeps the previous file");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn hashed_hosts() {
        // `ssh-keygen -H` style entry for "db.example.com", salt = 20 zero bytes.
        let salt = [0u8; 20];
        let mac = Hmac::<Sha1>::new_from_slice(&salt).unwrap().chain_update(b"db.example.com").finalize().into_bytes();
        let file = format!("|1|{}|{} {A}\n", BASE64.encode(&salt), BASE64.encode(&mac));
        assert_eq!(check_text("db.example.com", 22, &key(A), &file), HostKeyStatus::Trusted);
        assert_eq!(check_text("DB.Example.com", 22, &key(A), &file), HostKeyStatus::Trusted);
        assert_eq!(check_text("db2.example.com", 22, &key(A), &file), HostKeyStatus::Unknown);
    }
}
