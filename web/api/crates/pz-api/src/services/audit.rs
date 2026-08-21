//! Who did what, from the admin API.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::ApiResult;
use crate::services::auth;
use crate::state::AppState;

const BODY_LIMIT: usize = 32 * 1024;
const DETAILS_CHARS: usize = 4_000;

const SECRET_KEYS: &[&str] = &[
    "password",
    "current_password",
    "password_confirmation",
    "api_key",
    "token",
    "secret",
    "rcon_password",
    "rconpassword",
];

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct AuditEntry {
    pub id: Uuid,
    pub actor_id: Option<Uuid>,
    pub actor: String,
    pub action: String,
    pub method: String,
    pub path: String,
    pub target: Option<String>,
    pub status: i32,
    pub details: Value,
    pub ip_address: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Default, Deserialize)]
pub struct AuditFilter {
    pub actor: Option<String>,
    pub action: Option<String>,
    pub target: Option<String>,
}

pub async fn list(db: &PgPool, filter: &AuditFilter) -> Result<Vec<AuditEntry>, sqlx::Error> {
    let actor = filter
        .actor
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let action = filter
        .action
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let target = filter
        .target
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    sqlx::query_as::<_, AuditEntry>(
        r#"SELECT id, actor_id, actor, action, method, path, target, status,
                  details, ip_address, created_at
           FROM audit_logs
           WHERE ($1::text IS NULL OR actor ILIKE '%' || $1 || '%')
             AND ($2::text IS NULL OR action = $2)
             AND ($3::text IS NULL OR target ILIKE '%' || $3 || '%')
           ORDER BY created_at DESC
           LIMIT 120"#,
    )
    .bind(actor)
    .bind(action)
    .bind(target)
    .fetch_all(db)
    .await
}

pub async fn actions(db: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT DISTINCT action FROM audit_logs ORDER BY action"#,
    )
    .fetch_all(db)
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn record(
    db: &PgPool,
    actor_id: Option<Uuid>,
    actor: &str,
    action: &str,
    method: &str,
    path: &str,
    target: Option<&str>,
    status: i32,
    details: Value,
    ip: Option<&str>,
) -> ApiResult<()> {
    sqlx::query(
        r#"INSERT INTO audit_logs
            (actor_id, actor, action, method, path, target, status, details, ip_address)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)"#,
    )
    .bind(actor_id)
    .bind(actor)
    .bind(action)
    .bind(method)
    .bind(path)
    .bind(target)
    .bind(status)
    .bind(details)
    .bind(ip)
    .execute(db)
    .await?;
    Ok(())
}

/// Capture a mutating admin request after it finishes.
pub async fn capture(
    axum::extract::State(state): axum::extract::State<AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();

    if !should_audit(method.as_str(), &path) {
        return next.run(request).await;
    }

    let ip = client_ip(request.headers());
    let token = session_token(request.headers());
    let content_type = request
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();

    let (parts, body) = request.into_parts();
    let collected = axum::body::to_bytes(body, BODY_LIMIT).await;
    let bytes = collected.unwrap_or_default();
    let details_body = summarise_body(&bytes, &content_type);
    let request = axum::extract::Request::from_parts(parts, axum::body::Body::from(bytes));

    let response = next.run(request).await;
    let status = i32::from(response.status().as_u16());

    if status == 401 {
        return response;
    }

    let (action, target) = classify(method.as_str(), &path);
    let actor = match token.as_deref() {
        Some(token) => auth::user_for_token(&state.db, token).await.ok().flatten(),
        None => None,
    };
    let actor_name = actor
        .as_ref()
        .map(|user| user.username.clone())
        .unwrap_or_else(|| "unknown".to_owned());
    let actor_id = actor.as_ref().map(|user| user.id);

    let mut details = Map::new();
    details.insert("status".into(), Value::from(status));
    if let Some(body) = details_body {
        details.insert("body".into(), body);
    }

    let db = state.db.clone();
    tokio::spawn(async move {
        if let Err(error) = record(
            &db,
            actor_id,
            &actor_name,
            &action,
            method.as_str(),
            &path,
            target.as_deref(),
            status,
            Value::Object(details),
            ip.as_deref(),
        )
        .await
        {
            tracing::warn!(%error, "could not write the audit log");
        }
    });

    response
}

fn should_audit(method: &str, path: &str) -> bool {
    if !matches!(method, "POST" | "PATCH" | "PUT" | "DELETE") {
        return false;
    }
    let admin = path.starts_with("/api/v1/admin/") || path.starts_with("/admin/");
    if !admin {
        return false;
    }
    if path.contains("/admin/audit") {
        return false;
    }
    if path.ends_with("/lookup") || path.ends_with("/contents") || path.ends_with("/file") {
        return false;
    }
    true
}

fn classify(method: &str, path: &str) -> (String, Option<String>) {
    let rest = path
        .strip_prefix("/api/v1/")
        .or_else(|| path.strip_prefix('/').map(|_| path.trim_start_matches('/')))
        .unwrap_or(path)
        .trim_matches('/');
    let parts: Vec<&str> = rest.split('/').collect();

    let action = match parts.as_slice() {
        ["admin", "players", name, verb] => {
            return (format!("player.{verb}"), Some((*name).to_owned()));
        }
        ["admin", "players", name, "items", verb] => {
            return (format!("player.item_{verb}"), Some((*name).to_owned()));
        }
        ["admin", "server", verb] => format!("server.{verb}"),
        ["admin", "broadcast"] => "server.broadcast".into(),
        ["admin", "console"] => "server.console".into(),
        ["admin", "config"] => "config.update".into(),
        ["admin", "mods"] if method == "POST" => "mods.add".into(),
        ["admin", "mods", "order"] => "mods.reorder".into(),
        ["admin", "mods", "import"] => "mods.import".into(),
        ["admin", "mods", id] if method == "DELETE" => {
            return ("mods.remove".into(), Some((*id).to_owned()));
        }
        ["admin", "whitelist"] => "whitelist.settings".into(),
        ["admin", "whitelist", name] if method == "POST" => {
            return ("whitelist.add".into(), Some((*name).to_owned()));
        }
        ["admin", "whitelist", name] if method == "DELETE" => {
            return ("whitelist.remove".into(), Some((*name).to_owned()));
        }
        ["admin", "reports", id] => {
            return ("reports.update".into(), Some((*id).to_owned()));
        }
        ["admin", "site"] => "site.update".into(),
        ["admin", "backups"] if method == "POST" => "backups.create".into(),
        ["admin", "backups"] if method == "DELETE" => "backups.delete".into(),
        ["admin", "backups", "schedule"] => "backups.schedule".into(),
        ["admin", "backups", "import"] => "backups.import".into(),
        ["admin", "backups", id] if method == "DELETE" => {
            return ("backups.delete".into(), Some((*id).to_owned()));
        }
        ["admin", "backups", id, "rollback"] => {
            return ("backups.rollback".into(), Some((*id).to_owned()));
        }
        ["admin", "automations"] if method == "POST" => "automations.create".into(),
        ["admin", "automations", id] if method == "PATCH" => {
            return ("automations.update".into(), Some((*id).to_owned()));
        }
        ["admin", "automations", id] if method == "DELETE" => {
            return ("automations.delete".into(), Some((*id).to_owned()));
        }
        ["admin", "automations", id, "run"] => {
            return ("automations.run".into(), Some((*id).to_owned()));
        }
        ["admin", "store"] if method == "POST" => "store.create".into(),
        ["admin", "store", id] if method == "PATCH" => {
            return ("store.update".into(), Some((*id).to_owned()));
        }
        ["admin", "store", id] if method == "DELETE" => {
            return ("store.delete".into(), Some((*id).to_owned()));
        }
        ["admin", "wallets", id] => {
            return ("wallet.adjust".into(), Some((*id).to_owned()));
        }
        ["admin", "auctions", id, "cancel"] => {
            return ("auction.cancel".into(), Some((*id).to_owned()));
        }
        _ => format!("{}:{path}", method.to_ascii_lowercase()),
    };

    (action, None)
}

fn summarise_body(bytes: &[u8], content_type: &str) -> Option<Value> {
    if bytes.is_empty() {
        return None;
    }
    if content_type.contains("multipart/") {
        return Some(Value::String("multipart upload".into()));
    }
    let text = String::from_utf8_lossy(bytes);
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::String(text.to_string()));
    Some(redact(parsed))
}

fn redact(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, child) in map {
                if SECRET_KEYS.iter().any(|secret| key.eq_ignore_ascii_case(secret)) {
                    out.insert(key, Value::String("[redacted]".into()));
                } else {
                    out.insert(key, redact(child));
                }
            }
            let encoded = Value::Object(out);
            let dump = encoded.to_string();
            if dump.len() > DETAILS_CHARS {
                Value::String(format!("{}…", &dump[..DETAILS_CHARS]))
            } else {
                encoded
            }
        }
        other => other,
    }
}

fn client_ip(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn session_token(headers: &axum::http::HeaderMap) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    raw.split(';')
        .filter_map(|part| {
            let (name, value) = part.split_once('=')?;
            (name.trim() == crate::extract::SESSION_COOKIE).then(|| value.trim().to_owned())
        })
        .next()
}
