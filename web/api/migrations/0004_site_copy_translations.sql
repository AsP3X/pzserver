-- Per-locale overrides for the copy stored in site_settings.
--
-- The existing columns stay the source text (English). `translations` holds one
-- object per locale carrying only the fields that differ, so adding a language
-- is a data change rather than a schema change, and an untranslated field falls
-- back to the source instead of rendering blank.
--
--   {"de": {"hero_title": "...", "features": [ ... ]}}

ALTER TABLE site_settings
    ADD COLUMN translations jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD CONSTRAINT site_settings_translations_is_object
        CHECK (jsonb_typeof(translations) = 'object');

-- German for the seeded copy. Skipped if an admin has already written their own
-- hero, since then the translation below would not match what it translates.
UPDATE site_settings
SET translations = jsonb_build_object(
    'de', jsonb_build_object(
        'hero_badge', 'Von der Community betrieben',
        'hero_title', 'Überlebe Knox County',
        'hero_subtitle', 'Project Zomboid Dedicated Server',
        'hero_description', 'Ein betreuter Server mit automatischen Backups, ausgewählten Mods und einem Admin-Team, das wirklich da ist. Bring eine Ersatztasche mit.',
        'hero_cta_label', 'Server beitreten',
        'footer_text', 'Knox County — ein von der Community betriebener Project-Zomboid-Server.',
        'features', jsonb_build_array(
            jsonb_build_object(
                'icon', 'clock',
                'title', 'Immer erreichbar',
                'description', 'Automatische Neustarts und geplante Backups. Dein Charakter ist morgen noch da.'
            ),
            jsonb_build_object(
                'icon', 'package',
                'title', 'Ausgewählte Mods',
                'description', 'Eine handverlesene Mod-Liste, synchron mit dem Workshop und nicht durch ein Überraschungs-Update zerschossen.'
            ),
            jsonb_build_object(
                'icon', 'shield',
                'title', 'Moderiert',
                'description', 'Meldungen werden gelesen. Griefer fliegen raus. Safezones werden durchgesetzt, nicht nur empfohlen.'
            ),
            jsonb_build_object(
                'icon', 'map',
                'title', 'Live-Karte',
                'description', 'Sieh, wer unterwegs ist, wo zuletzt jemand gestorben ist und welche Routen du besser meidest.'
            )
        )
    )
)
WHERE id = 1
  AND hero_title = 'Survive Knox County';
