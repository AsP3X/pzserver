//! The cash deposit queue shared with Knox Relay (`KR_Vault`).
//!
//! This stack writes `deposit_requests.json`. The mod strips every `Base.Money`
//! and `Base.MoneyBundle` off the named player and reports the tally in
//! `deposit_results.json`. Coin rates come from `money_deposit_config.json`,
//! which the admin panel owns.
//!
//! The ordering is items-first and the result file is the point of no return:
//! the mod only writes a result once the cash is actually gone, and rolls the
//! cash back if that write fails. So a result is proof the player paid, and the
//! wallet credit hangs off it — never off the request.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const REQUESTS_FILE: &str = "deposit_requests.json";
pub const RESULTS_FILE: &str = "deposit_results.json";
pub const RATES_FILE: &str = "money_deposit_config.json";

/// Matches `RESULT_LIMIT` in `KR_Vault.lua`. The mod trims its own ledger from
/// the front, so a request that is not resolved before this many deposits have
/// gone through will never find its result.
const REQUEST_LIMIT: usize = 200;

/// What the mod falls back to when the config file is missing, copied from
/// `rates()` in `KR_Vault.lua`. Kept in step so the panel shows the rates that
/// are actually being applied rather than a guess.
pub const DEFAULT_NOTE_VALUE: i64 = 1;
pub const DEFAULT_BUNDLE_VALUE: i64 = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepositRequests {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub requests: Vec<DepositRequest>,
}

impl Default for DepositRequests {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at: String::new(),
            requests: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepositRequest {
    pub id: String,
    pub username: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepositResults {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub results: Vec<DepositResult>,
}

impl Default for DepositResults {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at: String::new(),
            results: Vec::new(),
        }
    }
}

/// One finished deposit, as `KR_Vault` recorded it.
///
/// `stack_count` is the same number as `bundle_count` — the mod writes both so
/// that older readers keep working. We read `bundle_count` and ignore the
/// duplicate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepositResult {
    pub id: String,
    #[serde(default)]
    pub username: String,
    /// `success` or `failed`.
    pub status: String,
    #[serde(default)]
    pub money_count: i32,
    #[serde(default)]
    pub bundle_count: i32,
    #[serde(default)]
    pub total_coins: i64,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub processed_at: Option<String>,
}

impl DepositResult {
    pub fn succeeded(&self) -> bool {
        self.status == "success"
    }
}

/// Coins paid per note and per bundle.
///
/// Deserialised leniently because the mod accepts `stack_value` as an older
/// spelling of `bundle_value`, and a config written by the PHP panel may still
/// be on disk using it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DepositRates {
    pub money_value: i64,
    pub bundle_value: i64,
}

impl Default for DepositRates {
    fn default() -> Self {
        Self {
            money_value: DEFAULT_NOTE_VALUE,
            bundle_value: DEFAULT_BUNDLE_VALUE,
        }
    }
}

impl DepositRates {
    /// What `notes` and `bundles` are worth at these rates.
    pub fn value_of(&self, notes: i64, bundles: i64) -> i64 {
        notes * self.money_value + bundles * self.bundle_value
    }
}

/// The on-disk shape, which is looser than [`DepositRates`].
#[derive(Debug, Default, Deserialize)]
struct RatesFile {
    #[serde(default)]
    money_value: Option<i64>,
    #[serde(default)]
    bundle_value: Option<i64>,
    /// The spelling `KR_Vault` still accepts as a fallback.
    #[serde(default)]
    stack_value: Option<i64>,
}

/// What we write back. Both spellings are emitted so that downgrading the mod
/// does not silently reset the bundle rate to its default.
#[derive(Debug, Serialize)]
struct RatesOut {
    money_value: i64,
    bundle_value: i64,
    stack_value: i64,
}

fn one() -> u32 {
    1
}

#[derive(Debug, thiserror::Error)]
pub enum DepositError {
    #[error("deposit file {path} could not be read: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("deposit file {path} could not be written: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("deposit file {path} is not valid JSON: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone)]
pub struct DepositChannel {
    dir: PathBuf,
}

impl DepositChannel {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub async fn requests(&self) -> Result<DepositRequests, DepositError> {
        read_json(&self.dir.join(REQUESTS_FILE)).await
    }

    pub async fn results(&self) -> Result<DepositResults, DepositError> {
        read_json(&self.dir.join(RESULTS_FILE)).await
    }

    /// Queue a deposit for the mod to act on.
    ///
    /// Resolved requests are dropped as we go rather than accumulating: the
    /// mod skips anything that already has a result, so leaving them in the
    /// file only makes it re-read a longer list forever.
    pub async fn enqueue(&self, request: DepositRequest) -> Result<DepositRequest, DepositError> {
        let resolved = self
            .results()
            .await
            .map(|ledger| {
                ledger
                    .results
                    .into_iter()
                    .map(|result| result.id)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let path = self.dir.join(REQUESTS_FILE);
        let mut inbox: DepositRequests = read_json(&path).await?;

        inbox
            .requests
            .retain(|existing| !resolved.contains(&existing.id));
        inbox.requests.push(request.clone());

        if inbox.requests.len() > REQUEST_LIMIT {
            let excess = inbox.requests.len() - REQUEST_LIMIT;
            inbox.requests.drain(..excess);
        }

        inbox.updated_at = chrono::Utc::now().to_rfc3339();
        write_json(&path, &inbox).await?;

        Ok(request)
    }

    /// Drop a request the mod has not picked up yet.
    ///
    /// Returns whether anything was removed. A request that already has a
    /// result cannot be withdrawn — the cash is gone by then.
    pub async fn withdraw(&self, id: &str) -> Result<bool, DepositError> {
        let path = self.dir.join(REQUESTS_FILE);
        let mut inbox: DepositRequests = read_json(&path).await?;

        let before = inbox.requests.len();
        inbox.requests.retain(|request| request.id != id);

        if inbox.requests.len() == before {
            return Ok(false);
        }

        inbox.updated_at = chrono::Utc::now().to_rfc3339();
        write_json(&path, &inbox).await?;

        Ok(true)
    }

    /// Current coin rates, or the mod's own defaults when unconfigured.
    pub async fn rates(&self) -> Result<DepositRates, DepositError> {
        let file: RatesFile = read_json(&self.dir.join(RATES_FILE)).await?;

        Ok(DepositRates {
            money_value: file.money_value.unwrap_or(DEFAULT_NOTE_VALUE),
            bundle_value: file
                .bundle_value
                .or(file.stack_value)
                .unwrap_or(DEFAULT_BUNDLE_VALUE),
        })
    }

    pub async fn set_rates(&self, rates: DepositRates) -> Result<(), DepositError> {
        write_json(
            &self.dir.join(RATES_FILE),
            &RatesOut {
                money_value: rates.money_value,
                bundle_value: rates.bundle_value,
                stack_value: rates.bundle_value,
            },
        )
        .await
    }
}

async fn read_json<T>(path: &std::path::Path) -> Result<T, DepositError>
where
    T: Default + serde::de::DeserializeOwned,
{
    let contents = match tokio::fs::read_to_string(path).await {
        Ok(contents) => contents,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(T::default());
        }
        Err(source) => {
            return Err(DepositError::Read {
                path: path.to_path_buf(),
                source,
            });
        }
    };

    if contents.trim().is_empty() {
        return Ok(T::default());
    }

    serde_json::from_str(&contents).map_err(|source| DepositError::Parse {
        path: path.to_path_buf(),
        source,
    })
}

async fn write_json<T: Serialize>(path: &std::path::Path, value: &T) -> Result<(), DepositError> {
    let temporary = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(value).map_err(|source| DepositError::Parse {
        path: path.to_path_buf(),
        source,
    })?;

    tokio::fs::write(&temporary, body)
        .await
        .map_err(|source| DepositError::Write {
            path: temporary.clone(),
            source,
        })?;

    tokio::fs::rename(&temporary, path)
        .await
        .map_err(|source| DepositError::Write {
            path: path.to_path_buf(),
            source,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel() -> (tempfile::TempDir, DepositChannel) {
        let dir = tempfile::tempdir().expect("create temp dir");
        let channel = DepositChannel::new(dir.path());

        (dir, channel)
    }

    fn request(id: &str) -> DepositRequest {
        DepositRequest {
            id: id.to_owned(),
            username: "rook".to_owned(),
            status: "pending".to_owned(),
            created_at: "2026-08-17T09:00:00Z".to_owned(),
        }
    }

    #[tokio::test]
    async fn a_missing_queue_reads_as_empty() {
        let (_dir, channel) = channel();

        assert!(channel.requests().await.expect("read").requests.is_empty());
        assert!(channel.results().await.expect("read").results.is_empty());
    }

    #[tokio::test]
    async fn an_enqueued_request_comes_back() {
        let (_dir, channel) = channel();

        channel.enqueue(request("a")).await.expect("enqueue");
        let inbox = channel.requests().await.expect("read");

        assert_eq!(inbox.requests.len(), 1);
        assert_eq!(inbox.requests[0].id, "a");
        assert_eq!(inbox.requests[0].status, "pending");
    }

    /// The mod never runs a request twice, so leaving resolved ones in the file
    /// just grows it without bound.
    #[tokio::test]
    async fn enqueueing_prunes_requests_that_already_have_a_result() {
        let (dir, channel) = channel();

        channel.enqueue(request("done")).await.expect("enqueue");
        std::fs::write(
            dir.path().join(RESULTS_FILE),
            r#"{"version":1,"results":[{"id":"done","status":"success","total_coins":5}]}"#,
        )
        .expect("write results");

        channel.enqueue(request("fresh")).await.expect("enqueue");
        let inbox = channel.requests().await.expect("read");

        assert_eq!(inbox.requests.len(), 1);
        assert_eq!(inbox.requests[0].id, "fresh");
    }

    #[tokio::test]
    async fn a_pending_request_can_be_withdrawn() {
        let (_dir, channel) = channel();

        channel.enqueue(request("a")).await.expect("enqueue");

        assert!(channel.withdraw("a").await.expect("withdraw"));
        assert!(channel.requests().await.expect("read").requests.is_empty());
        assert!(
            !channel.withdraw("a").await.expect("withdraw"),
            "withdrawing twice must report that there was nothing to remove",
        );
    }

    #[tokio::test]
    async fn unconfigured_rates_match_the_mod_defaults() {
        let (_dir, channel) = channel();

        let rates = channel.rates().await.expect("rates");

        assert_eq!(rates.money_value, DEFAULT_NOTE_VALUE);
        assert_eq!(rates.bundle_value, DEFAULT_BUNDLE_VALUE);
    }

    /// `KR_Vault` accepts `stack_value` as an older spelling, and a config left
    /// behind by the PHP panel uses it.
    #[tokio::test]
    async fn the_older_stack_value_spelling_is_still_honoured() {
        let (dir, channel) = channel();
        std::fs::write(
            dir.path().join(RATES_FILE),
            r#"{"money_value":2,"stack_value":250}"#,
        )
        .expect("write rates");

        let rates = channel.rates().await.expect("rates");

        assert_eq!(rates.money_value, 2);
        assert_eq!(rates.bundle_value, 250);
    }

    #[tokio::test]
    async fn written_rates_carry_both_spellings() {
        let (dir, channel) = channel();

        channel
            .set_rates(DepositRates {
                money_value: 3,
                bundle_value: 300,
            })
            .await
            .expect("set rates");

        let body = std::fs::read_to_string(dir.path().join(RATES_FILE)).expect("read");

        assert!(body.contains(r#""bundle_value": 300"#));
        assert!(
            body.contains(r#""stack_value": 300"#),
            "an older mod reads stack_value and would otherwise fall back to 100",
        );
        assert_eq!(channel.rates().await.expect("rates").bundle_value, 300);
    }

    #[test]
    fn rates_price_a_mixed_handful_of_cash() {
        let rates = DepositRates {
            money_value: 2,
            bundle_value: 100,
        };

        assert_eq!(rates.value_of(7, 3), 314);
        assert_eq!(rates.value_of(0, 0), 0);
    }

    /// The mod writes `stack_count` alongside `bundle_count`. Reading a real
    /// result must not depend on which one it picked.
    #[test]
    fn a_result_written_by_the_mod_parses() {
        let result: DepositResult = serde_json::from_str(
            r#"{"id":"abc","username":"rook","status":"success","money_count":12,
                "stack_count":2,"bundle_count":2,"total_coins":212,
                "processed_at":"2026-08-17T09:00:00"}"#,
        )
        .expect("parse");

        assert!(result.succeeded());
        assert_eq!(result.money_count, 12);
        assert_eq!(result.bundle_count, 2);
        assert_eq!(result.total_coins, 212);
    }

    #[test]
    fn a_failed_result_carries_its_reason() {
        let result: DepositResult =
            serde_json::from_str(r#"{"id":"abc","status":"failed","message":"player not online"}"#)
                .expect("parse");

        assert!(!result.succeeded());
        assert_eq!(result.message.as_deref(), Some("player not online"));
        assert_eq!(result.total_coins, 0);
    }
}
