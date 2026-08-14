-- UI string overrides and extra languages. File dictionaries stay the
-- defaults; a row here wins for that locale and key.

CREATE TABLE ui_languages (
    code        text PRIMARY KEY,
    name        text        NOT NULL,
    native_name text        NOT NULL,
    is_default  boolean     NOT NULL DEFAULT false,
    is_active   boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ui_languages_one_default
    ON ui_languages (is_default)
    WHERE is_default;

INSERT INTO ui_languages (code, name, native_name, is_default, is_active) VALUES
    ('en', 'English', 'English', true, true),
    ('de', 'German', 'Deutsch', false, true),
    ('ka', 'Georgian', 'ქართული', false, true);

CREATE TABLE ui_translations (
    locale     text        NOT NULL REFERENCES ui_languages (code) ON DELETE CASCADE,
    key        text        NOT NULL,
    value      text        NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (locale, key)
);

CREATE INDEX ui_translations_locale_idx ON ui_translations (locale);
