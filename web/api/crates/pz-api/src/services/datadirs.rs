//! The host bind mounts the API has to be able to write.
//!
//! `data/backups` and `data/zomboid/Lua` are both bind mounts shared with the
//! game container, and this process can repair neither: it runs read-only as
//! uid 10001 with every capability dropped. The `data-init` service in
//! `docker-compose.web.yml` is what normally keeps the modes right, and these
//! probes are how a failure gets noticed rather than silently losing writes.

use std::path::Path;

use uuid::Uuid;

/// Prove a directory can be both written to and unlinked from.
///
/// Both halves matter. Writing an archive needs permission on the directory; so
/// does removing one, which is why a bad mode broke deletes as well as
/// scheduled backups when `data/backups` drifted to 775 in August 2026.
///
/// The Lua bridge needs the same permission for a different reason. Nothing
/// there is ever opened for writing — every write lands by renaming a temporary
/// over the target — and a rename is permitted by the directory, not by the
/// file it replaces. So this one check covers both mounts, and the file modes
/// inside them do not matter: the game container writes as root, which ignores
/// them entirely.
pub fn probe_writable(dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }

    let probe = dir.join(format!(".writable-{}", Uuid::new_v4()));

    std::fs::write(&probe, b"knox")
        .map_err(|error| format!("cannot create files in {}: {error}", dir.display()))?;

    std::fs::remove_file(&probe)
        .map_err(|error| format!("cannot remove files from {}: {error}", dir.display()))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    /// A scratch directory under the system temp dir, unique per test run.
    fn scratch_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pz-api-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create the scratch directory");
        dir
    }

    #[test]
    fn a_writable_directory_passes_the_probe() {
        let dir = scratch_dir("writable");

        let result = probe_writable(&dir);

        let _ = std::fs::remove_dir_all(&dir);
        assert!(result.is_ok(), "{result:?}");
    }

    #[test]
    fn the_probe_leaves_nothing_behind() {
        let dir = scratch_dir("clean");

        probe_writable(&dir).expect("a fresh scratch directory is writable");

        let left = std::fs::read_dir(&dir)
            .expect("read the scratch directory")
            .count();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(left, 0, "the probe file must not survive the probe");
    }

    #[test]
    fn a_missing_directory_fails_the_probe() {
        let missing = std::env::temp_dir().join(format!("pz-api-missing-{}", Uuid::new_v4()));

        assert!(probe_writable(&missing).is_err());
    }

    /// Root ignores the mode bits, so the read-only case can only be asserted
    /// when the test user is not root — which is how `make web-test` runs it.
    #[cfg(unix)]
    fn running_as_root() -> bool {
        use std::os::unix::fs::MetadataExt;

        let probe = std::env::temp_dir().join(format!("pz-api-uid-{}", Uuid::new_v4()));
        if std::fs::write(&probe, b"").is_err() {
            return false;
        }
        let uid = probe.metadata().map(|meta| meta.uid()).unwrap_or(1);
        let _ = std::fs::remove_file(&probe);

        uid == 0
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_directory_fails_the_probe() {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch_dir("read-only");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555))
            .expect("make the scratch directory read-only");

        let result = probe_writable(&dir);

        // Restore the mode first, or the cleanup cannot remove the directory.
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755));
        let _ = std::fs::remove_dir_all(&dir);

        if !running_as_root() {
            assert!(result.is_err(), "a 0555 directory must fail the probe");
        }
    }
}
