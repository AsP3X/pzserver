<?php

namespace App\Support;

/**
 * Atomic JSON/text writes for the shared PZ Lua bridge directory.
 *
 * The game server (steam/root) and Laravel (www-data) both read/write the same
 * bind-mounted files. PHP's default umask creates 0644 files owned by www-data,
 * which Project Zomboid getFileWriter() cannot open — producing:
 *   [KnoxRelay] ERROR: cannot open file writer for <player>
 *   [KnoxRelay] ERROR: cannot write export_requests.json
 *
 * Always create dirs as 0777 (no sticky bit) and files as 0666 so either UID can
 * truncate/replace them. Sticky 1777 is intentionally avoided: it blocks rename
 * of another user's files and breaks atomic cross-process updates.
 */
class LuaBridgeFile
{
    public static function ensureDirectory(string $dir): bool
    {
        if (is_dir($dir)) {
            @chmod($dir, 0777);

            return true;
        }

        if (! @mkdir($dir, 0777, true) && ! is_dir($dir)) {
            return false;
        }

        @chmod($dir, 0777);

        return true;
    }

    /**
     * @param  array<mixed>  $data
     */
    public static function writeJsonAtomic(string $path, array $data): bool
    {
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            return false;
        }

        return self::writeAtomic($path, $json);
    }

    public static function writeAtomic(string $path, string $contents): bool
    {
        $dir = dirname($path);
        if (! self::ensureDirectory($dir)) {
            return false;
        }

        $tmpPath = $path.'.tmp.'.getmypid().'.'.bin2hex(random_bytes(4));

        try {
            if (@file_put_contents($tmpPath, $contents) === false) {
                return false;
            }

            // World-writable before rename so the final path is never briefly 0644.
            @chmod($tmpPath, 0666);

            if (! @rename($tmpPath, $path)) {
                @unlink($tmpPath);

                return false;
            }

            @chmod($path, 0666);

            return true;
        } catch (\Throwable) {
            @unlink($tmpPath);

            return false;
        }
    }

    public static function makeWorldWritable(string $path): void
    {
        if (is_dir($path)) {
            @chmod($path, 0777);

            return;
        }

        if (is_file($path)) {
            @chmod($path, 0666);
        }
    }
}
