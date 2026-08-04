<?php

namespace App\Services;

use App\Models\Language;
use App\Models\Translation;
use Illuminate\Support\Facades\Cache;

class TranslationService
{
    /**
     * Get all translations for a locale, merging JSON file defaults with DB overrides.
     *
     * @return array<string, string>
     */
    public static function getForLocale(string $locale): array
    {
        return Cache::remember(self::cacheKey($locale), 3600, function () use ($locale) {
            // Always start from English as the base (fallback for all untranslated keys)
            $result = self::loadJsonFile('en');

            // Overlay the requested locale's JSON file (if different from English)
            if ($locale !== 'en') {
                $localeDefaults = self::loadJsonFile($locale);
                if (! empty($localeDefaults)) {
                    $result = array_merge($result, $localeDefaults);
                }
            }

            // Overlay DB overrides for this locale
            $overrides = Translation::query()
                ->where('locale', $locale)
                ->where('group', '')
                ->pluck('value', 'key')
                ->all();

            return array_merge($result, $overrides);
        });
    }

    /**
     * Clear cached translations for a locale (or all locales).
     */
    public static function bustCache(?string $locale = null): void
    {
        if ($locale) {
            Cache::forget(self::cacheKey($locale));
        } else {
            // Clear DB locale caches
            $locales = Translation::query()->distinct()->pluck('locale')->all();
            foreach ($locales as $loc) {
                Cache::forget(self::cacheKey($loc));
            }
            // Also clear caches for active languages (may have JSON-only translations)
            $activeCodes = Language::query()->where('is_active', true)->pluck('code')->all();
            foreach ($activeCodes as $code) {
                Cache::forget(self::cacheKey($code));
            }
            Cache::forget(self::cacheKey('en'));
        }
    }

    /**
     * Cache key stamped with the language files' modification times.
     *
     * Editing lang/*.json is a deploy, not an admin action, so nothing calls
     * bustCache() for it — new keys would otherwise render as raw
     * "nav.my_map" strings for up to an hour after release. Folding the
     * mtimes into the key retires the old entry the moment a file changes.
     */
    private static function cacheKey(string $locale): string
    {
        $stamp = self::fileStamp('en');

        if ($locale !== 'en') {
            $stamp .= '-'.self::fileStamp($locale);
        }

        return "translations.{$locale}.{$stamp}";
    }

    /**
     * Modification time of a locale's JSON file, or '0' when it has none.
     */
    private static function fileStamp(string $locale): string
    {
        if (! self::isValidLocale($locale)) {
            return '0';
        }

        $path = lang_path($locale.'.json');

        return is_file($path) ? (string) filemtime($path) : '0';
    }

    /**
     * Get all known translation keys from the English JSON file.
     *
     * @return array<int, string>
     */
    public static function allKeys(): array
    {
        $defaults = self::loadJsonFile('en');

        return array_keys($defaults);
    }

    /**
     * Get only the JSON file defaults for a locale (no English fallback, no DB overrides).
     * Used by the translation editor to show per-locale base values.
     *
     * @return array<string, string>
     */
    public static function getJsonDefaults(string $locale): array
    {
        return self::loadJsonFile($locale);
    }

    /**
     * @return array<string, string>
     */
    private static function loadJsonFile(string $locale): array
    {
        if (! self::isValidLocale($locale)) {
            return [];
        }

        $langDirectory = realpath(lang_path());

        if ($langDirectory === false) {
            return [];
        }

        $path = $langDirectory.DIRECTORY_SEPARATOR.$locale.'.json';

        if (! file_exists($path)) {
            return [];
        }

        $resolvedPath = realpath($path);

        if ($resolvedPath === false || ! str_starts_with($resolvedPath, $langDirectory.DIRECTORY_SEPARATOR)) {
            return [];
        }

        $contents = file_get_contents($resolvedPath);

        if ($contents === false) {
            return [];
        }

        return json_decode($contents, true) ?: [];
    }

    private static function isValidLocale(string $locale): bool
    {
        return $locale !== '' && strlen($locale) <= 10 && preg_match(Language::LOCALE_REGEX, $locale);
    }
}
