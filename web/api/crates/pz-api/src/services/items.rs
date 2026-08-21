//! The item catalogue, parsed once and kept until the file changes.

use std::path::Path;
use std::sync::Arc;
use std::time::SystemTime;

use pz_bridge::{ItemCatalogEntry, ItemCatalogReader};
use tokio::sync::RwLock;

struct Cached {
    items: Arc<[ItemCatalogEntry]>,
    /// The mtime the cached copy was parsed from. `None` means the file was
    /// absent, which is a state worth caching too.
    modified_at: Option<SystemTime>,
}

pub struct ItemCatalogService {
    reader: ItemCatalogReader,
    cache: RwLock<Option<Cached>>,
}

impl ItemCatalogService {
    pub fn new(dir: impl AsRef<Path>) -> Self {
        Self {
            reader: ItemCatalogReader::new(dir.as_ref()),
            cache: RwLock::new(None),
        }
    }

    /// Every registered item; empty when the mod has never written the file.
    ///
    /// Keyed on the file's mtime rather than on a clock, unlike `StatusService`
    /// next door. Server status changes on its own, so it ages out; this file
    /// changes only when the server boots, so a stat is proof enough that the
    /// parsed copy is still current. The alternative is re-parsing three
    /// quarters of a megabyte per request to learn nothing.
    ///
    /// A file that cannot be read or parsed reads as empty rather than as an
    /// error: the panel has to stay usable when the game server is cold, and
    /// the picker has an explanation for an empty catalogue.
    pub async fn items(&self) -> Arc<[ItemCatalogEntry]> {
        let modified_at = self.reader.modified_at().await;

        if let Some(cached) = self.cache.read().await.as_ref()
            && cached.modified_at == modified_at
        {
            return Arc::clone(&cached.items);
        }

        let items: Arc<[ItemCatalogEntry]> = match self.reader.read().await {
            Ok(Some(read)) => read.data.items.into(),
            Ok(None) => Arc::from([]),
            Err(error) => {
                tracing::warn!(%error, "item catalogue could not be read");

                Arc::from([])
            }
        };

        *self.cache.write().await = Some(Cached {
            items: Arc::clone(&items),
            modified_at,
        });

        items
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use pz_bridge::ITEMS_CATALOG_FILE;
    use uuid::Uuid;

    use super::*;

    const ONE: &str = r#"{"items":[{"full_type":"Base.Axe","name":"Axe","category":"ToolWeapon"}]}"#;
    const TWO: &str = r#"{"items":[{"full_type":"Base.Pan","name":"Pan","category":"Cooking"}]}"#;

    /// `tempfile` is not a dependency of this crate; `services::datadirs`
    /// builds its scratch directories the same way.
    fn scratch_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pz-api-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create the scratch directory");
        dir
    }

    /// Write the catalogue and stamp it with an explicit mtime, so a test can
    /// control whether the cache should consider itself current.
    fn write_catalog(dir: &std::path::Path, contents: &str, modified: SystemTime) {
        let path = dir.join(ITEMS_CATALOG_FILE);
        std::fs::write(&path, contents).expect("write the catalogue");
        std::fs::File::options()
            .write(true)
            .open(&path)
            .expect("open the catalogue")
            .set_modified(modified)
            .expect("stamp the catalogue");
    }

    #[tokio::test]
    async fn a_missing_catalog_reads_as_empty() {
        let dir = scratch_dir("catalog-missing");
        let service = ItemCatalogService::new(&dir);

        let items = service.items().await;

        let _ = std::fs::remove_dir_all(&dir);
        assert!(items.is_empty());
    }

    #[tokio::test]
    async fn items_are_read_from_the_file() {
        let dir = scratch_dir("catalog-read");
        write_catalog(&dir, ONE, SystemTime::UNIX_EPOCH);
        let service = ItemCatalogService::new(&dir);

        let items = service.items().await;

        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].full_type, "Base.Axe");
    }

    /// The point of the cache. New contents behind an unchanged mtime must not
    /// be picked up — if they are, the file is being re-parsed every call.
    #[tokio::test]
    async fn an_unchanged_mtime_serves_the_cached_copy() {
        let dir = scratch_dir("catalog-cached");
        write_catalog(&dir, ONE, SystemTime::UNIX_EPOCH);
        let service = ItemCatalogService::new(&dir);

        let first = service.items().await;
        write_catalog(&dir, TWO, SystemTime::UNIX_EPOCH);
        let second = service.items().await;

        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(first[0].full_type, "Base.Axe");
        assert_eq!(second[0].full_type, "Base.Axe");
    }

    /// A server restart rewrites the file, which moves its mtime.
    #[tokio::test]
    async fn a_changed_mtime_is_re_read() {
        let dir = scratch_dir("catalog-rebooted");
        write_catalog(&dir, ONE, SystemTime::UNIX_EPOCH);
        let service = ItemCatalogService::new(&dir);

        let first = service.items().await;
        write_catalog(&dir, TWO, SystemTime::UNIX_EPOCH + Duration::from_secs(60));
        let second = service.items().await;

        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(first[0].full_type, "Base.Axe");
        assert_eq!(second[0].full_type, "Base.Pan");
    }

    /// A catalogue that appears after the empty result was cached.
    #[tokio::test]
    async fn a_catalog_written_later_is_picked_up() {
        let dir = scratch_dir("catalog-late");
        let service = ItemCatalogService::new(&dir);

        assert!(service.items().await.is_empty());
        write_catalog(&dir, ONE, SystemTime::UNIX_EPOCH);
        let items = service.items().await;

        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(items.len(), 1);
    }

    /// Corrupt JSON must not take the admin panel down with it.
    #[tokio::test]
    async fn a_corrupt_catalog_reads_as_empty() {
        let dir = scratch_dir("catalog-corrupt");
        write_catalog(&dir, "{not json", SystemTime::UNIX_EPOCH);
        let service = ItemCatalogService::new(&dir);

        let items = service.items().await;

        let _ = std::fs::remove_dir_all(&dir);
        assert!(items.is_empty());
    }
}
