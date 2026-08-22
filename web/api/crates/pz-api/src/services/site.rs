//! The singleton row that drives the public site's copy and branding.

use serde::Serialize;
use serde_json::Value;
use sqlx::{FromRow, PgPool};

use crate::error::ApiError;

/// Locale the stored columns themselves are written in.
pub const SOURCE_LOCALE: &str = "en";

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct SiteSettings {
    pub site_name: String,
    pub hero_badge: String,
    pub hero_title: String,
    pub hero_subtitle: String,
    pub hero_description: String,
    pub hero_cta_label: String,
    pub footer_text: String,
    pub features: Value,
    pub connect_host: Option<String>,
    pub connect_port: i32,
    pub discord_url: Option<String>,
    pub default_locale: String,

    /// Per-locale overrides. Applied before the response is built, so the UI
    /// never sees this.
    #[serde(skip)]
    pub translations: Value,
}

impl Default for SiteSettings {
    fn default() -> Self {
        Self {
            site_name: "Knox County".to_owned(),
            hero_badge: String::new(),
            hero_title: "Knox County".to_owned(),
            hero_subtitle: String::new(),
            hero_description: String::new(),
            hero_cta_label: "Join the server".to_owned(),
            footer_text: String::new(),
            features: Value::Array(Vec::new()),
            connect_host: None,
            connect_port: 16261,
            discord_url: None,
            default_locale: SOURCE_LOCALE.to_owned(),
            translations: Value::Object(serde_json::Map::new()),
        }
    }
}

impl SiteSettings {
    /// Overlay the copy for `locale` onto the source columns.
    ///
    /// Field by field rather than wholesale: a translation that covers only the
    /// hero still leaves the rest readable in the source language instead of
    /// blanking it.
    fn localise(&mut self, locale: &str) {
        if locale == SOURCE_LOCALE {
            return;
        }

        let Some(overrides) = self
            .translations
            .get(locale)
            .and_then(Value::as_object)
            .cloned()
        else {
            return;
        };

        let text = |key: &str| {
            overrides
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };

        let fields: [(&str, &mut String); 7] = [
            ("site_name", &mut self.site_name),
            ("hero_badge", &mut self.hero_badge),
            ("hero_title", &mut self.hero_title),
            ("hero_subtitle", &mut self.hero_subtitle),
            ("hero_description", &mut self.hero_description),
            ("hero_cta_label", &mut self.hero_cta_label),
            ("footer_text", &mut self.footer_text),
        ];

        for (key, target) in fields {
            if let Some(translated) = text(key) {
                *target = translated;
            }
        }

        if let Some(features) = overrides.get("features").filter(|value| value.is_array()) {
            self.features = features.clone();
        }
    }
}

/// Load the singleton in `locale`, falling back to defaults if the row has been
/// deleted.
///
/// The migration seeds row 1, so the fallback only matters if someone clears
/// the table by hand — and a public landing page should still render if they do.
pub async fn settings(db: &PgPool, locale: &str) -> Result<SiteSettings, sqlx::Error> {
    let settings = sqlx::query_as::<_, SiteSettings>(
        r#"
        SELECT site_name, hero_badge, hero_title, hero_subtitle, hero_description,
               hero_cta_label, footer_text, features, connect_host, connect_port,
               discord_url, default_locale, translations
        FROM site_settings
        WHERE id = 1
        "#,
    )
    .fetch_optional(db)
    .await?;

    let mut settings = settings.unwrap_or_default();
    settings.localise(locale);

    Ok(settings)
}

/// Fields an administrator can change. Absent values are left alone.
pub struct SitePatch {
    pub site_name: Option<String>,
    pub hero_badge: Option<String>,
    pub hero_title: Option<String>,
    pub hero_subtitle: Option<String>,
    pub hero_description: Option<String>,
    pub hero_cta_label: Option<String>,
    pub footer_text: Option<String>,
    pub connect_host: Option<String>,
    pub connect_port: Option<i32>,
    pub discord_url: Option<String>,
}

pub async fn update(db: &PgPool, patch: SitePatch) -> Result<SiteSettings, sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE site_settings
        SET site_name        = COALESCE($1, site_name),
            hero_badge       = COALESCE($2, hero_badge),
            hero_title       = COALESCE($3, hero_title),
            hero_subtitle    = COALESCE($4, hero_subtitle),
            hero_description = COALESCE($5, hero_description),
            hero_cta_label   = COALESCE($6, hero_cta_label),
            footer_text      = COALESCE($7, footer_text),
            connect_host     = COALESCE($8, connect_host),
            connect_port     = COALESCE($9, connect_port),
            discord_url      = COALESCE($10, discord_url),
            updated_at       = now()
        WHERE id = 1
        "#,
    )
    .bind(patch.site_name)
    .bind(patch.hero_badge)
    .bind(patch.hero_title)
    .bind(patch.hero_subtitle)
    .bind(patch.hero_description)
    .bind(patch.hero_cta_label)
    .bind(patch.footer_text)
    .bind(empty_to_none(patch.connect_host))
    .bind(patch.connect_port)
    .bind(empty_to_none(patch.discord_url))
    .execute(db)
    .await?;

    settings(db, SOURCE_LOCALE).await
}

fn empty_to_none(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim().to_owned();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

// ── Branding ────────────────────────────────────────────────────────

/// Ceiling on an uploaded image. A logo is a header graphic, not a wallpaper.
pub const MAX_IMAGE_BYTES: usize = 512 * 1024;

/// Image types we will store and serve back.
///
/// SVG is deliberately absent. An SVG is a document that can carry script, and
/// serving one from our own origin would run it there — turning "upload a logo"
/// into stored XSS against every visitor. Only admins can upload, but a
/// compromised admin session should not also be a way to own the front page.
const ALLOWED_IMAGE_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/x-icon",
    "image/vnd.microsoft.icon",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Branding {
    Logo,
    Favicon,
}

/// An image and the content type to serve it with.
pub struct StoredImage {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

/// Whether this is something we are willing to serve back to a browser.
pub fn is_allowed_image(content_type: &str) -> bool {
    let base = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();

    ALLOWED_IMAGE_TYPES.contains(&base.as_str())
}

pub async fn store_image(
    db: &PgPool,
    which: Branding,
    bytes: &[u8],
    content_type: &str,
) -> Result<(), ApiError> {
    if bytes.is_empty() {
        return Err(ApiError::Validation("That file is empty.".to_owned()));
    }

    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(ApiError::Validation(format!(
            "Images must be under {} KB.",
            MAX_IMAGE_BYTES / 1024
        )));
    }

    if !is_allowed_image(content_type) {
        return Err(ApiError::Validation(
            "Use a PNG, JPEG, WebP, GIF or ICO.".to_owned(),
        ));
    }

    // Column names come from a closed enum, never from the request.
    let sql = match which {
        Branding::Logo => {
            "UPDATE site_settings SET logo = $1, logo_type = $2, updated_at = now() WHERE id = 1"
        }
        Branding::Favicon => {
            "UPDATE site_settings SET favicon = $1, favicon_type = $2, updated_at = now() WHERE id = 1"
        }
    };

    sqlx::query(sql)
        .bind(bytes)
        .bind(content_type.trim().to_ascii_lowercase())
        .execute(db)
        .await?;

    Ok(())
}

pub async fn clear_image(db: &PgPool, which: Branding) -> Result<(), ApiError> {
    let sql = match which {
        Branding::Logo => {
            "UPDATE site_settings SET logo = NULL, logo_type = NULL, updated_at = now() WHERE id = 1"
        }
        Branding::Favicon => {
            "UPDATE site_settings SET favicon = NULL, favicon_type = NULL, updated_at = now() WHERE id = 1"
        }
    };

    sqlx::query(sql).execute(db).await?;

    Ok(())
}

/// Read an image back, or `None` when none has been uploaded.
pub async fn read_image(db: &PgPool, which: Branding) -> Result<Option<StoredImage>, ApiError> {
    // Two literals rather than a formatted column name: sqlx refuses a
    // runtime-built query outright, which is the right call even when the
    // input is a closed enum.
    let sql = match which {
        Branding::Logo => "SELECT logo, logo_type FROM site_settings WHERE id = 1",
        Branding::Favicon => "SELECT favicon, favicon_type FROM site_settings WHERE id = 1",
    };

    let row = sqlx::query_as::<_, (Option<Vec<u8>>, Option<String>)>(sql)
        .fetch_optional(db)
        .await?;

    Ok(row.and_then(|(bytes, content_type)| {
        Some(StoredImage {
            bytes: bytes?,
            content_type: content_type?,
        })
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings_with_german() -> SiteSettings {
        SiteSettings {
            hero_badge: "Community-run survival server".to_owned(),
            hero_title: "Survive Knox County".to_owned(),
            features: json!([{ "icon": "clock", "title": "Always up", "description": "..." }]),
            translations: json!({
                "de": {
                    "hero_title": "Überlebe Knox County",
                    "features": [{ "icon": "clock", "title": "Immer erreichbar", "description": "..." }]
                }
            }),
            ..SiteSettings::default()
        }
    }

    #[test]
    fn the_source_locale_is_left_alone() {
        let mut settings = settings_with_german();
        settings.localise("en");

        assert_eq!(settings.hero_title, "Survive Knox County");
    }

    #[test]
    fn a_translated_field_is_replaced() {
        let mut settings = settings_with_german();
        settings.localise("de");

        assert_eq!(settings.hero_title, "Überlebe Knox County");
        assert_eq!(settings.features[0]["title"], "Immer erreichbar");
    }

    #[test]
    fn an_untranslated_field_keeps_the_source_text() {
        let mut settings = settings_with_german();
        settings.localise("de");

        // Only hero_title and features were translated above.
        assert_eq!(settings.hero_badge, "Community-run survival server");
    }

    #[test]
    fn an_unknown_locale_changes_nothing() {
        let mut settings = settings_with_german();
        settings.localise("fr");

        assert_eq!(settings.hero_title, "Survive Knox County");
    }

    #[test]
    fn an_empty_translation_does_not_blank_the_source() {
        let mut settings = SiteSettings {
            hero_title: "Survive Knox County".to_owned(),
            translations: json!({ "de": { "hero_title": "" } }),
            ..SiteSettings::default()
        };
        settings.localise("de");

        assert_eq!(settings.hero_title, "Survive Knox County");
    }

    #[test]
    fn translations_are_never_sent_to_the_client() {
        let json = serde_json::to_string(&settings_with_german()).expect("serialise");

        assert!(!json.contains("translations"));
        assert!(!json.contains("Überlebe"));
    }
}
