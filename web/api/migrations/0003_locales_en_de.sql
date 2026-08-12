-- Supported locales are English and German; Georgian is dropped.
--
-- This arrives as its own migration rather than an edit to 0001 because that
-- one has already been applied — sqlx validates the checksum of every applied
-- migration and refuses to start if a file changed underneath it. A fresh
-- install therefore runs 0001's original seed and is corrected here.

ALTER TABLE site_settings DROP CONSTRAINT site_settings_locale_supported;

UPDATE site_settings
SET default_locale = 'en'
WHERE default_locale NOT IN ('en', 'de');

ALTER TABLE site_settings
    ADD CONSTRAINT site_settings_locale_supported CHECK (default_locale IN ('en', 'de'));

-- Replace the seeded copy, but only where it is still the seeded copy: an
-- admin who has already written their own badge keeps it.
UPDATE site_settings
SET hero_badge = 'Community-run survival server'
WHERE id = 1
  AND hero_badge = 'Georgian Gaming Community';

UPDATE site_settings
SET footer_text = 'Knox County — a community-run Project Zomboid server.'
WHERE id = 1
  AND footer_text = 'Knox County — a Georgian Project Zomboid community.';
