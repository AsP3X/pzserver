//! UI copy overrides. File dictionaries stay the defaults; a row here wins.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use std::collections::BTreeMap;

use crate::error::{ApiError, ApiResult};

const BUILTIN: &[&str] = &["en", "de"];

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Language {
    pub code: String,
    pub name: String,
    pub native_name: String,
    pub is_default: bool,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct LanguagePatch {
    pub code: Option<String>,
    pub name: Option<String>,
    pub native_name: Option<String>,
    pub is_default: Option<bool>,
    pub is_active: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct TranslationPut {
    pub locale: String,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct TranslationClear {
    pub locale: String,
    pub key: String,
}

#[derive(Debug, Deserialize)]
pub struct TranslationImport {
    pub locale: String,
    pub entries: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct Catalog {
    pub languages: Vec<Language>,
    pub overrides: BTreeMap<String, BTreeMap<String, String>>,
}

pub async fn languages(db: &PgPool, active_only: bool) -> Result<Vec<Language>, sqlx::Error> {
    if active_only {
        sqlx::query_as::<_, Language>(
            r#"SELECT code, name, native_name, is_default, is_active, created_at
               FROM ui_languages WHERE is_active
               ORDER BY is_default DESC, name"#,
        )
        .fetch_all(db)
        .await
    } else {
        sqlx::query_as::<_, Language>(
            r#"SELECT code, name, native_name, is_default, is_active, created_at
               FROM ui_languages
               ORDER BY is_default DESC, name"#,
        )
        .fetch_all(db)
        .await
    }
}

pub async fn overrides(db: &PgPool, locale: &str) -> Result<BTreeMap<String, String>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT key, value FROM ui_translations WHERE locale = $1",
    )
    .bind(locale.trim())
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().collect())
}

pub async fn catalog(db: &PgPool) -> ApiResult<Catalog> {
    let languages = languages(db, false).await?;
    let rows = sqlx::query_as::<_, (String, String, String)>(
        "SELECT locale, key, value FROM ui_translations ORDER BY locale, key",
    )
    .fetch_all(db)
    .await?;
    let mut overrides = BTreeMap::new();
    for (locale, key, value) in rows {
        overrides
            .entry(locale)
            .or_insert_with(BTreeMap::new)
            .insert(key, value);
    }
    Ok(Catalog {
        languages,
        overrides,
    })
}

pub async fn put(db: &PgPool, body: TranslationPut) -> ApiResult<()> {
    let locale = require_locale(&body.locale)?;
    let key = require_key(&body.key)?.to_owned();
    let value = body.value.trim();
    if value.is_empty() {
        return Err(ApiError::Validation("Write the translation.".to_owned()));
    }
    if value.len() > 5_000 {
        return Err(ApiError::Validation("That string is too long.".to_owned()));
    }
    ensure_language(db, &locale).await?;
    sqlx::query(
        r#"INSERT INTO ui_translations (locale, key, value, updated_at)
           VALUES ($1,$2,$3, now())
           ON CONFLICT (locale, key)
           DO UPDATE SET value = EXCLUDED.value, updated_at = now()"#,
    )
    .bind(locale)
    .bind(key)
    .bind(value)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn clear(db: &PgPool, body: TranslationClear) -> ApiResult<()> {
    let locale = require_locale(&body.locale)?;
    let key = require_key(&body.key)?;
    sqlx::query("DELETE FROM ui_translations WHERE locale = $1 AND key = $2")
        .bind(locale)
        .bind(key)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn import(db: &PgPool, body: TranslationImport) -> ApiResult<u32> {
    let locale = require_locale(&body.locale)?;
    ensure_language(db, &locale).await?;
    let mut count = 0u32;
    for (key, value) in &body.entries {
        if require_key(key).is_err() {
            continue;
        }
        let value = value.trim();
        if value.is_empty() || value.len() > 5_000 {
            continue;
        }
        sqlx::query(
            r#"INSERT INTO ui_translations (locale, key, value, updated_at)
               VALUES ($1,$2,$3, now())
               ON CONFLICT (locale, key)
               DO UPDATE SET value = EXCLUDED.value, updated_at = now()"#,
        )
        .bind(&locale)
        .bind(key)
        .bind(value)
        .execute(db)
        .await?;
        count += 1;
    }
    Ok(count)
}

pub async fn create_language(db: &PgPool, patch: LanguagePatch) -> ApiResult<Language> {
    let code = require_locale(patch.code.as_deref().unwrap_or(""))?;
    let name = patch
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::Validation("Give the language a name.".to_owned()))?;
    let native = patch
        .native_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(name);
    sqlx::query(
        r#"INSERT INTO ui_languages (code, name, native_name, is_active)
           VALUES ($1,$2,$3, true)"#,
    )
    .bind(&code)
    .bind(name)
    .bind(native)
    .execute(db)
    .await
    .map_err(|error| {
        if error.to_string().contains("ui_languages_pkey") {
            ApiError::Validation("That language already exists.".to_owned())
        } else {
            ApiError::from(error)
        }
    })?;
    get_language(db, &code).await
}

pub async fn update_language(db: &PgPool, code: &str, patch: LanguagePatch) -> ApiResult<Language> {
    let current = get_language(db, code).await?;
    if current.is_default && patch.is_active == Some(false) {
        return Err(ApiError::Validation(
            "The default language has to stay on.".to_owned(),
        ));
    }
    if patch.is_default == Some(true) {
        sqlx::query("UPDATE ui_languages SET is_default = false WHERE is_default")
            .execute(db)
            .await?;
    }
    sqlx::query(
        r#"UPDATE ui_languages SET
            name = $2,
            native_name = $3,
            is_default = $4,
            is_active = $5
           WHERE code = $1"#,
    )
    .bind(&current.code)
    .bind(
        patch
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&current.name),
    )
    .bind(
        patch
            .native_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&current.native_name),
    )
    .bind(patch.is_default.unwrap_or(current.is_default))
    .bind(patch.is_active.unwrap_or(current.is_active))
    .execute(db)
    .await?;
    get_language(db, &current.code).await
}

pub async fn delete_language(db: &PgPool, code: &str) -> ApiResult<()> {
    let current = get_language(db, code).await?;
    if current.is_default || BUILTIN.contains(&current.code.as_str()) {
        return Err(ApiError::Validation(
            "Built-in languages cannot be removed.".to_owned(),
        ));
    }
    sqlx::query("DELETE FROM ui_languages WHERE code = $1")
        .bind(&current.code)
        .execute(db)
        .await?;
    Ok(())
}

async fn get_language(db: &PgPool, code: &str) -> ApiResult<Language> {
    sqlx::query_as::<_, Language>(
        r#"SELECT code, name, native_name, is_default, is_active, created_at
           FROM ui_languages WHERE code = $1"#,
    )
    .bind(code.trim())
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError::Validation("That language is gone.".to_owned()))
}

async fn ensure_language(db: &PgPool, code: &str) -> ApiResult<()> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ui_languages WHERE code = $1)")
        .bind(code)
        .fetch_one(db)
        .await?;
    if !exists {
        return Err(ApiError::Validation("That language is not configured.".to_owned()));
    }
    Ok(())
}

fn require_locale(raw: &str) -> ApiResult<String> {
    let code = raw.trim().to_ascii_lowercase();
    if code.len() < 2
        || code.len() > 8
        || !code.chars().all(|ch| ch.is_ascii_lowercase() || ch == '-')
    {
        return Err(ApiError::Validation(
            "Language codes look like en or de.".to_owned(),
        ));
    }
    Ok(code)
}

fn require_key(raw: &str) -> ApiResult<&str> {
    let key = raw.trim();
    if key.is_empty() || key.len() > 120 || !key.contains('.') {
        return Err(ApiError::Validation(
            "Keys look like nav.wallet or economy.buy.".to_owned(),
        ));
    }
    Ok(key)
}
