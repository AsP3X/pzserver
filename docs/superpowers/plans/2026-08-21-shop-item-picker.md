# Shop Item Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw item-ID text input in the admin shop catalogue forms with a button that opens a searchable dialog over every item the server has registered, modded items included.

**Architecture:** Knox Relay already writes `Lua/items_catalog.json` at server boot from `ScriptManager:getAllItems()`. A new bridge reader parses it, a cached service in the API keys the parsed copy on the file's mtime, one admin endpoint serves the trimmed list, and the browser fetches it once per session and matches locally with the existing `lib/fuzzy.ts`.

**Tech Stack:** Rust (axum 0.8, serde, tokio), React 19 + TanStack Query/Router, Tailwind v4. No new dependencies in either crate or in `web/ui`.

**Spec:** `docs/superpowers/specs/2026-08-21-shop-item-picker-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `web/api/crates/pz-bridge/src/catalog.rs` | **Create.** Export types + stateless `ItemCatalogReader`, shaped like `InventoryReader`/`VitalsReader`. |
| `web/api/crates/pz-bridge/src/lua.rs` | **Modify.** Widen `read_export` to `pub(crate)` so `catalog.rs` can reuse it. |
| `web/api/crates/pz-bridge/src/lib.rs` | **Modify.** Register and re-export the new module. |
| `web/api/crates/pz-api/src/services/items.rs` | **Create.** `ItemCatalogService` — mtime-keyed parse cache, shaped like `StatusService`. |
| `web/api/crates/pz-api/src/services/mod.rs` | **Modify.** Register the module. |
| `web/api/crates/pz-api/src/state.rs` | **Modify.** Hold `Arc<ItemCatalogService>`. |
| `web/api/crates/pz-api/src/routes/admin.rs` | **Modify.** `GET /admin/items`. |
| `web/ui/src/lib/api.ts` | **Modify.** `CatalogItem`/`ItemCatalog` types, `adminItems()`. |
| `web/ui/src/lib/queries.ts` | **Modify.** `adminItemsQuery`. |
| `web/ui/src/i18n/en.json`, `de.json` | **Modify.** Picker strings. |
| `web/ui/src/components/ui/item-picker.tsx` | **Create.** The dialog. Standalone so the quest editor can adopt it later. |
| `web/ui/src/routes/admin/shop.tsx` | **Modify.** `ItemFields` swaps the input for a button. |

Two notes on decomposition. The reader stays stateless in `pz-bridge` because that crate's readers all are; the cache lives in `pz-api/services` because that is where the one long-lived cached service already lives (`StatusService`). And the picker is its own component rather than a branch inside `shop.tsx` because `shop.tsx` is already 377 lines and the quest editor has the same field waiting for it.

## Commands

This is a Windows host with no `make`. Run the checks directly:

```bash
cd web/api && cargo test --workspace
```

```bash
cd web/api && cargo clippy --all-targets --all-features -- -D warnings && cargo fmt --check
```

```bash
cd web/ui && npx tsc -b && npm run lint
```

---

### Task 1: Catalogue reader in `pz-bridge`

**Files:**
- Create: `web/api/crates/pz-bridge/src/catalog.rs`
- Modify: `web/api/crates/pz-bridge/src/lua.rs` (the `read_export` signature)
- Modify: `web/api/crates/pz-bridge/src/lib.rs`

- [ ] **Step 1: Widen `read_export` so the new module can reuse it**

In `web/api/crates/pz-bridge/src/lua.rs`, find:

```rust
    async fn read_export<T>(&self, file: &str) -> Result<Option<BridgeRead<T>>, BridgeError>
```

Change that one line to:

```rust
    pub(crate) async fn read_export<T>(
        &self,
        file: &str,
    ) -> Result<Option<BridgeRead<T>>, BridgeError>
```

Nothing else in `lua.rs` changes. This is what gives `catalog.rs` the missing-file and zero-byte-file contract for free instead of reimplementing it.

- [ ] **Step 2: Write the failing tests**

Create `web/api/crates/pz-bridge/src/catalog.rs` containing **only** the test module for now, so the tests fail to compile against types that do not exist yet:

```rust
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
```

Register the module in `web/api/crates/pz-bridge/src/lib.rs`. Add to the `pub mod` block, keeping it alphabetical among its neighbours (after `pub mod deposit;`):

```rust
pub mod catalog;
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd web/api && cargo test --workspace catalog::tests
```

Expected: FAIL to compile, `cannot find type ItemCatalogReader in this scope` and `cannot find value ITEMS_CATALOG_FILE in this scope`.

- [ ] **Step 4: Write the implementation**

Insert above the `#[cfg(test)]` block in `web/api/crates/pz-bridge/src/catalog.rs`:

```rust
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
```

Then add the re-export to `web/api/crates/pz-bridge/src/lib.rs`, directly above the existing `pub use docker::{...}` line:

```rust
pub use catalog::{ITEMS_CATALOG_FILE, ItemCatalogEntry, ItemCatalogExport, ItemCatalogReader};
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd web/api && cargo test --workspace catalog::tests
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add web/api/crates/pz-bridge/src/catalog.rs web/api/crates/pz-bridge/src/lib.rs web/api/crates/pz-bridge/src/lua.rs && git commit -m "Read the mod's item catalogue export."
```

---

### Task 2: Cached catalogue service in `pz-api`

**Files:**
- Create: `web/api/crates/pz-api/src/services/items.rs`
- Modify: `web/api/crates/pz-api/src/services/mod.rs`
- Modify: `web/api/crates/pz-api/src/state.rs`

- [ ] **Step 1: Write the failing tests**

Create `web/api/crates/pz-api/src/services/items.rs` containing **only** the test module for now:

```rust
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
```

Register the module in `web/api/crates/pz-api/src/services/mod.rs`, alphabetically between `pub mod i18n;` and `pub mod news;`:

```rust
pub mod items;
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd web/api && cargo test --workspace items::tests
```

Expected: FAIL to compile, `cannot find type ItemCatalogService in this scope`.

- [ ] **Step 3: Write the implementation**

Insert above the `#[cfg(test)]` block in `web/api/crates/pz-api/src/services/items.rs`:

```rust
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd web/api && cargo test --workspace items::tests
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Wire the service into `AppState`**

In `web/api/crates/pz-api/src/state.rs`, add the import next to the other service imports:

```rust
use crate::services::items::ItemCatalogService;
```

Add the field to the `AppState` struct, directly below `pub bridge: LuaBridge,`:

```rust
    /// The item catalogue, parsed once and held until the export changes.
    /// Long-lived because the cache is the point; a per-request reader would
    /// re-parse the file every time the picker opened.
    pub item_catalog: Arc<ItemCatalogService>,
```

In `AppState::new`, add the construction directly below the existing `let bridge = LuaBridge::new(&config.lua_bridge_path);`:

```rust
        let item_catalog = Arc::new(ItemCatalogService::new(&config.lua_bridge_path));
```

And add `item_catalog,` to the returned `Self { .. }` literal, below `bridge,`.

- [ ] **Step 6: Verify the workspace still builds and the suite passes**

```bash
cd web/api && cargo test --workspace
```

Expected: PASS, no compilation errors.

- [ ] **Step 7: Commit**

```bash
git add web/api/crates/pz-api/src/services/items.rs web/api/crates/pz-api/src/services/mod.rs web/api/crates/pz-api/src/state.rs && git commit -m "Cache the parsed item catalogue on its mtime."
```

---

### Task 3: The admin endpoint

**Files:**
- Modify: `web/api/crates/pz-api/src/routes/admin.rs`

- [ ] **Step 1: Add the route**

In the `routes()` builder in `web/api/crates/pz-api/src/routes/admin.rs`, add this line directly below the existing `.route("/admin/bridge", get(bridge))`:

```rust
        .route("/admin/items", get(items))
```

- [ ] **Step 2: Add the handler**

Add directly below the existing `bridge` handler (the function ending `Ok(Json(admin::bridge_health(&state).await?))`):

```rust
#[derive(Serialize)]
struct ItemCatalogResponse {
    items: Vec<pz_bridge::ItemCatalogEntry>,
}

/// Every item the server has registered, modded ones included.
///
/// An absent catalogue answers `200` with an empty list rather than an error.
/// The mod writes it at boot, so "not written yet" is the normal state of a
/// server that has never started, and the picker renders an explanation for it.
///
/// The clone off the cached `Arc` is deliberate: `serde` only serialises `Arc`
/// behind its `rc` feature, and this endpoint is hit about once per admin
/// session — not worth widening a dependency's feature set over.
async fn items(
    State(state): State<AppState>,
    _staff: AdminUser,
) -> ApiResult<Json<ItemCatalogResponse>> {
    Ok(Json(ItemCatalogResponse {
        items: state.item_catalog.items().await.to_vec(),
    }))
}
```

- [ ] **Step 3: Verify it compiles and the suite still passes**

```bash
cd web/api && cargo test --workspace
```

Expected: PASS.

- [ ] **Step 4: Run clippy and fmt**

```bash
cd web/api && cargo clippy --all-targets --all-features -- -D warnings && cargo fmt --check
```

Expected: no warnings, no diff. If `cargo fmt --check` reports a diff, run `cargo fmt` and re-run.

- [ ] **Step 5: Commit**

```bash
git add web/api/crates/pz-api/src/routes/admin.rs && git commit -m "Serve the item catalogue to staff."
```

---

### Task 4: API client and query

**Files:**
- Modify: `web/ui/src/lib/api.ts`
- Modify: `web/ui/src/lib/queries.ts`

- [ ] **Step 1: Add the types**

In `web/ui/src/lib/api.ts`, add directly above the existing `export interface StoreItem {` block (around line 1004):

```ts
/**
 * One entry from the game server's own item registry, as Knox Relay exported
 * it at boot. `category` is the PZ display category, not one of the shop's.
 */
export interface CatalogItem {
  full_type: string
  name: string
  category: string
}

export interface ItemCatalog {
  items: CatalogItem[]
}
```

- [ ] **Step 2: Add the client method**

In the same file, add directly below the existing `adminBridge:` line (around line 1485):

```ts
  adminItems: () => request<ItemCatalog>('/api/v1/admin/items'),
```

- [ ] **Step 3: Add the query**

In `web/ui/src/lib/queries.ts`, add directly below the existing `adminBridgeQuery` block:

```ts
/**
 * The item catalogue only moves when the game server boots, so once fetched it
 * is good for the session. Not `Infinity`, though — a restart while the tab is
 * open should eventually be noticed.
 */
export const adminItemsQuery = queryOptions({
  queryKey: ['admin', 'items'],
  queryFn: api.adminItems,
  staleTime: 30 * 60_000,
})
```

- [ ] **Step 4: Verify types**

```bash
cd web/ui && npx tsc -b
```

Expected: no output (success).

- [ ] **Step 5: Commit**

```bash
git add web/ui/src/lib/api.ts web/ui/src/lib/queries.ts && git commit -m "Fetch the item catalogue in the browser."
```

---

### Task 5: Translation keys

**Files:**
- Modify: `web/ui/src/i18n/en.json`
- Modify: `web/ui/src/i18n/de.json`

`en.json` defines `TranslationKey`, so every key must land there or the next task will not typecheck.

- [ ] **Step 1: Add the English strings**

In `web/ui/src/i18n/en.json`, add these keys next to the existing `"economy.item_type"` entry:

```json
  "economy.choose_item": "Choose an item",
  "economy.pick_item": "Pick an item",
  "economy.item_search": "Search items",
  "economy.item_search_placeholder": "Name or ID, like Fire Axe or Base.Axe",
  "economy.item_search_hint": ":count items — type to search",
  "economy.item_search_empty": "No item matches that.",
  "economy.item_catalog_empty": "The item list is written when the server boots with Knox Relay. Start the server, or enter an ID by hand below.",
  "economy.item_manual": "Or enter an ID by hand",
  "economy.item_manual_use": "Use this ID",
```

- [ ] **Step 2: Add the German strings**

In `web/ui/src/i18n/de.json`, add the same keys next to the existing `"economy.item_type"` entry:

```json
  "economy.choose_item": "Gegenstand wählen",
  "economy.pick_item": "Gegenstand auswählen",
  "economy.item_search": "Gegenstände suchen",
  "economy.item_search_placeholder": "Name oder ID, z. B. Feueraxt oder Base.Axe",
  "economy.item_search_hint": ":count Gegenstände — zum Suchen tippen",
  "economy.item_search_empty": "Kein Gegenstand passt dazu.",
  "economy.item_catalog_empty": "Die Gegenstandsliste wird beim Serverstart mit Knox Relay geschrieben. Starte den Server oder gib unten eine ID von Hand ein.",
  "economy.item_manual": "Oder ID von Hand eingeben",
  "economy.item_manual_use": "Diese ID verwenden",
```

- [ ] **Step 3: Verify both files are still valid JSON and the key sets line up**

```bash
node -e "const en=require('./web/ui/src/i18n/en.json'),de=require('./web/ui/src/i18n/de.json');const missing=Object.keys(en).filter(k=>k.startsWith('economy.item')||k==='economy.choose_item'||k==='economy.pick_item').filter(k=>!(k in de));console.log(missing.length?'missing in de: '+missing.join(', '):'de covers every new key')"
```

Expected: `de covers every new key`.

- [ ] **Step 4: Commit**

```bash
git add web/ui/src/i18n/en.json web/ui/src/i18n/de.json && git commit -m "Name the item picker in both locales."
```

---

### Task 6: The picker dialog

**Files:**
- Create: `web/ui/src/components/ui/item-picker.tsx`

- [ ] **Step 1: Write the component**

Create `web/ui/src/components/ui/item-picker.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import { fuzzyMatchWords, fuzzySlices } from '@/lib/fuzzy'
import { adminItemsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { CatalogItem } from '@/lib/api'

/**
 * Rendering every match of a five-thousand-item catalogue costs frames and
 * buys nothing: nobody scrolls past a hundred results.
 */
const MAX_ROWS = 100

/**
 * Search over every item the game server has registered.
 *
 * Its own `<dialog>` rather than a `ConfirmDialog`, because the body is a live
 * filtering list and the confirm footer would have nothing to confirm. It
 * opens from inside the add-listing dialog, which is legal: the top layer is a
 * stack, so this sits above it and Escape reaches only the topmost.
 */
export function ItemPickerDialog({
  open,
  onSelect,
  onClose,
}: {
  open: boolean
  onSelect: (item: CatalogItem) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  // Shared by key with the field that opens this, which needs the catalogue on
  // page load anyway to resolve the selected item's display name. One fetch,
  // cached for the session either way.
  const catalogue = useQuery(adminItemsQuery)
  const dialog = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const searchId = useId()
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [manual, setManual] = useState('')

  const items = catalogue.data?.items ?? []
  const searching = query.trim() !== ''

  const shown = useMemo(() => {
    if (!searching) {
      return [...items]
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAX_ROWS)
    }

    // The ranked-search shape `admin/config.tsx` uses: score everything, drop
    // the misses, best first.
    return items
      .map((item) => {
        const hit = fuzzyMatchWords(query, `${item.name} ${item.full_type} ${item.category}`)

        return hit ? { item, score: hit.score } : null
      })
      .filter((entry): entry is { item: CatalogItem; score: number } => entry !== null)
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_ROWS)
      .map((entry) => entry.item)
  }, [items, query, searching])

  useEffect(() => {
    const element = dialog.current
    if (!element) {
      return
    }

    if (open && !element.open) {
      element.showModal()
      setQuery('')
      setManual('')
      setHighlight(0)
      search.current?.focus()
    } else if (!open && element.open) {
      element.close()
    }
  }, [open])

  // A new query means the old highlight points at an unrelated row.
  useEffect(() => {
    setHighlight(0)
  }, [query])

  function choose(item: CatalogItem) {
    onSelect(item)
    onClose()
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((current) => Math.min(current + 1, shown.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const picked = shown[highlight]
      if (picked) {
        choose(picked)
      }
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className={cn(
        'm-auto border border-fence-bright bg-ash p-0 text-bone backdrop:bg-void/80',
        'max-h-[min(44rem,calc(100vh-2rem))] w-[min(40rem,calc(100vw-2rem))]',
        'open:flex open:flex-col',
      )}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={() => {
        if (open) {
          onClose()
        }
      }}
    >
      <div className="shrink-0 border-b border-fence p-5">
        <h2 id={titleId} className="display text-2xl text-bone">
          {t('economy.pick_item')}
        </h2>

        <label htmlFor={searchId} className="sr-only">
          {t('economy.item_search')}
        </label>
        <div className="relative mt-3">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-dust"
          />
          <input
            id={searchId}
            ref={search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={t('economy.item_search_placeholder')}
            className={cn(
              'h-12 w-full border border-fence-bright bg-void pr-3 pl-9 font-mono text-sm text-bone',
              'transition-colors placeholder:text-dust focus:border-hazard',
            )}
          />
        </div>

        {items.length > 0 ? (
          <p className="mt-2 text-xs text-dust">
            {t('economy.item_search_hint', { count: items.length })}
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {catalogue.isPending ? (
          <div className="flex flex-col gap-2 p-5">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : items.length === 0 ? (
          <p className="p-5 text-sm text-dust">{t('economy.item_catalog_empty')}</p>
        ) : shown.length === 0 ? (
          <p className="p-5 text-sm text-dust">{t('economy.item_search_empty')}</p>
        ) : (
          <ul>
            {shown.map((item, index) => (
              <li key={item.full_type}>
                <button
                  type="button"
                  onClick={() => choose(item)}
                  onMouseEnter={() => setHighlight(index)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 border-b border-fence px-5 py-2.5 text-left',
                    index === highlight ? 'bg-ash-raised' : 'hover:bg-ash-raised',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-bone">
                      <Highlighted text={item.name} query={query} />
                    </span>
                    <span className="block truncate font-mono text-xs text-smoke">
                      <Highlighted text={item.full_type} query={query} />
                    </span>
                  </span>
                  <span className="shrink-0 border border-fence px-1.5 py-0.5 font-mono text-[0.625rem] text-dust uppercase">
                    {item.category}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-fence px-5 py-3">
        <label
          htmlFor={`${searchId}-manual`}
          className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase"
        >
          {t('economy.item_manual')}
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id={`${searchId}-manual`}
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && manual.trim() !== '') {
                event.preventDefault()
                choose({ full_type: manual.trim(), name: '', category: '' })
              }
            }}
            placeholder="Base.Axe"
            className={cn(
              'h-9 min-w-0 flex-1 border border-fence-bright bg-void px-3 font-mono text-xs text-bone',
              'transition-colors placeholder:text-dust focus:border-hazard',
            )}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={manual.trim() === ''}
            onClick={() => choose({ full_type: manual.trim(), name: '', category: '' })}
          >
            {t('economy.item_manual_use')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </dialog>
  )
}

/** Matched characters picked out, the way the log viewer does it. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const hit = query.trim() === '' ? null : fuzzyMatchWords(query, text)
  const slices = fuzzySlices(text, hit?.indices ?? [])

  return (
    <>
      {slices.map((slice, index) => (
        <span key={index} className={cn(slice.match && 'font-semibold text-hazard')}>
          {slice.text}
        </span>
      ))}
    </>
  )
}
```

- [ ] **Step 2: Verify types and lint**

```bash
cd web/ui && npx tsc -b && npm run lint
```

Expected: no output from `tsc`, and `npm run lint` reports no errors. If `oxlint` objects to `key={index}` on the highlight spans, leave the code as-is — `logs.tsx` renders slices the same way — and add `// oxlint-disable-next-line no-array-index-key` only if the lint actually fails.

- [ ] **Step 3: Commit**

```bash
git add web/ui/src/components/ui/item-picker.tsx && git commit -m "Add the searchable item picker dialog."
```

---

### Task 7: Wire the picker into the shop forms

**Files:**
- Modify: `web/ui/src/routes/admin/shop.tsx`

`ItemFields` is shared by the add-listing dialog and the edit form, so this one change covers both.

- [ ] **Step 1: Add the imports**

In `web/ui/src/routes/admin/shop.tsx`, change the `lucide-react` import line:

```tsx
import { Plus, Search, Trash2 } from 'lucide-react'
```

Add these two imports alongside the existing component imports:

```tsx
import { ItemPickerDialog } from '@/components/ui/item-picker'
import { adminItemsQuery } from '@/lib/queries'
```

Extend the existing `@/lib/api` import to bring in the catalogue type:

```tsx
import { api, ApiError, type CatalogItem, type StoreItem, type StoreItemInput } from '@/lib/api'
```

And extend the existing `@tanstack/react-query` import if `useQuery` is not already there — it is, so no change.

- [ ] **Step 2: Replace the item-type field**

In `ItemFields`, find this line:

```tsx
      <Field label={t('economy.item_type')} value={value.item_type ?? ''} onChange={(event) => patch({ item_type: event.target.value })} />
```

Replace it with:

```tsx
      <ItemTypeField value={value} onPick={pick} />
```

Then add the `pick` handler inside `ItemFields`, directly below the existing `patch` function:

```tsx
  /**
   * Setting the ID is unconditional; filling the name is not.
   *
   * On a new listing the name is empty, so picking Fire Axe saves a retype. On
   * an edit it is whatever staff chose to call it — possibly deliberately not
   * the vanilla name — and changing the item must not overwrite that.
   */
  function pick(item: CatalogItem) {
    const named = (value.name ?? '').trim() === '' && item.name !== ''

    onChange({
      ...value,
      item_type: item.full_type,
      ...(named ? { name: item.name } : {}),
    })
  }
```

- [ ] **Step 3: Add the field component**

Add at the end of `web/ui/src/routes/admin/shop.tsx`:

```tsx
/**
 * The item ID, as a button rather than a text box.
 *
 * Typing `Base.Axe` by hand is fine; the other five thousand IDs are not, and
 * a typo produces a listing that takes coins and delivers nothing, because
 * `additem` fails silently on an ID the server does not know.
 */
function ItemTypeField({
  value,
  onPick,
}: {
  value: StoreItemInput
  onPick: (item: CatalogItem) => void
}) {
  const { t } = useTranslation()
  const [picking, setPicking] = useState(false)
  const catalogue = useQuery(adminItemsQuery)

  const itemType = value.item_type ?? ''
  const known = catalogue.data?.items.find((item) => item.full_type === itemType) ?? null

  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
        {t('economy.item_type')}
      </span>

      <button
        type="button"
        onClick={() => setPicking(true)}
        className={cn(
          'flex h-12 items-center justify-between gap-3 border border-fence-bright bg-void px-3 text-left',
          'transition-colors hover:border-hazard',
        )}
      >
        {itemType === '' ? (
          <span className="text-sm text-dust">{t('economy.choose_item')}</span>
        ) : (
          <span className="min-w-0">
            {known ? (
              <span className="block truncate text-sm text-bone">{known.name}</span>
            ) : null}
            <span
              className={cn(
                'block truncate font-mono',
                known ? 'text-xs text-smoke' : 'text-sm text-bone',
              )}
            >
              {itemType}
            </span>
          </span>
        )}
        <Search aria-hidden="true" className="size-4 shrink-0 text-dust" />
      </button>

      <ItemPickerDialog open={picking} onSelect={onPick} onClose={() => setPicking(false)} />
    </div>
  )
}
```

- [ ] **Step 4: Verify types and lint**

```bash
cd web/ui && npx tsc -b && npm run lint
```

Expected: no output from `tsc`, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add web/ui/src/routes/admin/shop.tsx && git commit -m "Pick shop items from the catalogue instead of typing IDs."
```

---

### Task 8: Verify in the browser

The dialog and its ranking are the parts no test covers, so this task is where they get proven. Do not skip it and do not report the feature working without having done it.

**Files:** none — verification only.

- [ ] **Step 1: Bring the stack up**

The UI dev server proxies to the API, so the API and database have to be running. From the repo root:

```bash
.\make.ps1 up
```

Then start the UI preview with `preview_start` using the existing `web-ui` configuration in `.claude/launch.json` (port 5174). Do not start it with a shell command.

- [ ] **Step 2: Confirm the endpoint answers**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5174/api/v1/admin/items
```

Expected: `401` when logged out — that proves the route exists and is guarded. A `404` means the route was not registered.

- [ ] **Step 3: Sign in and open the shop page**

Navigate to `http://localhost:5174/admin/shop`, sign in as the admin, and confirm the listing editor on the right shows the new **Item type** button instead of a text input.

- [ ] **Step 4: Check the payload arrived**

Use `read_network_requests` with a URL pattern of `admin/items` after opening the picker. Expected: one `200`, and a body whose `items` array has roughly 5,092 entries.

- [ ] **Step 5: Work through the picker**

Confirm each of these, using `read_page` and `computer`:

- Opening it from **New listing** shows the list, and the hint reads `5092 items — type to search`.
- Typing `fireax` ranks the Fire Axe at or near the top.
- Typing `base.ax` finds the same item by ID.
- Matched characters are highlighted in both the name and the ID.
- ↑/↓ move the highlight and Enter picks the highlighted row.
- Escape closes **only** the picker, leaving the New listing dialog open behind it. This is the one behaviour most likely to be wrong.
- Picking an item on **New listing** fills the empty Name field with the item's display name.
- Picking a different item on an **existing listing** whose name is already set leaves that name untouched.
- The manual-entry row accepts a typed ID and applies it.

- [ ] **Step 6: Check the console**

Use `read_console_messages` with `onlyErrors: true`. Expected: nothing related to the picker.

- [ ] **Step 7: Screenshot the open picker**

Take a `computer` screenshot of the picker with a query typed and results ranked, and share it as the evidence that this works.

- [ ] **Step 8: Full check, then commit any fixes**

```bash
cd web/api && cargo test --workspace && cargo clippy --all-targets --all-features -- -D warnings && cargo fmt --check
```

```bash
cd web/ui && npx tsc -b && npm run lint
```

Expected: all pass. Commit any fixes the browser pass turned up.

---

## Notes for whoever executes this

**Do not bump Knox Relay's version.** This change does not touch the mod. The Lua is unchanged, so neither the server-side nor the client-side deploy rules in `CLAUDE.md` apply here.

**`CLAUDE.md` is out of date in two ways** that will mislead you if you trust it: it describes a Laravel stack (the repo is a Rust API plus a Vite/React UI), and it names Georgian as the second locale (the repo ships German). Both are worth fixing, neither belongs in this change.

**The quest editor has the same raw-ID field** at `web/ui/src/routes/admin/quest-editor.tsx:1441`. It is deliberately out of scope. `ItemPickerDialog` is standalone so adopting it there later is small.
