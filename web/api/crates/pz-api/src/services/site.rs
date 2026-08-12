//! The singleton row that drives the public site's copy and branding.

use serde::Serialize;
use serde_json::Value;
use sqlx::{FromRow, PgPool};

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
