//! World archives: create, list, download, delete, roll back, import.
//!
//! A backup is a tar.gz of `Server/`, `Saves/` and `db/` from the PZ data
//! directory. Create and restore run in the background — they take longer than
//! the HTTP timeout — and the page polls [`job`] until the list updates.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, NaiveTime, Timelike, Utc};
use pz_bridge::DockerClient;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use tokio::process::Command;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const TYPES: &[&str] = &[
    "manual",
    "scheduled",
    "daily",
    "pre_rollback",
    "pre_update",
    "pre_import",
];

#[derive(Debug, Clone, Serialize)]
pub struct BackupJob {
    pub kind: String,
    pub started_at: DateTime<Utc>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Backup {
    pub id: Uuid,
    pub filename: String,
    pub path: String,
    pub size_bytes: i64,
    #[sqlx(rename = "type")]
    pub r#type: String,
    pub game_version: Option<String>,
    pub steam_branch: Option<String>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupView {
    pub id: Uuid,
    pub filename: String,
    pub size_bytes: i64,
    #[serde(rename = "type")]
    pub r#type: String,
    pub game_version: Option<String>,
    pub steam_branch: Option<String>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub size_human: String,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct BackupSettings {
    pub hourly_enabled: bool,
    pub daily_enabled: bool,
    pub daily_time: NaiveTime,
    pub retention_manual: i32,
    pub retention_scheduled: i32,
    pub retention_daily: i32,
    pub retention_pre_rollback: i32,
    pub retention_pre_update: i32,
    pub retention_pre_import: i32,
}

#[derive(Debug, Default, Deserialize)]
pub struct SchedulePatch {
    pub hourly_enabled: Option<bool>,
    pub daily_enabled: Option<bool>,
    pub daily_time: Option<String>,
    pub retention_manual: Option<i32>,
    pub retention_scheduled: Option<i32>,
    pub retention_daily: Option<i32>,
    pub retention_pre_rollback: Option<i32>,
    pub retention_pre_update: Option<i32>,
    pub retention_pre_import: Option<i32>,
}

#[derive(Debug, Default, Clone)]
pub struct JobSlot {
    pub current: Option<BackupJob>,
    pub last_error: Option<String>,
}

pub type JobLock = Arc<Mutex<JobSlot>>;

pub fn new_job_lock() -> JobLock {
    Arc::new(Mutex::new(JobSlot::default()))
}

pub async fn list(
    db: &PgPool,
    backup_path: &Path,
    backup_type: Option<&str>,
) -> Result<Vec<BackupView>, sqlx::Error> {
    let _ = adopt_disk_archives(db, backup_path).await;

    let rows = if let Some(kind) = backup_type.filter(|value| TYPES.contains(value)) {
        sqlx::query_as::<_, Backup>(
            r#"SELECT id, filename, path, size_bytes, "type", game_version, steam_branch, notes, created_at
             FROM backups WHERE "type" = $1 ORDER BY created_at DESC"#,
        )
        .bind(kind)
        .fetch_all(db)
        .await?
    } else {
        sqlx::query_as::<_, Backup>(
            r#"SELECT id, filename, path, size_bytes, "type", game_version, steam_branch, notes, created_at
             FROM backups ORDER BY created_at DESC"#,
        )
        .fetch_all(db)
        .await?
    };

    Ok(rows.into_iter().map(view).collect())
}

pub async fn get(db: &PgPool, id: Uuid) -> Result<Option<Backup>, sqlx::Error> {
    sqlx::query_as::<_, Backup>(
        r#"SELECT id, filename, path, size_bytes, "type", game_version, steam_branch, notes, created_at
         FROM backups WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

pub async fn settings(db: &PgPool) -> Result<BackupSettings, sqlx::Error> {
    sqlx::query_as::<_, BackupSettings>(
        "SELECT hourly_enabled, daily_enabled, daily_time,
                retention_manual, retention_scheduled, retention_daily,
                retention_pre_rollback, retention_pre_update, retention_pre_import
         FROM backup_settings WHERE id = 1",
    )
    .fetch_one(db)
    .await
}

pub async fn update_settings(db: &PgPool, patch: SchedulePatch) -> ApiResult<BackupSettings> {
    let current = settings(db).await?;

    let daily_time = if let Some(raw) = patch.daily_time.as_deref() {
        NaiveTime::parse_from_str(raw, "%H:%M")
            .or_else(|_| NaiveTime::parse_from_str(raw, "%H:%M:%S"))
            .map_err(|_| ApiError::Validation("Daily time must look like 04:00.".to_owned()))?
    } else {
        current.daily_time
    };

    fn retain(value: Option<i32>, fallback: i32) -> Result<i32, ApiError> {
        let number = value.unwrap_or(fallback);
        if (1..=200).contains(&number) {
            Ok(number)
        } else {
            Err(ApiError::Validation(
                "Keep between 1 and 200 copies of each kind.".to_owned(),
            ))
        }
    }

    sqlx::query(
        "UPDATE backup_settings SET
            hourly_enabled = $1,
            daily_enabled = $2,
            daily_time = $3,
            retention_manual = $4,
            retention_scheduled = $5,
            retention_daily = $6,
            retention_pre_rollback = $7,
            retention_pre_update = $8,
            retention_pre_import = $9
         WHERE id = 1",
    )
    .bind(patch.hourly_enabled.unwrap_or(current.hourly_enabled))
    .bind(patch.daily_enabled.unwrap_or(current.daily_enabled))
    .bind(daily_time)
    .bind(retain(patch.retention_manual, current.retention_manual)?)
    .bind(retain(patch.retention_scheduled, current.retention_scheduled)?)
    .bind(retain(patch.retention_daily, current.retention_daily)?)
    .bind(retain(patch.retention_pre_rollback, current.retention_pre_rollback)?)
    .bind(retain(patch.retention_pre_update, current.retention_pre_update)?)
    .bind(retain(patch.retention_pre_import, current.retention_pre_import)?)
    .execute(db)
    .await?;

    Ok(settings(db).await?)
}

pub async fn job(lock: &JobLock) -> Option<BackupJob> {
    lock.lock().await.current.clone()
}

pub async fn slot(lock: &JobLock) -> JobSlot {
    lock.lock().await.clone()
}

pub async fn record_error(state: &AppState, error: String) {
    tracing::error!(%error, "backup job failed");
    state.backup_job.lock().await.last_error = Some(error);
}

pub async fn start_create(state: AppState, notes: Option<String>) -> ApiResult<()> {
    claim_job(&state, "create", "Saving the world…").await?;
    tokio::spawn(async move {
        let result = create(&state, "manual", notes.as_deref()).await;
        finish_job(&state, result.err().map(|error| error.to_string())).await;
    });
    Ok(())
}

/// Archive the world and wait until the tar is on disk.
///
/// Used by the backup-then-restart cycle so the container is not torn down
/// mid-archive. The job slot is claimed so the backups page shows progress.
pub async fn create_now(
    state: &AppState,
    kind: &str,
    notes: Option<&str>,
) -> Result<(), String> {
    claim_job(state, "create", "Saving the world…")
        .await
        .map_err(|error| error.to_string())?;
    let result = create(state, kind, notes).await;
    finish_job(state, result.as_ref().err().cloned()).await;
    result
}

pub async fn start_rollback(state: AppState, id: Uuid) -> ApiResult<String> {
    let backup = get(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::Validation("That backup is gone.".to_owned()))?;
    validate_archive(&backup)?;
    let name = backup.filename.clone();
    claim_job(&state, "rollback", &format!("Restoring {name}…")).await?;
    tokio::spawn(async move {
        let result = rollback(&state, backup).await;
        finish_job(&state, result.err().map(|error| error.to_string())).await;
    });
    Ok(name)
}

pub async fn start_import(state: AppState, upload: PathBuf) -> ApiResult<()> {
    claim_job(&state, "import", "Checking the uploaded world…").await?;
    tokio::spawn(async move {
        let result = import_world(&state, &upload).await;
        if upload.exists() {
            let _ = std::fs::remove_file(&upload);
        }
        finish_job(&state, result.err().map(|error| error.to_string())).await;
    });
    Ok(())
}

pub async fn delete(db: &PgPool, id: Uuid) -> ApiResult<String> {
    let backup = get(db, id)
        .await?
        .ok_or_else(|| ApiError::Validation("That backup is gone.".to_owned()))?;
    if Path::new(&backup.path).exists() {
        std::fs::remove_file(&backup.path)
            .map_err(|error| ApiError::Internal(format!("could not delete the archive: {error}")))?;
    }
    sqlx::query("DELETE FROM backups WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(backup.filename)
}

/// What a bulk delete actually managed.
///
/// Two counts rather than one total, because the bare total is what let this
/// fail quietly: a batch in which every archive refused to unlink came back as
/// `Ok(0)` and was reported to the admin as a finished delete.
pub struct BulkDeleteOutcome {
    pub deleted: u64,
    pub failed: u64,
}

impl BulkDeleteOutcome {
    /// Nothing went at all. The caller should surface the underlying error
    /// rather than a count.
    pub fn total_failure(&self) -> bool {
        self.deleted == 0 && self.failed > 0
    }

    /// Wording for the admin. A batch that left archives behind says so.
    pub fn message(&self) -> String {
        if self.failed == 0 {
            format!("Deleted {} backup(s)", self.deleted)
        } else {
            format!(
                "Deleted {} of {} \u{2014} {} could not be removed.",
                self.deleted,
                self.deleted + self.failed,
                self.failed
            )
        }
    }
}

pub async fn delete_many(db: &PgPool, ids: &[Uuid]) -> ApiResult<BulkDeleteOutcome> {
    let mut outcome = BulkDeleteOutcome { deleted: 0, failed: 0 };
    let mut first_error = None;

    for id in ids {
        match delete(db, *id).await {
            Ok(_) => outcome.deleted += 1,
            Err(error) => {
                outcome.failed += 1;
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }

    // One stubborn archive should not sink the rest of the batch, but a batch
    // that removed nothing is a failure and has to reach the admin as one.
    if outcome.total_failure()
        && let Some(error) = first_error {
            return Err(error);
        }

    Ok(outcome)
}

#[derive(Debug, Clone, Serialize)]
pub struct ArchiveEntry {
    pub path: String,
    pub size_bytes: u64,
    pub dir: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArchiveListing {
    pub entries: Vec<ArchiveEntry>,
    pub file_count: usize,
    pub dir_count: usize,
}

pub fn contents(backup: &Backup) -> ApiResult<ArchiveListing> {
    validate_archive(backup)?;

    let output = std::process::Command::new("tar")
        .args(["-tvzf", &backup.path])
        .output()
        .map_err(|error| ApiError::Internal(format!("tar list failed: {error}")))?;
    if !output.status.success() {
        return Err(ApiError::Validation(
            "That file is not a readable tar.gz.".to_owned(),
        ));
    }

    let mut entries = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(entry) = parse_tv_line(line) {
            entries.push(entry);
        }
    }

    let file_count = entries.iter().filter(|entry| !entry.dir).count();
    let dir_count = entries.iter().filter(|entry| entry.dir).count();
    Ok(ArchiveListing {
        entries,
        file_count,
        dir_count,
    })
}

const EDITOR_MAX_BYTES: usize = 8 * 1024 * 1024;

const TEXT_EXTENSIONS: &[&str] = &[
    "ini", "lua", "txt", "json", "xml", "cfg", "log", "md", "csv", "yml", "yaml", "toml",
    "properties", "conf", "example",
];

const BINARY_EXTENSIONS: &[&str] = &[
    "bin", "db", "sqlite", "sqlite3", "dat", "png", "jpg", "jpeg", "gif", "webp", "zip", "gz",
    "7z", "tga", "dds",
];

#[derive(Debug, Clone, Serialize)]
pub struct ArchiveFile {
    pub path: String,
    pub name: String,
    pub language: String,
    pub size_bytes: u64,
    pub truncated: bool,
    pub content: String,
}

pub fn read_entry(backup: &Backup, requested: &str) -> ApiResult<ArchiveFile> {
    let path = sanitize_entry_path(requested)?;
    validate_archive(backup)?;

    if extension_is(BINARY_EXTENSIONS, &path) {
        return Err(ApiError::Validation(
            "That file is binary. It cannot be opened as text.".to_owned(),
        ));
    }

    let size_bytes = listed_size(backup, &path).unwrap_or(0);

    let mut child = std::process::Command::new("tar")
        .args(["-xOf", &backup.path, "--", &path])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| ApiError::Internal(format!("tar extract failed: {error}")))?;

    let mut stdout = child.stdout.take().ok_or_else(|| {
        ApiError::Internal("tar produced no output".to_owned())
    })?;

    let mut buf = Vec::new();
    let mut chunk = [0_u8; 64 * 1024];
    let mut truncated = false;
    loop {
        let read = stdout
            .read(&mut chunk)
            .map_err(|error| ApiError::Internal(format!("tar read failed: {error}")))?;
        if read == 0 {
            break;
        }
        let room = EDITOR_MAX_BYTES.saturating_sub(buf.len());
        if room == 0 {
            truncated = true;
            break;
        }
        let take = read.min(room);
        buf.extend_from_slice(&chunk[..take]);
        if take < read {
            truncated = true;
            break;
        }
    }
    drop(stdout);
    if truncated {
        let _ = child.kill();
    }
    let status = child
        .wait()
        .map_err(|error| ApiError::Internal(format!("tar extract failed: {error}")))?;
    if !truncated && !status.success() && buf.is_empty() {
        return Err(ApiError::Validation(
            "That file is not in the archive.".to_owned(),
        ));
    }

    if looks_binary(&buf) {
        return Err(ApiError::Validation(
            "That file is not text.".to_owned(),
        ));
    }

    let content = String::from_utf8(buf)
        .or_else(|error| {
            let valid = error.utf8_error().valid_up_to();
            String::from_utf8(error.into_bytes()[..valid].to_vec())
        })
        .map_err(|_| ApiError::Validation("That file is not valid text.".to_owned()))?;

    let name = path
        .rsplit('/')
        .next()
        .unwrap_or(path.as_str())
        .to_owned();

    Ok(ArchiveFile {
        language: language_for(&path),
        size_bytes: if size_bytes > 0 {
            size_bytes
        } else {
            content.len() as u64
        },
        path,
        name,
        truncated,
        content,
    })
}

fn listed_size(backup: &Backup, path: &str) -> Option<u64> {
    let output = std::process::Command::new("tar")
        .args(["-tvzf", &backup.path, "--", path])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(parse_tv_line)
        .map(|entry| entry.size_bytes)
}

fn sanitize_entry_path(raw: &str) -> ApiResult<String> {
    let path = raw.trim().replace('\\', "/");
    if path.is_empty() || path.starts_with('/') || path.contains('\0') {
        return Err(ApiError::Validation("That path is not valid.".to_owned()));
    }
    if path
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(ApiError::Validation("That path is not valid.".to_owned()));
    }
    Ok(path)
}

fn extension_is(list: &[&str], path: &str) -> bool {
    path.rsplit_once('.')
        .map(|(_, ext)| list.iter().any(|item| item.eq_ignore_ascii_case(ext)))
        .unwrap_or(false)
}

fn language_for(path: &str) -> String {
    let ext = path
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "lua" => "lua",
        "ini" | "cfg" | "conf" | "properties" => "ini",
        "json" => "json",
        "xml" => "xml",
        "yml" | "yaml" => "yaml",
        "md" => "markdown",
        "toml" => "toml",
        "log" | "txt" | "csv" => "plaintext",
        _ if TEXT_EXTENSIONS.contains(&ext.as_str()) => "plaintext",
        _ => "plaintext",
    }
    .to_owned()
}

fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.contains(&0) {
        return true;
    }
    let sample = &bytes[..bytes.len().min(8192)];
    let weird = sample
        .iter()
        .filter(|byte| {
            let value = **byte;
            value < 0x09 || (0x0e..0x20).contains(&value)
        })
        .count();
    sample.len() > 32 && weird * 20 > sample.len()
}

fn parse_tv_line(line: &str) -> Option<ArchiveEntry> {
    let dir = line.starts_with('d');
    let mut parts = line.split_whitespace();
    let _mode = parts.next()?;
    let _owner = parts.next()?;
    let size_bytes = parts.next()?.parse().ok()?;
    let _date = parts.next()?;
    let _time = parts.next()?;
    let path = parts.collect::<Vec<_>>().join(" ");
    let path = path.trim().trim_end_matches('/').to_string();
    if path.is_empty() || path.starts_with('/') || path.split('/').any(|part| part == "..") {
        return None;
    }
    Some(ArchiveEntry {
        path,
        size_bytes,
        dir,
    })
}

pub fn download_path(backup: &Backup, root: &Path) -> ApiResult<PathBuf> {
    let path = PathBuf::from(&backup.path);
    let canonical = path
        .canonicalize()
        .map_err(|_| ApiError::Validation("That archive is not on disk.".to_owned()))?;
    let root = root
        .canonicalize()
        .map_err(|_| ApiError::Internal("backup directory is missing".to_owned()))?;
    if !canonical.starts_with(&root) {
        return Err(ApiError::Forbidden);
    }
    Ok(canonical)
}

pub fn imports_dir(root: &Path) -> PathBuf {
    root.join("imports")
}

pub async fn tick_schedule(state: &AppState) {
    if job(&state.backup_job).await.is_some() {
        return;
    }

    let Ok(settings) = settings(&state.db).await else {
        return;
    };
    let now = Utc::now();

    if settings.hourly_enabled {
        let due = latest(&state.db, "scheduled")
            .await
            .ok()
            .flatten()
            .is_none_or(|stamp| now.signed_duration_since(stamp).num_hours() >= 4);
        if due {
            tracing::info!("starting the periodic backup");
            let _ = start_typed(state.clone(), "scheduled", Some("Periodic backup".into())).await;
            return;
        }
    }

    if settings.daily_enabled {
        let today = latest(&state.db, "daily")
            .await
            .ok()
            .flatten()
            .is_some_and(|stamp| stamp.date_naive() == now.date_naive());
        if !today && now.time().hour() == settings.daily_time.hour() && now.time().minute() == settings.daily_time.minute()
        {
            tracing::info!("starting the daily backup");
            let _ = start_typed(state.clone(), "daily", Some("Daily backup".into())).await;
        }
    }
}

async fn start_typed(state: AppState, kind: &'static str, notes: Option<String>) -> ApiResult<()> {
    claim_job(&state, "create", &format!("Writing a {kind} archive…")).await?;
    tokio::spawn(async move {
        let result = create(&state, kind, notes.as_deref()).await;
        finish_job(&state, result.err().map(|error| error.to_string())).await;
    });
    Ok(())
}

async fn create(state: &AppState, kind: &str, notes: Option<&str>) -> Result<(), String> {
    let _ = crate::services::admin::save_world(state).await;
    tokio::time::sleep(Duration::from_secs(3)).await;

    std::fs::create_dir_all(&state.config.backup_path)
        .map_err(|error| format!("cannot create the backup folder: {error}"))?;

    let stamp = Utc::now().format("%Y-%m-%d_%H-%M-%S");
    let filename = format!("backup_{kind}_{stamp}.tar.gz");
    let path = state.config.backup_path.join(&filename);
    let data = &state.config.data_path;

    let status = Command::new("tar")
        .args(["-czf"])
        .arg(&path)
        .arg("-C")
        .arg(data)
        .args(["Server", "Saves", "db"])
        .status()
        .await
        .map_err(|error| format!("tar failed to start: {error}"))?;

    if !status.success() && !path.exists() {
        return Err("tar did not write an archive".to_owned());
    }

    let size = std::fs::metadata(&path).map(|meta| meta.len() as i64).unwrap_or(0);
    let version = game_version(&state.config.lua_bridge_path);

    sqlx::query(
        r#"INSERT INTO backups (filename, path, size_bytes, "type", game_version, steam_branch, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
    )
    .bind(&filename)
    .bind(path.to_string_lossy().as_ref())
    .bind(size)
    .bind(kind)
    .bind(version)
    .bind(state.config.steam_branch.as_deref())
    .bind(notes)
    .execute(&state.db)
    .await
    .map_err(|error| error.to_string())?;

    prune(state, kind).await;
    Ok(())
}

async fn rollback(state: &AppState, backup: Backup) -> Result<(), String> {
    create(state, "pre_rollback", Some(&format!("Before restoring {}", backup.filename))).await?;

    let _ = crate::services::admin::save_world(state).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let docker = long_docker(state);
    docker
        .stop(30)
        .await
        .map_err(|error| format!("could not stop the server: {error}"))?;
    tokio::time::sleep(Duration::from_secs(3)).await;

    extract_archive(&backup, &state.config.data_path)?;

    docker
        .start()
        .await
        .map_err(|error| format!("could not start the server: {error}"))?;
    Ok(())
}

async fn import_world(state: &AppState, zip: &Path) -> Result<(), String> {
    let listing = list_zip(zip)?;
    if listing.is_empty() {
        return Err("that zip is empty".to_owned());
    }
    for entry in &listing {
        if entry.starts_with('/') || entry.split('/').any(|part| part == "..") {
            return Err("that zip has an unsafe path in it".to_owned());
        }
    }

    create(state, "pre_import", Some("Before importing a world")).await?;

    let docker = long_docker(state);
    let _ = crate::services::admin::save_world(state).await;
    docker
        .stop(30)
        .await
        .map_err(|error| format!("could not stop the server: {error}"))?;
    tokio::time::sleep(Duration::from_secs(3)).await;

    let result = extract_import(zip, &listing, &state.config.data_path, &state.config.server_name);
    let start = docker.start().await;
    result?;
    start.map_err(|error| format!("could not start the server: {error}"))?;
    Ok(())
}

fn extract_archive(backup: &Backup, data: &Path) -> Result<(), String> {
    validate_archive(backup).map_err(|error| error.to_string())?;

    let output = std::process::Command::new("tar")
        .args([
            "-xzf",
            &backup.path,
            "--overwrite",
            "--no-same-owner",
            "--no-same-permissions",
            "--touch",
            "-C",
        ])
        .arg(data)
        .output()
        .map_err(|error| format!("tar extract failed to start: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let fatal = stderr.lines().any(|line| {
        !line.is_empty()
            && !line.contains("Cannot utime")
            && !line.contains("Cannot change mode")
            && !line.contains("Exiting with failure status due to previous errors")
    });
    if fatal {
        return Err(format!("could not extract the archive: {stderr}"));
    }
    Ok(())
}

fn validate_archive(backup: &Backup) -> ApiResult<()> {
    if !Path::new(&backup.path).is_file() {
        return Err(ApiError::Validation("That archive is not on disk.".to_owned()));
    }
    let output = std::process::Command::new("tar")
        .args(["-tzf", &backup.path])
        .output()
        .map_err(|error| ApiError::Internal(format!("tar list failed: {error}")))?;
    if !output.status.success() {
        return Err(ApiError::Validation(
            "That file is not a readable tar.gz.".to_owned(),
        ));
    }
    let listing = String::from_utf8_lossy(&output.stdout);
    for entry in listing.lines() {
        if entry.starts_with('/') || entry.split('/').any(|part| part == "..") {
            return Err(ApiError::Validation(
                "That archive has an unsafe path in it.".to_owned(),
            ));
        }
    }
    Ok(())
}

fn list_zip(path: &Path) -> Result<Vec<String>, String> {
    let output = std::process::Command::new("unzip")
        .args(["-l"])
        .arg(path)
        .output()
        .map_err(|error| format!("unzip failed to start: {error}"))?;
    if !output.status.success() {
        return Err("that file is not a zip".to_owned());
    }
    let mut entries = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(caps) = line.split_whitespace().nth(3)
            && caps != "Name" && !caps.is_empty() {
                // unzip -l: length date time name — name may contain spaces.
                if let Some(name) = line.splitn(4, char::is_whitespace).last() {
                    let name = name.trim();
                    if name != "Name" && !name.is_empty() && !name.chars().all(|c| c == '-') {
                        entries.push(name.to_owned());
                    }
                }
            }
    }
    // Simpler parse: skip header/footer, take the remainder after the third column.
    let mut cleaned = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with(|c: char| c.is_ascii_digit()) {
            continue;
        }
        let mut parts = trimmed.splitn(4, |c: char| c.is_whitespace());
        let _len = parts.next();
        let _date = parts.next();
        let _time = parts.next();
        if let Some(name) = parts.next() {
            let name = name.trim();
            if !name.is_empty() {
                cleaned.push(name.to_owned());
            }
        }
    }
    if cleaned.is_empty() {
        Ok(entries)
    } else {
        Ok(cleaned)
    }
}

fn extract_import(zip: &Path, listing: &[String], data: &Path, server_name: &str) -> Result<(), String> {
    let has_saves = listing.iter().any(|entry| entry.starts_with("Saves/"));
    let has_server = listing.iter().any(|entry| entry.starts_with("Server/"));
    let has_db = listing.iter().any(|entry| entry.starts_with("db/"));
    let flat = listing.iter().any(|entry| {
        entry.starts_with("map_") || entry == "players.db" || entry.starts_with("worldZone-")
    });

    if !has_saves && !flat {
        if has_server || has_db {
            return Err("that zip has config but no save".to_owned());
        }
        return Err("that zip does not look like a PZ world".to_owned());
    }

    let temp = std::env::temp_dir().join(format!("pz_import_{}", Uuid::new_v4()));
    std::fs::create_dir_all(&temp).map_err(|error| error.to_string())?;

    let unzipped = std::process::Command::new("unzip")
        .args(["-o"])
        .arg(zip)
        .arg("-d")
        .arg(&temp)
        .status();

    let result = (|| {
        let status = unzipped.map_err(|error| error.to_string())?;
        if !status.success() && status.code().unwrap_or(2) >= 2 {
            return Err("could not unzip the world".to_owned());
        }
        let target = if has_saves || has_server {
            data.to_path_buf()
        } else {
            let dir = data.join("Saves").join("Multiplayer").join(server_name);
            std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
            dir
        };
        copy_tree(&temp, &target)
    })();

    let _ = std::fs::remove_dir_all(&temp);
    result
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(from).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let dest = to.join(entry.file_name());
        let source = entry.path();
        if source.is_dir() {
            std::fs::create_dir_all(&dest).map_err(|error| error.to_string())?;
            copy_tree(&source, &dest)?;
        } else {
            std::fs::copy(&source, &dest).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

async fn prune(state: &AppState, kind: &str) {
    let Ok(settings) = settings(&state.db).await else {
        return;
    };
    let keep = match kind {
        "manual" => settings.retention_manual,
        "scheduled" => settings.retention_scheduled,
        "daily" => settings.retention_daily,
        "pre_rollback" => settings.retention_pre_rollback,
        "pre_update" => settings.retention_pre_update,
        "pre_import" => settings.retention_pre_import,
        _ => 10,
    };
    let Ok(rows) = sqlx::query_as::<_, Backup>(
        r#"SELECT id, filename, path, size_bytes, "type", game_version, steam_branch, notes, created_at
         FROM backups WHERE "type" = $1 ORDER BY created_at DESC"#,
    )
    .bind(kind)
    .fetch_all(&state.db)
    .await
    else {
        return;
    };
    for backup in rows.into_iter().skip(keep as usize) {
        let _ = delete(&state.db, backup.id).await;
    }
}

async fn adopt_disk_archives(db: &PgPool, root: &Path) -> Result<(), sqlx::Error> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Ok(());
    };
    let known: Vec<String> = sqlx::query_scalar("SELECT filename FROM backups")
        .fetch_all(db)
        .await?;

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if known.iter().any(|existing| existing == &name) {
            continue;
        }
        let Some(kind) = parse_archive_name(&name) else {
            continue;
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let size = entry.metadata().map(|meta| meta.len() as i64).unwrap_or(0);
        sqlx::query(
            r#"INSERT INTO backups (filename, path, size_bytes, "type", notes)
             VALUES ($1, $2, $3, $4, $5)"#,
        )
        .bind(&name)
        .bind(path.to_string_lossy().as_ref())
        .bind(size)
        .bind(kind)
        .bind("Found on disk")
        .execute(db)
        .await?;
    }
    Ok(())
}

fn parse_archive_name(name: &str) -> Option<&'static str> {
    let stem = name.strip_prefix("backup_")?.strip_suffix(".tar.gz")?;
    TYPES.iter().copied().find(|kind| {
        stem.starts_with(kind)
            && stem
                .get(kind.len()..)
                .is_some_and(|rest| rest.starts_with('_') && rest.len() > 1)
    })
}

async fn latest(db: &PgPool, kind: &str) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT created_at FROM backups WHERE "type" = $1 ORDER BY created_at DESC LIMIT 1"#,
    )
    .bind(kind)
    .fetch_optional(db)
    .await
}

async fn claim_job(state: &AppState, kind: &str, detail: &str) -> ApiResult<()> {
    let mut slot = state.backup_job.lock().await;
    if slot.current.is_some() {
        return Err(ApiError::Conflict {
            field: "job",
            message: "A backup job is already running.".to_owned(),
        });
    }
    slot.current = Some(BackupJob {
        kind: kind.to_owned(),
        started_at: Utc::now(),
        detail: detail.to_owned(),
    });
    slot.last_error = None;
    Ok(())
}

async fn finish_job(state: &AppState, error: Option<String>) {
    let mut slot = state.backup_job.lock().await;
    slot.current = None;
    if let Some(error) = error {
        tracing::error!(%error, "backup job failed");
        slot.last_error = Some(error);
    }
}

fn long_docker(state: &AppState) -> DockerClient {
    DockerClient::new(
        &state.config.docker_proxy_url,
        &state.config.game_server_container,
        Duration::from_secs(45),
    )
}

fn game_version(lua_dir: &Path) -> Option<String> {
    let body = std::fs::read_to_string(lua_dir.join("game_state.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&body).ok()?;
    json.get("game_version")
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
}

fn view(backup: Backup) -> BackupView {
    let missing = !Path::new(&backup.path).is_file();
    BackupView {
        id: backup.id,
        filename: backup.filename,
        size_bytes: backup.size_bytes,
        r#type: backup.r#type,
        game_version: backup.game_version,
        steam_branch: backup.steam_branch,
        notes: backup.notes,
        created_at: backup.created_at,
        size_human: human_size(backup.size_bytes),
        missing,
    }
}

fn human_size(bytes: i64) -> String {
    let mut size = bytes as f64;
    let units = ["B", "KB", "MB", "GB"];
    let mut unit = 0;
    while size >= 1024.0 && unit < units.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    format!("{size:.1} {}", units[unit])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_batch_that_removed_nothing_is_not_a_success() {
        let outcome = BulkDeleteOutcome { deleted: 0, failed: 4 };

        assert!(outcome.total_failure());
    }

    #[test]
    fn a_batch_that_removed_everything_is_a_success() {
        let outcome = BulkDeleteOutcome { deleted: 4, failed: 0 };

        assert!(!outcome.total_failure());
        assert_eq!(outcome.message(), "Deleted 4 backup(s)");
    }

    #[test]
    fn a_partly_removed_batch_says_how_many_were_left_behind() {
        let outcome = BulkDeleteOutcome { deleted: 3, failed: 2 };

        assert!(!outcome.total_failure());
        assert_eq!(outcome.message(), "Deleted 3 of 5 — 2 could not be removed.");
    }
}
