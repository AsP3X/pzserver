<?php

namespace App\Services;

/**
 * Shared progress state for map tile generation (CLI + admin UI).
 *
 * Written by zomboid:generate-map-tiles; read by PlayerMapController.
 */
class MapTileProgress
{
    public function path(): string
    {
        return storage_path('app/map-tiles.progress.json');
    }

    /**
     * @return array{
     *     generating: bool,
     *     stage: string,
     *     step: int,
     *     steps: int,
     *     message: string,
     *     completed: int,
     *     total: int,
     *     percent: int,
     *     tiles_on_disk: int,
     *     started_at: string|null,
     *     updated_at: string|null,
     *     finished_at: string|null,
     *     error: string|null
     * }|null
     */
    public function read(): ?array
    {
        $path = $this->path();
        if (! is_file($path)) {
            return null;
        }

        $raw = @file_get_contents($path);
        if ($raw === false || $raw === '') {
            return null;
        }

        $data = json_decode($raw, true);
        if (! is_array($data)) {
            return null;
        }

        return $this->normalize($data);
    }

    public function isRunning(): bool
    {
        $data = $this->read();
        if ($data === null || ! $data['generating']) {
            return false;
        }

        // Stale if no update for 30 minutes (render is long but logs update often)
        $updated = $data['updated_at'] ?? null;
        if (is_string($updated) && $updated !== '') {
            $ts = strtotime($updated);
            if ($ts !== false && $ts < time() - 1800) {
                return false;
            }
        }

        return true;
    }

    /**
     * @param  array<string, mixed>  $fields
     */
    public function start(array $fields = []): void
    {
        $now = now()->toIso8601String();
        $this->write(array_merge([
            'generating' => true,
            'stage' => 'starting',
            'step' => 0,
            'steps' => 3,
            'message' => 'Starting map tile generation…',
            'completed' => 0,
            'total' => 0,
            'percent' => 0,
            'tiles_on_disk' => 0,
            'started_at' => $now,
            'updated_at' => $now,
            'finished_at' => null,
            'error' => null,
        ], $fields));
    }

    /**
     * @param  array<string, mixed>  $fields
     */
    public function update(array $fields): void
    {
        $current = $this->read() ?? [];
        $fields['updated_at'] = now()->toIso8601String();
        if (! array_key_exists('generating', $fields)) {
            $fields['generating'] = true;
        }

        $merged = array_merge($current, $fields);

        // Recompute overall percent when stage pieces are known
        if (! array_key_exists('percent', $fields)) {
            $merged['percent'] = $this->computePercent($merged);
        }

        $this->write($merged);
    }

    public function finish(bool $success, string $message = '', ?string $error = null): void
    {
        $current = $this->read() ?? [];
        $now = now()->toIso8601String();

        $this->write(array_merge($current, [
            'generating' => false,
            'stage' => $success ? 'done' : 'failed',
            'message' => $message !== '' ? $message : ($success ? 'Map tiles ready.' : 'Generation failed.'),
            'percent' => $success ? 100 : (int) ($current['percent'] ?? 0),
            'updated_at' => $now,
            'finished_at' => $now,
            'error' => $error,
        ]));
    }

    public function clear(): void
    {
        $path = $this->path();
        if (is_file($path)) {
            @unlink($path);
        }
    }

    /**
     * Parse the last "job: done/total" status line from a pzmap2dzi log tail.
     *
     * @return array{done: int, total: int}|null
     */
    public function parseJobProgressFromLog(string $logPath): ?array
    {
        if (! is_file($logPath)) {
            return null;
        }

        $size = filesize($logPath);
        if ($size === false || $size === 0) {
            return null;
        }

        $fp = fopen($logPath, 'rb');
        if ($fp === false) {
            return null;
        }

        $read = min(8192, $size);
        fseek($fp, -$read, SEEK_END);
        $tail = (string) fread($fp, $read);
        fclose($fp);

        // \r progress updates leave many "job: X/Y" fragments in the log
        if (! preg_match_all('/job:\s*(\d+)\s*\/\s*(\d+)/i', $tail, $matches, PREG_SET_ORDER)) {
            return null;
        }

        $last = $matches[array_key_last($matches)];
        $done = (int) $last[1];
        $total = (int) $last[2];

        if ($total <= 0) {
            return null;
        }

        return [
            'done' => min($done, $total),
            'total' => $total,
        ];
    }

    /**
     * Count tile image files under the loose pyramid (best-effort; may be slow on huge trees).
     */
    public function countLooseTiles(?string $layerPath = null): int
    {
        $layerPath = $layerPath ?? rtrim((string) config('zomboid.map.tiles_path'), '/').'/html/map_data/base/layer0_files';
        if (! is_dir($layerPath)) {
            return 0;
        }

        // Prefer a cheap shell count when available
        if (PHP_OS_FAMILY !== 'Windows') {
            $cmd = 'find '.escapeshellarg($layerPath).' -type f \( -name \'*.webp\' -o -name \'*.jpg\' -o -name \'*.jpeg\' \) 2>/dev/null | wc -l';
            $out = [];
            @exec($cmd, $out, $code);
            if ($code === 0 && isset($out[0]) && is_numeric(trim($out[0]))) {
                return (int) trim($out[0]);
            }
        }

        $count = 0;
        try {
            $iterator = new \RecursiveIteratorIterator(
                new \RecursiveDirectoryIterator($layerPath, \RecursiveDirectoryIterator::SKIP_DOTS),
            );
            foreach ($iterator as $file) {
                if (! $file->isFile()) {
                    continue;
                }
                $ext = strtolower($file->getExtension());
                if (in_array($ext, ['webp', 'jpg', 'jpeg'], true)) {
                    $count++;
                }
            }
        } catch (\Throwable) {
            return $count;
        }

        return $count;
    }

    /**
     * @param  array<string, mixed>  $data
     * @return array{
     *     generating: bool,
     *     stage: string,
     *     step: int,
     *     steps: int,
     *     message: string,
     *     completed: int,
     *     total: int,
     *     percent: int,
     *     tiles_on_disk: int,
     *     started_at: string|null,
     *     updated_at: string|null,
     *     finished_at: string|null,
     *     error: string|null
     * }
     */
    private function normalize(array $data): array
    {
        return [
            'generating' => (bool) ($data['generating'] ?? false),
            'stage' => (string) ($data['stage'] ?? 'unknown'),
            'step' => (int) ($data['step'] ?? 0),
            'steps' => max(1, (int) ($data['steps'] ?? 3)),
            'message' => (string) ($data['message'] ?? ''),
            'completed' => (int) ($data['completed'] ?? 0),
            'total' => (int) ($data['total'] ?? 0),
            'percent' => max(0, min(100, (int) ($data['percent'] ?? 0))),
            'tiles_on_disk' => (int) ($data['tiles_on_disk'] ?? 0),
            'started_at' => isset($data['started_at']) ? (string) $data['started_at'] : null,
            'updated_at' => isset($data['updated_at']) ? (string) $data['updated_at'] : null,
            'finished_at' => isset($data['finished_at']) ? (string) $data['finished_at'] : null,
            'error' => isset($data['error']) ? (string) $data['error'] : null,
        ];
    }

    /**
     * @param  array<string, mixed>  $data
     */
    private function computePercent(array $data): int
    {
        $stage = (string) ($data['stage'] ?? '');
        $completed = (int) ($data['completed'] ?? 0);
        $total = (int) ($data['total'] ?? 0);
        $ratio = ($total > 0) ? min(1.0, max(0.0, $completed / $total)) : 0.0;

        return match ($stage) {
            'starting', 'clear' => 1,
            'unpack' => 3 + (int) round($ratio * 5), // ~3–8%
            'render' => 8 + (int) round($ratio * 82), // ~8–90%
            'pack' => 90 + (int) round($ratio * 9), // ~90–99%
            'done' => 100,
            'failed' => max(0, min(99, (int) ($data['percent'] ?? 0))),
            default => (int) ($data['percent'] ?? 0),
        };
    }

    /**
     * @param  array<string, mixed>  $data
     */
    private function write(array $data): void
    {
        $path = $this->path();
        $dir = dirname($path);
        if (! is_dir($dir)) {
            mkdir($dir, 0755, true);
        }

        $normalized = $this->normalize($data);
        // Preserve computePercent result if already set on write path that included percent
        if (isset($data['percent'])) {
            $normalized['percent'] = max(0, min(100, (int) $data['percent']));
        } else {
            $normalized['percent'] = $this->computePercent($normalized);
        }

        $json = json_encode($normalized, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            return;
        }

        // Atomic replace
        $tmp = $path.'.tmp.'.getmypid();
        if (@file_put_contents($tmp, $json) !== false) {
            @rename($tmp, $path);
        }
    }
}
