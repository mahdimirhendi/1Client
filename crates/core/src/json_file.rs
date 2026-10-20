//! Small JSON files in the app's data folder, read whole and replaced atomically.

use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::{Error, Result};

/// The file's contents, or `None` when it doesn't exist yet or is empty (a write cut short by a
/// full disk, say). A file that isn't valid JSON for `T` is an `Error::Config` naming the file.
pub(crate) fn read<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match std::fs::read(path) {
        Ok(bytes) if bytes.iter().all(u8::is_ascii_whitespace) => Ok(None),
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| Error::Config(format!("{} is not valid: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Like `read`, but a file that can't be parsed is moved aside (see `set_aside`) and reads as
/// missing, so the app still starts.
pub(crate) fn read_or_set_aside<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match read(path) {
        Err(Error::Config(why)) => {
            set_aside(path, &why)?;
            Ok(None)
        }
        other => other,
    }
}

/// Move a damaged file to `*.json.invalid` (or `*.invalid`), where it is kept for recovery and
/// the next save can't overwrite it. Returns where it went.
pub(crate) fn set_aside(path: &Path, why: &str) -> Result<std::path::PathBuf> {
    tracing::warn!("{why}; moving it aside");
    let ext = path.extension().map(|e| format!("{}.invalid", e.to_string_lossy())).unwrap_or_else(|| "invalid".into());
    let to = path.with_extension(ext);
    std::fs::rename(path, &to)?;
    Ok(to)
}

/// Replace the file: write a temporary file next to it, then rename it over, so a crash never
/// leaves half a file behind.
pub(crate) fn write<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let json = serde_json::to_vec_pretty(value).map_err(|e| Error::Config(e.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}
