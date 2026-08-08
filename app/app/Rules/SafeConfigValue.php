<?php

namespace App\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * Validates that a value is safe for use in PZ config files (server.ini, SandboxVars.lua).
 * Uses an allowlist approach to prevent Lua code injection and INI newline injection.
 *
 * Use allowBackslash: true for INI files (B42 mod IDs use backslashes).
 * Keep allowBackslash: false for Lua files (backslashes are escape characters).
 */
class SafeConfigValue implements ValidationRule
{
    /** Safe characters WITHOUT backslash (for Lua config values). */
    private const SAFE_PATTERN = '/^[a-zA-Z0-9 ,.:;\/\-_=+@#!%^*\[\]\'?]+$/';

    /** Safe characters WITH backslash (for INI config values — B42 mod IDs use \). */
    private const SAFE_PATTERN_WITH_BACKSLASH = '/^[a-zA-Z0-9 ,.:;\/\\\\\-_=+@#!%^*\[\]\'?]+$/';

    /**
     * INI keys the game renders as rich text instead of reading as data.
     *
     * These carry markup tags (`<LINE>`, `<RGB:1,0,0>`) and prose in whatever
     * language the community speaks, so the character allowlist above cannot
     * express them — it would strand the welcome message on plain ASCII with
     * no formatting. They are checked by validateRichText() instead.
     *
     * @var string[]
     */
    private const RICH_TEXT_KEYS = [
        'ServerWelcomeMessage',
    ];

    /** A welcome message is one INI line; this is generous for real ones. */
    private const RICH_TEXT_MAX_LENGTH = 2000;

    public function __construct(
        private readonly bool $allowBackslash = false,
    ) {}

    /**
     * @param  \Closure(string, ?string=): \Illuminate\Translation\PotentiallyTranslatedString  $fail
     */
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        // Reject non-scalar values (arrays/objects cast to "Array"/"Object" string)
        if (is_array($value) || is_object($value)) {
            $fail('The :attribute must be a scalar value.');

            return;
        }

        $str = (string) $value;

        // Allow empty values (PZ uses empty values like Password=)
        if ($str === '') {
            return;
        }

        // Rich text only exists in INI files, never in the Lua sandbox config
        if ($this->allowBackslash && $this->isRichTextKey($attribute)) {
            $this->validateRichText($str, $fail);

            return;
        }

        // Reject Lua concatenation operator
        if (str_contains($str, '..')) {
            $fail('The :attribute contains unsafe characters for config files.');

            return;
        }

        // Allowlist: only safe characters permitted
        $pattern = $this->allowBackslash ? self::SAFE_PATTERN_WITH_BACKSLASH : self::SAFE_PATTERN;
        if (! preg_match($pattern, $str)) {
            $fail('The :attribute contains unsafe characters for config files.');
        }
    }

    /**
     * Is this the value of a key whose contents the game renders as rich text?
     *
     * Laravel passes the full dotted path (`settings.ServerWelcomeMessage`),
     * so the config key is the last segment.
     */
    private function isRichTextKey(string $attribute): bool
    {
        $key = str_contains($attribute, '.')
            ? substr($attribute, (int) strrpos($attribute, '.') + 1)
            : $attribute;

        return in_array($key, self::RICH_TEXT_KEYS, true);
    }

    /**
     * Free-form prose plus markup tags, bounded by what an INI file can hold.
     *
     * A `key=value` line has exactly one injection vector — the line break that
     * would start a second key — so control characters are what this rejects.
     * Punctuation and non-ASCII letters carry no meaning here: the value is
     * written verbatim to a flat file that only the game parses, and it reaches
     * the dashboard through React, which escapes it.
     *
     * @param  \Closure(string, ?string=): \Illuminate\Translation\PotentiallyTranslatedString  $fail
     */
    private function validateRichText(string $value, Closure $fail): void
    {
        if (! mb_check_encoding($value, 'UTF-8')) {
            $fail('The :attribute must be valid UTF-8 text.');

            return;
        }

        if (preg_match('/[\x00-\x1F\x7F]/', $value)) {
            $fail('The :attribute must not contain line breaks or control characters.');

            return;
        }

        if (mb_strlen($value) > self::RICH_TEXT_MAX_LENGTH) {
            $fail('The :attribute must not be longer than '.self::RICH_TEXT_MAX_LENGTH.' characters.');
        }
    }
}
