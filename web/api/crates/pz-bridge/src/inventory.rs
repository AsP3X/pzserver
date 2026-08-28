//! What a player is carrying, as `KR_Snapshot` last wrote it.
//!
//! The snapshot is a flat item list plus a container tree. A bag is addressed
//! by the id of the item holding it rather than by its name, so a player
//! carrying two wallets does not get both sets of contents reported as one.
//!
//! Snapshots are written while a player is online. The mod also serves
//! out-of-band requests dropped into `export_requests.json`, which is how the
//! site asks for a fresh one — see [`request_snapshot`].

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::player_file::{PlayerFile, PlayerFileError, is_safe_filename, read_player_json};

/// Subdirectory the mod writes snapshots into.
const FOLDER: &str = "inventory";

/// Queue the mod drains every tick.
const EXPORT_REQUESTS_FILE: &str = "export_requests.json";

/// The container id the bridge uses for the player's own pockets. Bags are
/// `bag:<item id>`.
pub const POCKETS: &str = "inventory";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InventorySnapshot {
    #[serde(default)]
    pub username: String,
    /// Real time — `KR_Snapshot` stamps this one off the wall clock, unlike the
    /// in-game calendar the other exports carry.
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub items: Vec<InventoryItem>,
    #[serde(default)]
    pub containers: Vec<InventoryContainer>,
    /// Total carried weight.
    #[serde(default)]
    pub weight: f64,
    #[serde(default)]
    pub max_weight: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InventoryItem {
    #[serde(default)]
    pub id: String,
    pub full_type: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub category: String,
    #[serde(default = "one")]
    pub count: i64,
    /// Wear as a 0–1 fraction. Absent for items that do not degrade.
    #[serde(default)]
    pub condition: Option<f64>,
    #[serde(default)]
    pub equipped: bool,
    /// Display name of the container holding it.
    #[serde(default)]
    pub container: String,
    #[serde(default)]
    pub container_id: String,
    /// Set when this item is itself a bag: the container id it opens into.
    #[serde(default)]
    pub contains: Option<String>,
}

fn one() -> i64 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InventoryContainer {
    pub id: String,
    /// The container this bag sits in. `None` for the player's own pockets.
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub full_type: Option<String>,
    #[serde(default)]
    pub item_id: Option<String>,
    /// Whether the bag is worn rather than carried in another bag.
    #[serde(default)]
    pub worn: Option<bool>,
    #[serde(default)]
    pub capacity: Option<f64>,
    /// Weight of this container's own contents.
    #[serde(default)]
    pub weight: Option<f64>,
}

#[derive(Debug, thiserror::Error)]
pub enum InventoryError {
    #[error(transparent)]
    File(#[from] PlayerFileError),

    #[error("export request file {path} could not be written: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ExportRequests {
    #[serde(default)]
    usernames: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct InventoryReader {
    dir: PathBuf,
}

impl InventoryReader {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The player's last snapshot, or `None` if the mod has never written one.
    pub async fn read(
        &self,
        username: &str,
    ) -> Result<Option<PlayerFile<InventorySnapshot>>, InventoryError> {
        Ok(read_player_json(&self.dir, FOLDER, username).await?)
    }

    /// Ask the mod to write a fresh snapshot on its next tick.
    ///
    /// Only works while the player is online — the mod matches requests against
    /// its roster and drops the rest. Adding a name that is already queued is a
    /// no-op, so pressing refresh twice costs one snapshot.
    ///
    /// The mod clears this file as it serves it. A write that lands in the same
    /// instant can resurrect an entry it just consumed, which costs one extra
    /// snapshot and nothing else.
    pub async fn request_snapshot(&self, username: &str) -> Result<(), InventoryError> {
        if !is_safe_filename(username) {
            return Ok(());
        }

        let existing = self.read_queue().await?;

        // Deduplicated and ordered so the file stays readable by hand.
        let mut usernames: BTreeSet<String> = existing.usernames.into_iter().collect();
        usernames.insert(username.to_owned());

        let path = self.dir.join(EXPORT_REQUESTS_FILE);
        let body = serde_json::to_string_pretty(&ExportRequests {
            usernames: usernames.into_iter().collect(),
        })
        .map_err(|error| InventoryError::Write {
            path: path.clone(),
            source: std::io::Error::other(error),
        })?;

        write_atomically(&self.dir, EXPORT_REQUESTS_FILE, &body).await
    }

    /// Wait until the mod has drained this username from the request queue.
    ///
    /// `true` means the name is no longer listed — either the mod served it,
    /// or it was never queued. `false` means the timeout ran out while the
    /// name was still sitting there.
    pub async fn await_served(
        &self,
        username: &str,
        timeout: Duration,
    ) -> Result<bool, InventoryError> {
        let deadline = tokio::time::Instant::now() + timeout;

        loop {
            if !self.queue_contains(username).await? {
                return Ok(true);
            }

            if tokio::time::Instant::now() >= deadline {
                return Ok(false);
            }

            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn queue_contains(&self, username: &str) -> Result<bool, InventoryError> {
        let queued = self.read_queue().await?;
        Ok(queued.usernames.iter().any(|name| name == username))
    }

    async fn read_queue(&self) -> Result<ExportRequests, InventoryError> {
        let path = self.dir.join(EXPORT_REQUESTS_FILE);

        match tokio::fs::read_to_string(&path).await {
            Ok(contents) if !contents.trim().is_empty() => {
                Ok(serde_json::from_str(&contents).unwrap_or_default())
            }
            // A missing or empty queue is the usual state.
            Ok(_) => Ok(ExportRequests::default()),
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                Ok(ExportRequests::default())
            }
            Err(source) => Err(InventoryError::Write { path, source }),
        }
    }
}

/// Write via a temporary file and rename, so the mod never reads a half-written
/// queue.
async fn write_atomically(dir: &Path, name: &str, body: &str) -> Result<(), InventoryError> {
    let temporary = dir.join(format!("{name}.tmp"));
    let path = dir.join(name);

    tokio::fs::write(&temporary, body)
        .await
        .map_err(|source| InventoryError::Write {
            path: temporary.clone(),
            source,
        })?;

    tokio::fs::rename(&temporary, &path)
        .await
        .map_err(|source| InventoryError::Write { path, source })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SNAPSHOT: &str = r#"{
        "username": "rook",
        "timestamp": "2026-08-12T09:00:00Z",
        "items": [
            { "id": "1", "full_type": "Base.Axe", "name": "Axe", "category": "Weapon",
              "count": 1, "condition": 0.64, "equipped": true,
              "container": "inventory", "container_id": "inventory" },
            { "id": "2", "full_type": "Base.Bag_Normal", "name": "Bag", "category": "Container",
              "count": 1, "condition": null, "equipped": false,
              "container": "inventory", "container_id": "inventory", "contains": "bag:2" },
            { "id": "3", "full_type": "Base.Nails", "name": "Nails", "category": "Material",
              "count": 12, "condition": null, "equipped": false,
              "container": "Bag", "container_id": "bag:2" }
        ],
        "containers": [
            { "id": "inventory", "name": "inventory", "capacity": 8, "weight": 3.2 },
            { "id": "bag:2", "parent": "inventory", "name": "Bag", "item_id": "2",
              "worn": true, "capacity": 20, "weight": 1.1 }
        ],
        "weight": 4.3,
        "max_weight": 12.0
    }"#;

    fn reader() -> (tempfile::TempDir, InventoryReader) {
        let dir = tempfile::tempdir().expect("temp dir");
        let reader = InventoryReader::new(dir.path());

        (dir, reader)
    }

    #[tokio::test]
    async fn a_player_with_no_snapshot_reads_as_none() {
        let (_dir, reader) = reader();

        assert!(reader.read("rook").await.expect("read").is_none());
    }

    #[tokio::test]
    async fn parses_a_snapshot_with_a_nested_bag() {
        let (dir, reader) = reader();
        std::fs::create_dir_all(dir.path().join(FOLDER)).expect("mkdir");
        std::fs::write(dir.path().join(FOLDER).join("rook.json"), SNAPSHOT).expect("write");

        let snapshot = reader
            .read("rook")
            .await
            .expect("read")
            .expect("present")
            .data;

        assert_eq!(snapshot.items.len(), 3);
        assert_eq!(snapshot.weight, 4.3);

        let bag = snapshot
            .items
            .iter()
            .find(|item| item.contains.is_some())
            .expect("a bag");
        assert_eq!(bag.contains.as_deref(), Some("bag:2"));

        // Its contents are addressed by that id, not by the bag's name.
        assert!(
            snapshot
                .items
                .iter()
                .any(|item| item.container_id == "bag:2")
        );
    }

    #[tokio::test]
    async fn an_item_without_a_count_is_one() {
        let (dir, reader) = reader();
        std::fs::write(
            dir.path().join("inventory_rook.json"),
            r#"{"items":[{"full_type":"Base.Axe"}]}"#,
        )
        .expect("write");

        let snapshot = reader
            .read("rook")
            .await
            .expect("read")
            .expect("present")
            .data;

        assert_eq!(snapshot.items[0].count, 1);
    }

    #[tokio::test]
    async fn queues_a_snapshot_request() {
        let (dir, reader) = reader();

        reader.request_snapshot("rook").await.expect("queue");

        let body = std::fs::read_to_string(dir.path().join(EXPORT_REQUESTS_FILE)).expect("read");
        let queued: ExportRequests = serde_json::from_str(&body).expect("parse");

        assert_eq!(queued.usernames, vec!["rook"]);
    }

    #[tokio::test]
    async fn queueing_twice_leaves_one_entry() {
        let (dir, reader) = reader();

        reader.request_snapshot("rook").await.expect("queue");
        reader.request_snapshot("rook").await.expect("queue");

        let body = std::fs::read_to_string(dir.path().join(EXPORT_REQUESTS_FILE)).expect("read");
        let queued: ExportRequests = serde_json::from_str(&body).expect("parse");

        assert_eq!(queued.usernames, vec!["rook"]);
    }

    #[tokio::test]
    async fn queueing_keeps_names_another_request_left_behind() {
        let (dir, reader) = reader();
        std::fs::write(
            dir.path().join(EXPORT_REQUESTS_FILE),
            r#"{"usernames":["vesper"]}"#,
        )
        .expect("write");

        reader.request_snapshot("rook").await.expect("queue");

        let body = std::fs::read_to_string(dir.path().join(EXPORT_REQUESTS_FILE)).expect("read");
        let queued: ExportRequests = serde_json::from_str(&body).expect("parse");

        assert_eq!(queued.usernames, vec!["rook", "vesper"]);
    }

    #[tokio::test]
    async fn a_corrupt_queue_is_replaced_rather_than_failing() {
        let (dir, reader) = reader();
        std::fs::write(dir.path().join(EXPORT_REQUESTS_FILE), "{not json").expect("write");

        reader.request_snapshot("rook").await.expect("queue");

        let body = std::fs::read_to_string(dir.path().join(EXPORT_REQUESTS_FILE)).expect("read");
        let queued: ExportRequests = serde_json::from_str(&body).expect("parse");

        assert_eq!(queued.usernames, vec!["rook"]);
    }

    #[tokio::test]
    async fn queueing_leaves_no_temporary_file_behind() {
        let (dir, reader) = reader();

        reader.request_snapshot("rook").await.expect("queue");

        assert!(
            !dir.path()
                .join(format!("{EXPORT_REQUESTS_FILE}.tmp"))
                .exists()
        );
    }

    #[tokio::test]
    async fn await_served_returns_once_the_queue_no_longer_lists_the_player() {
        let (dir, reader) = reader();

        reader.request_snapshot("rook").await.expect("queue");

        let queue = dir.path().join(EXPORT_REQUESTS_FILE);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            std::fs::write(
                queue,
                r#"{"usernames":[],"updated_at":"2026-08-28T00:00:00"}"#,
            )
            .expect("drain");
        });

        let done = reader
            .await_served("rook", std::time::Duration::from_millis(500))
            .await
            .expect("wait");

        assert!(done);
    }

    #[tokio::test]
    async fn await_served_times_out_while_the_player_is_still_queued() {
        let (_dir, reader) = reader();

        reader.request_snapshot("rook").await.expect("queue");

        let done = reader
            .await_served("rook", std::time::Duration::from_millis(80))
            .await
            .expect("wait");

        assert!(!done);
    }

    #[tokio::test]
    async fn an_empty_queue_is_already_served() {
        let (_dir, reader) = reader();

        let done = reader
            .await_served("rook", std::time::Duration::from_millis(50))
            .await
            .expect("wait");

        assert!(done);
    }
}
