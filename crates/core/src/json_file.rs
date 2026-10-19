//! Small JSON files in the app's data folder, read whole and replaced atomically.

use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::{Error, Result};

/// The file's contents, or `None` when it doesn't exist yet. A file that isn't valid JSON for `T`
/// is an `Error::Config` naming the file.
pub(crate) fn read<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| Error::Config(format!("{} is not valid: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
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
