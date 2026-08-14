//! Safe-zone rectangles and the violation queue the sanctuary hook writes.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const CONFIG_FILE: &str = "safezone_config.json";
pub const VIOLATIONS_FILE: &str = "safezone_violations.json";

#[derive(Debug, thiserror::Error)]
pub enum SanctuaryError {
    #[error("safe-zone file {path} could not be read: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("safe-zone file {path} could not be written: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("safe-zone file {path} is not valid JSON: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SafeZoneConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub zones: Vec<SafeZone>,
}

impl Default for SafeZoneConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            zones: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SafeZone {
    pub id: String,
    pub name: String,
    pub x1: i32,
    pub y1: i32,
    pub x2: i32,
    pub y2: i32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ViolationExport {
    #[serde(default)]
    pub violations: Vec<RawViolation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawViolation {
    #[serde(default)]
    pub attacker: String,
    #[serde(default)]
    pub victim: String,
    #[serde(default)]
    pub zone_id: String,
    #[serde(default)]
    pub zone_name: String,
    pub attacker_x: Option<i32>,
    pub attacker_y: Option<i32>,
    #[serde(default)]
    pub strike_number: i32,
    /// `os.time()` — whole seconds, sometimes written with a Lua fraction.
    #[serde(default)]
    pub occurred_at: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct Sanctuary {
    dir: PathBuf,
}

impl Sanctuary {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub async fn config(&self) -> SafeZoneConfig {
        read_json(&self.dir.join(CONFIG_FILE))
            .await
            .unwrap_or_default()
    }

    pub async fn write_config(&self, config: &SafeZoneConfig) -> Result<(), SanctuaryError> {
        write_json(&self.dir.join(CONFIG_FILE), config).await
    }

    /// Take the queued incidents and empty the file so the next flush is new.
    pub async fn take_violations(&self) -> Result<Vec<RawViolation>, SanctuaryError> {
        let path = self.dir.join(VIOLATIONS_FILE);
        let export: ViolationExport = read_json(&path).await.unwrap_or_default();
        if export.violations.is_empty() {
            return Ok(Vec::new());
        }
        write_json(
            &path,
            &ViolationExport {
                violations: Vec::new(),
            },
        )
        .await?;
        Ok(export.violations)
    }
}

async fn read_json<T>(path: &Path) -> Result<T, SanctuaryError>
where
    T: Default + serde::de::DeserializeOwned,
{
    let contents = match tokio::fs::read_to_string(path).await {
        Ok(contents) => contents,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(T::default());
        }
        Err(source) => {
            return Err(SanctuaryError::Read {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    if contents.trim().is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str(&contents).map_err(|source| SanctuaryError::Parse {
        path: path.to_path_buf(),
        source,
    })
}

async fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), SanctuaryError> {
    let temporary = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(value).map_err(|source| SanctuaryError::Parse {
        path: path.to_path_buf(),
        source,
    })?;
    tokio::fs::write(&temporary, &body)
        .await
        .map_err(|source| SanctuaryError::Write {
            path: temporary.clone(),
            source,
        })?;
    tokio::fs::rename(&temporary, path)
        .await
        .map_err(|source| SanctuaryError::Write {
            path: path.to_path_buf(),
            source,
        })
}
