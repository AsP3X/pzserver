//! Reading the mod's per-player exports.
//!
//! `KR_Vitals` and `KR_Snapshot` both write one file per player into a
//! subdirectory, and both fall back to a flat name when the host refuses to let
//! Lua create the folder. The two conventions are identical, so the lookup
//! lives here rather than twice.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::de::DeserializeOwned;

#[derive(Debug, thiserror::Error)]
pub enum PlayerFileError {
    #[error("player file {path} could not be read: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("player file {path} is not valid JSON: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

/// A parsed export, with the mtime it was read at.
#[derive(Debug, Clone)]
pub struct PlayerFile<T> {
    pub data: T,
    /// When the mod last wrote it. The file outlives the session, so this is
    /// what separates "live" from "last known".
    pub reported_at: Option<SystemTime>,
}

/// Read `<dir>/<folder>/<username>.json`, falling back to
/// `<dir>/<folder>_<username>.json`.
///
/// `None` means the mod has never written one, which is the normal state for a
/// character that has not been online since the mod was installed.
pub async fn read_player_json<T>(
    dir: &Path,
    folder: &str,
    username: &str,
) -> Result<Option<PlayerFile<T>>, PlayerFileError>
where
    T: DeserializeOwned,
{
    // The username comes from our own database rather than from a request, but
    // it still ends up in a path, so anything that could climb out of the
    // bridge directory is refused outright.
    if !is_safe_filename(username) {
        return Ok(None);
    }

    let candidates = [
        dir.join(folder).join(format!("{username}.json")),
        dir.join(format!("{folder}_{username}.json")),
    ];

    for path in candidates {
        let contents = match tokio::fs::read_to_string(&path).await {
            Ok(contents) => contents,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => continue,
            Err(source) => return Err(PlayerFileError::Read { path, source }),
        };

        // The repair service writes a zero-byte placeholder over a missing
        // export, and the mod truncates before rewriting.
        if contents.trim().is_empty() {
            continue;
        }

        let data = serde_json::from_str(&contents).map_err(|source| PlayerFileError::Parse {
            path: path.clone(),
            source,
        })?;

        let reported_at = tokio::fs::metadata(&path)
            .await
            .ok()
            .and_then(|meta| meta.modified().ok());

        return Ok(Some(PlayerFile { data, reported_at }));
    }

    Ok(None)
}

/// PZ usernames are letters, digits and underscores; anything else has no
/// business being joined onto a path.
pub fn is_safe_filename(username: &str) -> bool {
    !username.is_empty()
        && username.len() <= 50
        && username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct Sample {
        value: i32,
    }

    #[tokio::test]
    async fn prefers_the_subdirectory_form() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::create_dir_all(dir.path().join("thing")).expect("mkdir");
        std::fs::write(dir.path().join("thing/rook.json"), r#"{"value":1}"#).expect("write");
        std::fs::write(dir.path().join("thing_rook.json"), r#"{"value":2}"#).expect("write");

        let read = read_player_json::<Sample>(dir.path(), "thing", "rook")
            .await
            .expect("read")
            .expect("present");

        assert_eq!(read.data.value, 1);
    }

    #[tokio::test]
    async fn falls_back_to_the_flat_form() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("thing_rook.json"), r#"{"value":2}"#).expect("write");

        let read = read_player_json::<Sample>(dir.path(), "thing", "rook")
            .await
            .expect("read")
            .expect("present");

        assert_eq!(read.data.value, 2);
        assert!(read.reported_at.is_some());
    }

    #[tokio::test]
    async fn a_missing_file_reads_as_none() {
        let dir = tempfile::tempdir().expect("temp dir");

        assert!(
            read_player_json::<Sample>(dir.path(), "thing", "rook")
                .await
                .expect("read")
                .is_none()
        );
    }

    #[tokio::test]
    async fn an_empty_file_is_skipped_rather_than_failing() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("thing_rook.json"), "").expect("write");

        assert!(
            read_player_json::<Sample>(dir.path(), "thing", "rook")
                .await
                .expect("read")
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_username_that_could_escape_the_directory_is_refused() {
        let dir = tempfile::tempdir().expect("temp dir");

        for username in ["../../etc/passwd", "rook/../../x", "", "rook.json"] {
            assert!(
                read_player_json::<Sample>(dir.path(), "thing", username)
                    .await
                    .expect("read")
                    .is_none(),
                "{username} should be refused",
            );
        }
    }
}
