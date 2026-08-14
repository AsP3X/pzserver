//! The item order queue shared with Knox Relay (`KR_Orders`).
//!
//! This stack writes `delivery_queue.json`. The mod drains pending entries
//! while the named player is online and reports each id in
//! `delivery_results.json`. An id that already has a result is never run twice.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const QUEUE_FILE: &str = "delivery_queue.json";
pub const RESULTS_FILE: &str = "delivery_results.json";

const QUEUE_LIMIT: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryQueue {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub entries: Vec<DeliveryEntry>,
}

impl Default for DeliveryQueue {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at: String::new(),
            entries: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryEntry {
    pub id: String,
    pub action: String,
    pub username: String,
    pub item_type: String,
    pub count: i32,
    pub status: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub condition: Option<f32>,
    /// Packed bag contents for `give_kit`. Nested items stay inside the bag.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cargo: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryResults {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub results: Vec<DeliveryResult>,
}

impl Default for DeliveryResults {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at: String::new(),
            results: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryResult {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub processed_at: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub removed_count: Option<i32>,
}

fn one() -> u32 {
    1
}

#[derive(Debug, thiserror::Error)]
pub enum DeliveryError {
    #[error("delivery file {path} could not be read: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("delivery file {path} could not be written: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("delivery file {path} is not valid JSON: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone)]
pub struct DeliveryChannel {
    dir: PathBuf,
}

impl DeliveryChannel {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub async fn queue(&self) -> Result<DeliveryQueue, DeliveryError> {
        read_json(&self.dir.join(QUEUE_FILE)).await
    }

    pub async fn results(&self) -> Result<DeliveryResults, DeliveryError> {
        read_json(&self.dir.join(RESULTS_FILE)).await
    }

    pub async fn enqueue(&self, entry: DeliveryEntry) -> Result<DeliveryEntry, DeliveryError> {
        let path = self.dir.join(QUEUE_FILE);
        let mut queue: DeliveryQueue = read_json(&path).await?;
        queue.entries.push(entry.clone());
        if queue.entries.len() > QUEUE_LIMIT {
            let excess = queue.entries.len() - QUEUE_LIMIT;
            queue.entries.drain(..excess);
        }
        queue.updated_at = chrono::Utc::now().to_rfc3339();
        write_json(&path, &queue).await?;
        Ok(entry)
    }
}

async fn read_json<T>(path: &std::path::Path) -> Result<T, DeliveryError>
where
    T: Default + serde::de::DeserializeOwned,
{
    let contents = match tokio::fs::read_to_string(path).await {
        Ok(contents) => contents,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(T::default());
        }
        Err(source) => {
            return Err(DeliveryError::Read {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    if contents.trim().is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str(&contents).map_err(|source| DeliveryError::Parse {
        path: path.to_path_buf(),
        source,
    })
}

async fn write_json<T: Serialize>(path: &std::path::Path, value: &T) -> Result<(), DeliveryError> {
    let temporary = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(value).map_err(|source| DeliveryError::Parse {
        path: path.to_path_buf(),
        source,
    })?;
    tokio::fs::write(&temporary, body)
        .await
        .map_err(|source| DeliveryError::Write {
            path: temporary.clone(),
            source,
        })?;
    tokio::fs::rename(&temporary, path)
        .await
        .map_err(|source| DeliveryError::Write {
            path: path.to_path_buf(),
            source,
        })
}
