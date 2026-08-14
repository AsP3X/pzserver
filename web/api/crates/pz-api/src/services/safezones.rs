//! No-PvP rectangles. The live rules live in `safezone_config.json`; incidents
//! land in `safezone_violations.json` and are folded into Postgres.

use chrono::{DateTime, Utc};
use pz_bridge::sanctuary::{RawViolation, SafeZone, SafeZoneConfig, Sanctuary};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct SafeZoneView {
    pub config: SafeZoneConfig,
    pub violations: Vec<PvpViolation>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct PvpViolation {
    pub id: Uuid,
    pub attacker: String,
    pub victim: String,
    pub zone_id: String,
    pub zone_name: String,
    pub attacker_x: Option<i32>,
    pub attacker_y: Option<i32>,
    pub strike_number: i32,
    pub status: String,
    pub resolution_note: Option<String>,
    pub resolved_by: Option<String>,
    pub occurred_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct ZonePatch {
    pub id: Option<String>,
    pub name: Option<String>,
    pub x1: Option<i32>,
    pub y1: Option<i32>,
    pub x2: Option<i32>,
    pub y2: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct ConfigPatch {
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
pub struct ResolvePatch {
    pub status: String,
    pub note: Option<String>,
}

pub async fn view(state: &AppState) -> ApiResult<SafeZoneView> {
    import(state).await;
    Ok(SafeZoneView {
        config: store(state).config().await,
        violations: list_violations(&state.db).await?,
    })
}

pub async fn public_config(state: &AppState) -> SafeZoneConfig {
    store(state).config().await
}

pub async fn set_enabled(state: &AppState, enabled: bool) -> ApiResult<SafeZoneConfig> {
    let sanctuary = store(state);
    let mut config = sanctuary.config().await;
    config.enabled = enabled;
    sanctuary
        .write_config(&config)
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;
    Ok(config)
}

pub async fn add_zone(state: &AppState, patch: ZonePatch) -> ApiResult<SafeZoneConfig> {
    let zone = require_zone(patch)?;
    let sanctuary = store(state);
    let mut config = sanctuary.config().await;
    if config.zones.len() >= 40 {
        return Err(ApiError::Validation(
            "Forty zones is the most the map can usefully hold.".to_owned(),
        ));
    }
    if config
        .zones
        .iter()
        .any(|existing| existing.id.eq_ignore_ascii_case(&zone.id))
    {
        return Err(ApiError::Validation(
            "A zone with that id already exists.".to_owned(),
        ));
    }
    config.zones.push(zone);
    sanctuary
        .write_config(&config)
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;
    Ok(config)
}

pub async fn remove_zone(state: &AppState, zone_id: &str) -> ApiResult<SafeZoneConfig> {
    let sanctuary = store(state);
    let mut config = sanctuary.config().await;
    let before = config.zones.len();
    config
        .zones
        .retain(|zone| !zone.id.eq_ignore_ascii_case(zone_id.trim()));
    if config.zones.len() == before {
        return Err(ApiError::Validation("That zone is gone.".to_owned()));
    }
    sanctuary
        .write_config(&config)
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;
    Ok(config)
}

pub async fn resolve(
    db: &PgPool,
    id: Uuid,
    patch: ResolvePatch,
    resolved_by: &str,
) -> ApiResult<PvpViolation> {
    let status = patch.status.trim();
    if status != "dismissed" && status != "actioned" {
        return Err(ApiError::Validation(
            "A violation is dismissed or actioned.".to_owned(),
        ));
    }
    let note = patch
        .note
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(500).collect::<String>());

    let found = sqlx::query_as::<_, PvpViolation>(
        r#"UPDATE pvp_violations SET
            status = $2,
            resolution_note = $3,
            resolved_by = $4,
            resolved_at = now()
           WHERE id = $1
           RETURNING id, attacker, victim, zone_id, zone_name, attacker_x, attacker_y,
                     strike_number, status, resolution_note, resolved_by, occurred_at, resolved_at"#,
    )
    .bind(id)
    .bind(status)
    .bind(note)
    .bind(resolved_by)
    .fetch_optional(db)
    .await?;

    found.ok_or_else(|| ApiError::Validation("That violation is gone.".to_owned()))
}

pub async fn import(state: &AppState) {
    let sanctuary = store(state);
    let incoming = match sanctuary.take_violations().await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(error = %error, "safe-zone violations could not be read");
            return;
        }
    };
    for row in incoming {
        if let Err(error) = insert_violation(&state.db, row).await {
            tracing::warn!(error = %error, "safe-zone violation could not be stored");
        }
    }
}

fn store(state: &AppState) -> Sanctuary {
    Sanctuary::new(&state.config.lua_bridge_path)
}

async fn list_violations(db: &PgPool) -> Result<Vec<PvpViolation>, sqlx::Error> {
    sqlx::query_as::<_, PvpViolation>(
        r#"SELECT id, attacker, victim, zone_id, zone_name, attacker_x, attacker_y,
                  strike_number, status, resolution_note, resolved_by, occurred_at, resolved_at
           FROM pvp_violations
           ORDER BY occurred_at DESC
           LIMIT 120"#,
    )
    .fetch_all(db)
    .await
}

async fn insert_violation(db: &PgPool, row: RawViolation) -> Result<(), sqlx::Error> {
    let attacker = clean_name(&row.attacker, "unknown");
    let victim = clean_name(&row.victim, "unknown");
    let zone_name = clean_name(&row.zone_name, "unknown");
    let occurred = row
        .occurred_at
        .and_then(|stamp| DateTime::from_timestamp(stamp.trunc() as i64, 0))
        .unwrap_or_else(Utc::now);
    let strike = row.strike_number.max(1);

    sqlx::query(
        r#"INSERT INTO pvp_violations
            (attacker, victim, zone_id, zone_name, attacker_x, attacker_y,
             strike_number, occurred_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (attacker, victim, zone_id, occurred_at, strike_number) DO NOTHING"#,
    )
    .bind(attacker)
    .bind(victim)
    .bind(row.zone_id.trim())
    .bind(zone_name)
    .bind(row.attacker_x)
    .bind(row.attacker_y)
    .bind(strike)
    .bind(occurred)
    .execute(db)
    .await?;
    Ok(())
}

fn require_zone(patch: ZonePatch) -> ApiResult<SafeZone> {
    let name = patch
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::Validation("Give the zone a name.".to_owned()))?;
    if name.len() > 100 {
        return Err(ApiError::Validation(
            "The name must be at most 100 characters.".to_owned(),
        ));
    }
    let id = match patch.id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(raw) => require_id(raw)?.to_owned(),
        None => slugify(name),
    };
    let (x1, y1, x2, y2) = require_rect(patch.x1, patch.y1, patch.x2, patch.y2)?;
    Ok(SafeZone {
        id,
        name: name.to_owned(),
        x1,
        y1,
        x2,
        y2,
    })
}

fn require_id(raw: &str) -> ApiResult<&str> {
    if raw.len() > 50
        || !raw
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(ApiError::Validation(
            "Zone ids look like spawn or west-gate.".to_owned(),
        ));
    }
    Ok(raw)
}

fn require_rect(
    x1: Option<i32>,
    y1: Option<i32>,
    x2: Option<i32>,
    y2: Option<i32>,
) -> ApiResult<(i32, i32, i32, i32)> {
    let x1 = x1.ok_or_else(|| ApiError::Validation("Mark both corners.".to_owned()))?;
    let y1 = y1.ok_or_else(|| ApiError::Validation("Mark both corners.".to_owned()))?;
    let x2 = x2.ok_or_else(|| ApiError::Validation("Mark both corners.".to_owned()))?;
    let y2 = y2.ok_or_else(|| ApiError::Validation("Mark both corners.".to_owned()))?;
    for value in [x1, y1, x2, y2] {
        if !(-5_000..=40_000).contains(&value) {
            return Err(ApiError::Validation(
                "Those coordinates are off the map.".to_owned(),
            ));
        }
    }
    let west = x1.min(x2);
    let east = x1.max(x2);
    let north = y1.min(y2);
    let south = y1.max(y2);
    if east - west < 8 || south - north < 8 {
        return Err(ApiError::Validation(
            "Draw a larger rectangle. Eight tiles on a side is the smallest.".to_owned(),
        ));
    }
    Ok((west, north, east, south))
}

fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "zone".to_owned()
    } else {
        trimmed.chars().take(50).collect()
    }
}

fn clean_name(raw: &str, fallback: &str) -> String {
    let value = raw.trim();
    if value.is_empty() {
        fallback.to_owned()
    } else {
        value.chars().take(80).collect()
    }
}
