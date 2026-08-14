//! Timed jobs that run staff actions without someone at the keyboard.

use std::collections::BTreeMap;
use std::time::Duration;

use chrono::{DateTime, Local, Timelike, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::services::{admin, backups};
use crate::state::AppState;

const ACTIONS: &[&str] = &[
    "restart",
    "start",
    "stop",
    "save",
    "backup",
    "broadcast",
    "rcon",
    "whitelist_open",
    "whitelist_close",
    "config",
    "kick_all",
    "rollback",
    "cycle",
    "chopper",
    "gunshot",
    "rain_start",
    "rain_stop",
    "thunder",
];
const KINDS: &[&str] = &["times", "every"];
const MAX_AUTOMATIONS: i64 = 30;
const MAX_TIMES: usize = 8;
const MAX_RUNS_KEPT: i64 = 40;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Automation {
    pub id: Uuid,
    pub name: String,
    pub enabled: bool,
    pub action: String,
    pub message: Option<String>,
    pub warn_seconds: i32,
    pub warn_message: Option<String>,
    pub schedule_kind: String,
    pub times: Vec<String>,
    pub every_minutes: Option<i32>,
    pub last_run_at: Option<DateTime<Utc>>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub last_slot: Option<String>,
    pub pending_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AutomationView {
    #[serde(flatten)]
    pub automation: Automation,
    pub next_run_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct AutomationRun {
    pub id: Uuid,
    pub automation_id: Uuid,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct AutomationPatch {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub action: Option<String>,
    pub message: Option<String>,
    pub warn_seconds: Option<i32>,
    pub warn_message: Option<String>,
    pub schedule_kind: Option<String>,
    pub times: Option<Vec<String>>,
    pub every_minutes: Option<i32>,
}

pub async fn list(db: &PgPool) -> Result<Vec<AutomationView>, sqlx::Error> {
    let rows = sqlx::query_as::<_, Automation>(
        r#"SELECT id, name, enabled, action, message, warn_seconds, warn_message,
                  schedule_kind, times, every_minutes, last_run_at, last_status,
                  last_error, last_slot, pending_at, created_at
           FROM automations ORDER BY created_at ASC"#,
    )
    .fetch_all(db)
    .await?;

    Ok(rows.into_iter().map(view).collect())
}

pub async fn get(db: &PgPool, id: Uuid) -> Result<Option<Automation>, sqlx::Error> {
    sqlx::query_as::<_, Automation>(
        r#"SELECT id, name, enabled, action, message, warn_seconds, warn_message,
                  schedule_kind, times, every_minutes, last_run_at, last_status,
                  last_error, last_slot, pending_at, created_at
           FROM automations WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

pub async fn runs(db: &PgPool, id: Uuid) -> Result<Vec<AutomationRun>, sqlx::Error> {
    sqlx::query_as::<_, AutomationRun>(
        r#"SELECT id, automation_id, started_at, finished_at, status, detail
           FROM automation_runs WHERE automation_id = $1
           ORDER BY started_at DESC LIMIT 40"#,
    )
    .bind(id)
    .fetch_all(db)
    .await
}

pub async fn create(db: &PgPool, body: AutomationPatch) -> ApiResult<AutomationView> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM automations")
        .fetch_one(db)
        .await?;
    if count >= MAX_AUTOMATIONS {
        return Err(ApiError::Validation(
            "Thirty automations is the limit.".to_owned(),
        ));
    }

    let draft = normalised(body, None)?;
    sqlx::query(
        r#"INSERT INTO automations
            (name, enabled, action, message, warn_seconds, warn_message,
             schedule_kind, times, every_minutes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)"#,
    )
    .bind(&draft.name)
    .bind(draft.enabled)
    .bind(&draft.action)
    .bind(&draft.message)
    .bind(draft.warn_seconds)
    .bind(&draft.warn_message)
    .bind(&draft.schedule_kind)
    .bind(&draft.times)
    .bind(draft.every_minutes)
    .execute(db)
    .await?;

    let row = sqlx::query_as::<_, Automation>(
        r#"SELECT id, name, enabled, action, message, warn_seconds, warn_message,
                  schedule_kind, times, every_minutes, last_run_at, last_status,
                  last_error, last_slot, pending_at, created_at
           FROM automations ORDER BY created_at DESC LIMIT 1"#,
    )
    .fetch_one(db)
    .await?;
    Ok(view(row))
}

pub async fn update(db: &PgPool, id: Uuid, body: AutomationPatch) -> ApiResult<AutomationView> {
    let current = get(db, id)
        .await?
        .ok_or_else(|| ApiError::Validation("That automation is gone.".to_owned()))?;
    let draft = normalised(body, Some(&current))?;

    sqlx::query(
        r#"UPDATE automations SET
            name = $2, enabled = $3, action = $4, message = $5,
            warn_seconds = $6, warn_message = $7, schedule_kind = $8,
            times = $9, every_minutes = $10,
            pending_at = CASE WHEN $3 THEN pending_at ELSE NULL END
           WHERE id = $1"#,
    )
    .bind(id)
    .bind(&draft.name)
    .bind(draft.enabled)
    .bind(&draft.action)
    .bind(&draft.message)
    .bind(draft.warn_seconds)
    .bind(&draft.warn_message)
    .bind(&draft.schedule_kind)
    .bind(&draft.times)
    .bind(draft.every_minutes)
    .execute(db)
    .await?;

    let row = get(db, id)
        .await?
        .ok_or_else(|| ApiError::Validation("That automation is gone.".to_owned()))?;
    Ok(view(row))
}

pub async fn delete(db: &PgPool, id: Uuid) -> ApiResult<()> {
    let result = sqlx::query("DELETE FROM automations WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::Validation("That automation is gone.".to_owned()));
    }
    Ok(())
}

pub async fn run_now(state: &AppState, id: Uuid) -> ApiResult<AutomationView> {
    let automation = get(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::Validation("That automation is gone.".to_owned()))?;
    fire(state, &automation).await;
    let row = get(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::Validation("That automation is gone.".to_owned()))?;
    Ok(view(row))
}

pub async fn tick(state: &AppState) {
    let Ok(rows) = list(&state.db).await else {
        return;
    };
    let now = Utc::now();
    let local = Local::now();

    for item in rows {
        let automation = item.automation;
        if !automation.enabled {
            continue;
        }

        if let Some(pending) = automation.pending_at {
            if pending <= now {
                fire(state, &automation).await;
            }
            continue;
        }

        if !is_due(&automation, now, local) {
            continue;
        }

        let slot = current_slot(&automation, local);
        if automation.last_slot.as_deref() == slot.as_deref() && automation.schedule_kind == "times"
        {
            continue;
        }

        if let Some(key) = slot.as_deref() {
            let _ = sqlx::query("UPDATE automations SET last_slot = $2 WHERE id = $1")
                .bind(automation.id)
                .bind(key)
                .execute(&state.db)
                .await;
        }

        // Cycle does its own backup → warn → restart so the archive exists
        // before anyone is told the world is coming down.
        if automation.warn_seconds > 0 && automation.action != "cycle" {
            let warning = automation.warn_message.clone().unwrap_or_else(|| {
                default_warning(&automation.action, automation.warn_seconds)
            });
            let _ = admin::broadcast(state, &warning).await;
            let when = now + chrono::Duration::seconds(automation.warn_seconds.into());
            let _ = sqlx::query("UPDATE automations SET pending_at = $2 WHERE id = $1")
                .bind(automation.id)
                .bind(when)
                .execute(&state.db)
                .await;
            let _ = record_run(
                &state.db,
                automation.id,
                "warned",
                Some(&format!("Warning sent; fires in {}s", automation.warn_seconds)),
            )
            .await;
            continue;
        }

        fire(state, &automation).await;
    }
}

async fn fire(state: &AppState, automation: &Automation) {
    // Cycle waits on a full archive. Stamp last_run_at first so an interval
    // job cannot start a second cycle while the first is still tarring, then
    // run off the request/tick so neither hits the 15s HTTP ceiling.
    if automation.action == "cycle" {
        let _ = sqlx::query(
            r#"UPDATE automations SET
                last_run_at = now(),
                last_status = 'ok',
                last_error = NULL,
                pending_at = NULL
               WHERE id = $1"#,
        )
        .bind(automation.id)
        .execute(&state.db)
        .await;

        let state = state.clone();
        let automation = automation.clone();
        tokio::spawn(async move {
            finish(&state, &automation, execute(&state, &automation).await).await;
        });
        return;
    }

    let result = execute(state, automation).await;
    let _ = sqlx::query(
        r#"UPDATE automations SET
            last_run_at = now(),
            last_status = $2,
            last_error = CASE WHEN $2 = 'error' THEN $3 ELSE NULL END,
            pending_at = NULL
           WHERE id = $1"#,
    )
    .bind(automation.id)
    .bind(if result.is_ok() { "ok" } else { "error" })
    .bind(result.as_ref().err())
    .execute(&state.db)
    .await;

    finish(state, automation, result).await;
}

async fn finish(
    state: &AppState,
    automation: &Automation,
    result: Result<String, String>,
) {
    let (status, detail) = match &result {
        Ok(detail) => ("ok", Some(detail.as_str())),
        Err(error) => ("error", Some(error.as_str())),
    };

    if automation.action == "cycle" {
        let _ = sqlx::query(
            r#"UPDATE automations SET
                last_status = $2,
                last_error = CASE WHEN $2 = 'error' THEN $3 ELSE NULL END
               WHERE id = $1"#,
        )
        .bind(automation.id)
        .bind(status)
        .bind(detail)
        .execute(&state.db)
        .await;
    }

    let _ = record_run(&state.db, automation.id, status, detail).await;
}

async fn execute(state: &AppState, automation: &Automation) -> Result<String, String> {
    let message = automation.message.as_deref();
    match automation.action.as_str() {
        "restart" => admin::restart(state, message)
            .await
            .map(|_| "Server restart requested.".to_owned())
            .map_err(|error| error.to_string()),
        "start" => admin::start(state)
            .await
            .map(|_| "Server start requested.".to_owned())
            .map_err(|error| error.to_string()),
        "stop" => admin::stop(state, message)
            .await
            .map(|_| "Server stop requested.".to_owned())
            .map_err(|error| error.to_string()),
        "save" => admin::save_world(state)
            .await
            .map(|_| "World save requested.".to_owned())
            .map_err(|error| error.to_string()),
        "backup" => backups::start_create(state.clone(), message.map(ToOwned::to_owned))
            .await
            .map(|_| "Backup started.".to_owned())
            .map_err(|error| error.to_string()),
        "broadcast" => {
            let text = message
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Broadcast needs a message.".to_owned())?;
            admin::broadcast(state, text)
                .await
                .map(|_| "Broadcast sent.".to_owned())
                .map_err(|error| error.to_string())
        }
        "rcon" => {
            let command = message
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "RCON needs a command.".to_owned())?;
            admin::console(state, command)
                .await
                .map(|output| {
                    if output.trim().is_empty() {
                        "Command sent.".to_owned()
                    } else {
                        output
                    }
                })
                .map_err(|error| error.to_string())
        }
        "whitelist_open" => set_open(state, true).await,
        "whitelist_close" => set_open(state, false).await,
        "config" => patch_config(state, message).await,
        "kick_all" => kick_everyone(state, message).await,
        "rollback" => rollback_latest(state).await,
        "cycle" => cycle(state, automation).await,
        "chopper" => event(state, "chopper", "Helicopter event started.").await,
        "gunshot" => event(state, "gunshot", "Gunshot fired.").await,
        "rain_start" => event(state, "startrain", "Rain started.").await,
        "rain_stop" => event(state, "stoprain", "Rain stopped.").await,
        "thunder" => event(state, "thunder", "Thunder triggered.").await,
        other => Err(format!("unknown action {other}")),
    }
}

async fn set_open(state: &AppState, open: bool) -> Result<String, String> {
    let mut updates = BTreeMap::new();
    updates.insert("Open".to_owned(), if open { "true" } else { "false" }.to_owned());
    admin::write_config(state, updates)
        .await
        .map_err(|error| error.to_string())?;
    let written = if open {
        "Server is open to anyone."
    } else {
        "Server now requires the whitelist."
    };
    match admin::console(state, "reloadoptions").await {
        Ok(_) => Ok(format!("{written} Options reloaded.")),
        Err(_) => Ok(format!("{written} Reload when the server is up.")),
    }
}

async fn patch_config(state: &AppState, message: Option<&str>) -> Result<String, String> {
    let raw = message
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Config needs Key=Value.".to_owned())?;
    let (key, value) = raw
        .split_once('=')
        .ok_or_else(|| "Config needs Key=Value.".to_owned())?;
    let key = key.trim();
    if key.is_empty() {
        return Err("Config needs a setting name.".to_owned());
    }

    let mut updates = BTreeMap::new();
    updates.insert(key.to_owned(), value.trim().to_owned());
    admin::write_config(state, updates)
        .await
        .map_err(|error| error.to_string())?;
    match admin::console(state, "reloadoptions").await {
        Ok(_) => Ok(format!("{key} written and options reloaded.")),
        Err(_) => Ok(format!("{key} written. Reload when the server is up.")),
    }
}

async fn kick_everyone(state: &AppState, reason: Option<&str>) -> Result<String, String> {
    let names = state.status.current().await.players;
    if names.is_empty() {
        return Ok("Nobody is online.".to_owned());
    }

    let mut kicked = 0_usize;
    let mut failed = Vec::new();
    for name in &names {
        match admin::kick(state, name, reason).await {
            Ok(_) => kicked += 1,
            Err(error) => failed.push(format!("{name}: {error}")),
        }
    }

    if failed.is_empty() {
        Ok(format!("Kicked {kicked} player(s)."))
    } else {
        Err(format!(
            "Kicked {kicked}; failed {}: {}",
            failed.len(),
            failed.join("; ")
        ))
    }
}

async fn rollback_latest(state: &AppState) -> Result<String, String> {
    let archives = backups::list(&state.db, &state.config.backup_path, None)
        .await
        .map_err(|error| error.to_string())?;
    let latest = archives
        .iter()
        .find(|archive| !archive.missing)
        .ok_or_else(|| "No backups to restore.".to_owned())?;
    let name = latest.filename.clone();
    backups::start_rollback(state.clone(), latest.id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(format!("Restoring {name}…"))
}

async fn cycle(state: &AppState, automation: &Automation) -> Result<String, String> {
    let notes = automation
        .message
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Before scheduled restart");
    backups::create_now(state, "scheduled", Some(notes)).await?;

    if automation.warn_seconds > 0 {
        let warning = automation.warn_message.clone().unwrap_or_else(|| {
            default_warning("restart", automation.warn_seconds)
        });
        let _ = admin::broadcast(state, &warning).await;
        tokio::time::sleep(Duration::from_secs(automation.warn_seconds as u64)).await;
    }

    admin::restart(state, automation.message.as_deref())
        .await
        .map(|_| "Backup finished; server restart requested.".to_owned())
        .map_err(|error| error.to_string())
}

async fn event(state: &AppState, command: &str, ok: &str) -> Result<String, String> {
    admin::console(state, command)
        .await
        .map(|output| {
            if output.trim().is_empty() {
                ok.to_owned()
            } else {
                output
            }
        })
        .map_err(|error| error.to_string())
}

async fn record_run(
    db: &PgPool,
    automation_id: Uuid,
    status: &str,
    detail: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO automation_runs (automation_id, finished_at, status, detail)
           VALUES ($1, now(), $2, $3)"#,
    )
    .bind(automation_id)
    .bind(status)
    .bind(detail)
    .execute(db)
    .await?;

    sqlx::query(
        r#"DELETE FROM automation_runs
           WHERE id IN (
             SELECT id FROM automation_runs
             WHERE automation_id = $1
             ORDER BY started_at DESC
             OFFSET $2
           )"#,
    )
    .bind(automation_id)
    .bind(MAX_RUNS_KEPT)
    .execute(db)
    .await?;
    Ok(())
}

struct Draft {
    name: String,
    enabled: bool,
    action: String,
    message: Option<String>,
    warn_seconds: i32,
    warn_message: Option<String>,
    schedule_kind: String,
    times: Vec<String>,
    every_minutes: Option<i32>,
}

fn normalised(patch: AutomationPatch, current: Option<&Automation>) -> ApiResult<Draft> {
    let name = patch
        .name
        .or_else(|| current.map(|row| row.name.clone()))
        .unwrap_or_else(|| "New automation".to_owned());
    let name = name.trim().to_owned();
    if name.is_empty() || name.len() > 80 {
        return Err(ApiError::Validation(
            "Give the job a name of at most 80 characters.".to_owned(),
        ));
    }

    let action = patch
        .action
        .or_else(|| current.map(|row| row.action.clone()))
        .unwrap_or_else(|| "restart".to_owned());
    if !ACTIONS.contains(&action.as_str()) {
        return Err(ApiError::Validation("That action is not available.".to_owned()));
    }

    let schedule_kind = patch
        .schedule_kind
        .or_else(|| current.map(|row| row.schedule_kind.clone()))
        .unwrap_or_else(|| "times".to_owned());
    if !KINDS.contains(&schedule_kind.as_str()) {
        return Err(ApiError::Validation(
            "Schedule must be daily times or an interval.".to_owned(),
        ));
    }

    let times = clean_times(
        patch
            .times
            .or_else(|| current.map(|row| row.times.clone()))
            .unwrap_or_default(),
    )?;
    let every_minutes = patch.every_minutes.or(current.and_then(|row| row.every_minutes));

    if schedule_kind == "times" && times.is_empty() {
        return Err(ApiError::Validation(
            "Add at least one daily time.".to_owned(),
        ));
    }
    if schedule_kind == "every" {
        match every_minutes {
            Some(minutes) if (5..=10_080).contains(&minutes) => {}
            _ => {
                return Err(ApiError::Validation(
                    "Interval must be between 5 minutes and 7 days.".to_owned(),
                ));
            }
        }
    }

    let warn_seconds = patch
        .warn_seconds
        .or_else(|| current.map(|row| row.warn_seconds))
        .unwrap_or(0);
    if !(0..=3600).contains(&warn_seconds) {
        return Err(ApiError::Validation(
            "Warning must be between 0 and 3600 seconds.".to_owned(),
        ));
    }

    let message = optional_text(
        patch.message.or_else(|| current.and_then(|row| row.message.clone())),
        500,
        "Message",
    )?;
    if matches!(action.as_str(), "broadcast" | "rcon") && message.is_none() {
        return Err(ApiError::Validation(
            "That action needs a message or command.".to_owned(),
        ));
    }
    if action == "config" {
        let valid = message.as_deref().is_some_and(|raw| {
            raw.split_once('=')
                .is_some_and(|(key, _)| !key.trim().is_empty())
        });
        if !valid {
            return Err(ApiError::Validation("Config needs Key=Value.".to_owned()));
        }
    }

    let warn_message = optional_text(
        patch
            .warn_message
            .or_else(|| current.and_then(|row| row.warn_message.clone())),
        240,
        "Warning",
    )?;

    let every_minutes = if schedule_kind == "every" {
        every_minutes
    } else {
        None
    };

    Ok(Draft {
        name,
        enabled: patch.enabled.or(current.map(|row| row.enabled)).unwrap_or(true),
        action,
        message,
        warn_seconds,
        warn_message,
        schedule_kind,
        times,
        every_minutes,
    })
}

fn optional_text(
    value: Option<String>,
    max: usize,
    label: &str,
) -> ApiResult<Option<String>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > max {
        return Err(ApiError::Validation(format!(
            "{label} must be {max} characters or fewer."
        )));
    }
    Ok(Some(trimmed.to_owned()))
}

fn clean_times(raw: Vec<String>) -> ApiResult<Vec<String>> {
    let mut times = Vec::new();
    for item in raw {
        let value = item.trim();
        if value.is_empty() {
            continue;
        }
        if !is_hhmm(value) {
            return Err(ApiError::Validation(
                "Times must look like 04:00.".to_owned(),
            ));
        }
        if !times.iter().any(|existing: &String| existing == value) {
            times.push(value.to_owned());
        }
    }
    times.sort();
    if times.len() > MAX_TIMES {
        return Err(ApiError::Validation(
            "Eight daily times is the limit.".to_owned(),
        ));
    }
    Ok(times)
}

fn is_hhmm(value: &str) -> bool {
    let Some((hours, minutes)) = value.split_once(':') else {
        return false;
    };
    matches!(hours.parse::<u32>(), Ok(hour) if hour < 24)
        && matches!(minutes.parse::<u32>(), Ok(minute) if minute < 60)
        && hours.len() == 2
        && minutes.len() == 2
}

fn is_due(automation: &Automation, now: DateTime<Utc>, local: DateTime<Local>) -> bool {
    match automation.schedule_kind.as_str() {
        "every" => {
            let Some(minutes) = automation.every_minutes else {
                return false;
            };
            let stamp = automation.last_run_at.unwrap_or(automation.created_at);
            now.signed_duration_since(stamp).num_minutes() >= i64::from(minutes)
        }
        "times" => current_slot(automation, local)
            .is_some_and(|slot| automation.last_slot.as_deref() != Some(slot.as_str())),
        _ => false,
    }
}

fn current_slot(automation: &Automation, local: DateTime<Local>) -> Option<String> {
    if automation.schedule_kind != "times" {
        return None;
    }
    let stamp = format!("{:02}:{:02}", local.hour(), local.minute());
    if automation.times.iter().any(|time| time == &stamp) {
        Some(format!("{}T{stamp}", local.date_naive()))
    } else {
        None
    }
}

fn view(automation: Automation) -> AutomationView {
    let next_run_at = next_run(&automation);
    AutomationView {
        automation,
        next_run_at,
    }
}

fn next_run(automation: &Automation) -> Option<DateTime<Utc>> {
    if !automation.enabled {
        return None;
    }
    if let Some(pending) = automation.pending_at {
        return Some(pending);
    }
    let local = Local::now();
    match automation.schedule_kind.as_str() {
        "every" => {
            let minutes = automation.every_minutes?;
            Some(
                automation
                    .last_run_at
                    .unwrap_or_else(Utc::now)
                    + chrono::Duration::minutes(i64::from(minutes)),
            )
        }
        "times" => {
            if automation.times.is_empty() {
                return None;
            }
            let mut best: Option<DateTime<Local>> = None;
            for day in 0..2 {
                let date = local.date_naive() + chrono::Duration::days(day);
                for time in &automation.times {
                    let Some((hours, minutes)) = time.split_once(':') else {
                        continue;
                    };
                    let Ok(hour) = hours.parse::<u32>() else {
                        continue;
                    };
                    let Ok(minute) = minutes.parse::<u32>() else {
                        continue;
                    };
                    let Some(naive) = date.and_hms_opt(hour, minute, 0) else {
                        continue;
                    };
                    let Some(candidate) = naive.and_local_timezone(Local).single() else {
                        continue;
                    };
                    if candidate <= local {
                        continue;
                    }
                    if best.is_none_or(|current| candidate < current) {
                        best = Some(candidate);
                    }
                }
            }
            best.map(|stamp| stamp.with_timezone(&Utc))
        }
        _ => None,
    }
}

fn default_warning(action: &str, seconds: i32) -> String {
    let minutes = (seconds + 59) / 60;
    match action {
        "restart" => format!("Server restarting in {minutes} minute(s)"),
        "stop" => format!("Server stopping in {minutes} minute(s)"),
        "backup" => format!("Backup starting in {minutes} minute(s)"),
        "rollback" => format!("World restoring in {minutes} minute(s)"),
        "kick_all" => format!("Everyone will be kicked in {minutes} minute(s)"),
        "cycle" => format!("Server backing up, then restarting in {minutes} minute(s)"),
        _ => format!("Server action in {minutes} minute(s)"),
    }
}
