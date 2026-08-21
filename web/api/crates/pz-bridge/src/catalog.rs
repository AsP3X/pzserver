//! The list of every item the server has registered.
//!
//! `KR_Catalog.export()` writes this once at boot, walking
//! `ScriptManager:getAllItems()`. Reading the running server's own registry
//! rather than shipping a static list is what makes modded items appear:
//! whatever a loaded mod defines is registered, so it is in the file.
//!
//! Boot is the only time it can change. The registered set moves when mods
//! move, and moving mods needs a restart, so there is no staleness window here
//! and nothing to refresh.

use std::path::PathBuf;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::lua::{BridgeError, BridgeRead, LuaBridge};

/// Written by `KR_Catalog.lua` at server boot.
pub const ITEMS_CATALOG_FILE: &str = "items_catalog.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ItemCatalogExport {
    #[serde(default)]
    pub items: Vec<ItemCatalogEntry>,
}

/// One registered item.
///
/// The mod also writes `icon_name` and `texture_icon`. Nothing in the panel
/// renders item art, so they are dropped here rather than carried all the way
/// to the browser on every one of five thousand entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemCatalogEntry {
    /// The ID `additem` takes, like `Base.Axe`.
    pub full_type: String,
    /// Display name as the game resolves it, translations applied.
    #[serde(default)]
    pub name: String,
    /// The PZ display category, not one of the shop's own.
    #[serde(default)]
    pub category: String,
}

/// Reader over the catalogue file.
#[derive(Debug, Clone)]
pub struct ItemCatalogReader {
    bridge: LuaBridge,
}

impl ItemCatalogReader {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            bridge: LuaBridge::new(dir),
        }
    }

    /// Every registered item, or `None` when the mod has never written the
    /// file. A zero-byte file reads as `None` too — `data-init` writes those
    /// over missing exports.
    pub async fn read(&self) -> Result<Option<BridgeRead<ItemCatalogExport>>, BridgeError> {
        self.bridge.read_export(ITEMS_CATALOG_FILE).await
    }

    /// When the catalogue was last rewritten, without paying to parse it.
    pub async fn modified_at(&self) -> Option<SystemTime> {
        self.bridge.modified_at(ITEMS_CATALOG_FILE).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed to two entries. The real export carries `icon_name` and
    /// `texture_icon` on every item; both are here so the test proves they are
    /// ignored rather than rejected.
    const CATALOG: &str = r#"{
        "version": 1,
        "timestamp": "1993-07-08T13:38:00",
        "item_count": 2,
        "items": [
            {
                "full_type": "Base.Axe",
                "name": "Axe",
                "category": "ToolWeapon",
                "icon_name": "Item_Axe",
                "texture_icon": "Axe"
            },
            {
                "full_type": "Base.WaterBottleFull",
                "name": "Water Bottle",
                "category": "Water",
                "icon_name": "Item_WaterBottleFull",
                "texture_icon": "WaterBottle"
            }
        ]
    }"#;

    /// Returned together because dropping the `TempDir` deletes the directory
    /// the reader points at.
    fn reader_with(contents: &str) -> (tempfile::TempDir, ItemCatalogReader) {
        let dir = tempfile::tempdir().expect("create temp dir");
        std::fs::write(dir.path().join(ITEMS_CATALOG_FILE), contents).expect("write export");
        let reader = ItemCatalogReader::new(dir.path());

        (dir, reader)
    }

    #[tokio::test]
    async fn a_missing_catalog_reads_as_none() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let reader = ItemCatalogReader::new(dir.path());

        assert!(reader.read().await.expect("read").is_none());
    }

    #[tokio::test]
    async fn an_empty_catalog_reads_as_none() {
        let (_dir, reader) = reader_with("");

        assert!(reader.read().await.expect("read").is_none());
    }

    #[tokio::test]
    async fn every_item_is_parsed() {
        let (_dir, reader) = reader_with(CATALOG);

        let read = reader.read().await.expect("read").expect("a catalog");

        assert_eq!(read.data.items.len(), 2);
        assert_eq!(
            read.data.items[0],
            ItemCatalogEntry {
                full_type: "Base.Axe".to_string(),
                name: "Axe".to_string(),
                category: "ToolWeapon".to_string(),
            }
        );
        assert_eq!(read.data.items[1].full_type, "Base.WaterBottleFull");
    }

    /// A future mod version adding a field must not break the reader.
    #[tokio::test]
    async fn unknown_fields_are_ignored() {
        let (_dir, reader) = reader_with(
            r#"{"items":[{"full_type":"Base.Axe","name":"Axe","category":"ToolWeapon","weight":3.0}]}"#,
        );

        let read = reader.read().await.expect("read").expect("a catalog");

        assert_eq!(read.data.items[0].name, "Axe");
    }

    /// The mod writes `name` for everything today, but an item with no display
    /// name must still load rather than sinking the whole catalogue.
    #[tokio::test]
    async fn a_missing_name_defaults_to_empty() {
        let (_dir, reader) = reader_with(r#"{"items":[{"full_type":"Base.Mystery"}]}"#);

        let read = reader.read().await.expect("read").expect("a catalog");

        assert_eq!(read.data.items[0].name, "");
        assert_eq!(read.data.items[0].category, "");
    }

    #[tokio::test]
    async fn the_read_carries_the_files_mtime() {
        let (_dir, reader) = reader_with(CATALOG);

        let read = reader.read().await.expect("read").expect("a catalog");

        assert!(read.modified_at.is_some());
    }
}
