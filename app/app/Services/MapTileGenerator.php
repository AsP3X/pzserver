<?php

namespace App\Services;

/**
 * Starts / tracks background map tile generation from the web UI.
 */
class MapTileGenerator
{
    public function __construct(
        private readonly MapTileProgress $progress,
        private readonly MapTileStore $tileStore,
    ) {}

    public function isRunning(): bool
    {
        if ($this->progress->isRunning()) {
            return true;
        }

        $lock = $this->progress->lockPath();
        if (! is_file($lock)) {
            return false;
        }

        // Stale lock after 6 hours
        if (filemtime($lock) < time() - 21600) {
            @unlink($lock);

            return false;
        }

        // If lock exists but process is gone and progress is not generating, clear lock
        $data = json_decode((string) @file_get_contents($lock), true);
        $pid = is_array($data) ? (int) ($data['pid'] ?? 0) : 0;
        if ($pid > 1 && function_exists('posix_kill') && ! @posix_kill($pid, 0)) {
            // Process dead — keep lock only briefly so UI can show failure via progress
            if (! $this->progress->isRunning()) {
                @unlink($lock);

                return false;
            }
        }

        return true;
    }

    /**
     * @return array{ok: bool, message: string, log: string, pid?: int}
     */
    public function start(bool $force = false, bool $resume = false): array
    {
        if ($force && $resume) {
            return [
                'ok' => false,
                'message' => 'Choose either force regenerate or resume, not both.',
                'log' => $this->logPath(),
            ];
        }

        if ($this->isRunning()) {
            return [
                'ok' => false,
                'message' => 'Tile generation is already running. Use Stop, or wait for it to finish.',
                'log' => $this->logPath(),
            ];
        }

        $this->progress->clearStopRequest();

        // Immediate UI feedback (before the artisan process is fully up)
        $this->progress->start([
            'stage' => 'starting',
            'step' => 0,
            'steps' => 3,
            'message' => $force
                ? 'Queued full regenerate…'
                : ($resume ? 'Queued resume…' : 'Queued map tile generation…'),
        ]);

        $log = $this->logPath();
        @file_put_contents($log, '['.now()->toIso8601String()."] UI requested generate force=".($force ? '1' : '0').' resume='.($resume ? '1' : '0')."\n", FILE_APPEND);

        $flags = '';
        if ($force) {
            $flags = '--force';
        } elseif ($resume) {
            $flags = '--resume';
        }

        $artisan = base_path('artisan');
        $php = PHP_BINARY ?: 'php';
        $lock = $this->progress->lockPath();

        // setsid detaches from php-fpm so the job survives request end
        $cmd = sprintf(
            'cd %s && setsid %s %s zomboid:generate-map-tiles %s >> %s 2>&1 < /dev/null & echo $!',
            escapeshellarg(base_path()),
            escapeshellarg($php),
            escapeshellarg($artisan),
            $flags,
            escapeshellarg($log),
        );

        $output = [];
        $exit = 0;
        exec($cmd, $output, $exit);
        $pid = isset($output[0]) && ctype_digit(trim($output[0])) ? (int) trim($output[0]) : 0;

        if ($pid <= 0) {
            // Fallback without setsid
            $cmd2 = sprintf(
                'cd %s && nohup %s %s zomboid:generate-map-tiles %s >> %s 2>&1 & echo $!',
                escapeshellarg(base_path()),
                escapeshellarg($php),
                escapeshellarg($artisan),
                $flags,
                escapeshellarg($log),
            );
            $output = [];
            exec($cmd2, $output, $exit);
            $pid = isset($output[0]) && ctype_digit(trim($output[0])) ? (int) trim($output[0]) : 0;
        }

        if ($pid <= 0) {
            $this->progress->finish(false, 'Failed to start background process.', 'spawn_failed');

            return [
                'ok' => false,
                'message' => 'Failed to start background generation process. Check that exec() is allowed and see storage/logs/map-tiles.log',
                'log' => 'storage/logs/map-tiles.log',
            ];
        }

        file_put_contents($lock, json_encode([
            'started_at' => now()->toIso8601String(),
            'pid' => $pid,
            'force' => $force,
            'resume' => $resume,
        ], JSON_PRETTY_PRINT));

        // Do not delete lock from the shell — command/progress owns lifecycle
        // A small watcher removes lock when the PID exits (optional best-effort)
        $this->scheduleLockCleanup($pid, $lock);

        $message = $force
            ? 'Full regenerate started (PID '.$pid.'). This can take a long time.'
            : ($resume
                ? 'Resume started (PID '.$pid.').'
                : 'Map tile generation started (PID '.$pid.'). This can take 10–60+ minutes.');

        return [
            'ok' => true,
            'message' => $message,
            'log' => 'storage/logs/map-tiles.log',
            'pid' => $pid,
        ];
    }

    public function requestStop(): array
    {
        if (! $this->isRunning()) {
            return [
                'ok' => false,
                'message' => 'No map tile generation is running.',
            ];
        }

        $this->progress->requestStop();

        return [
            'ok' => true,
            'message' => 'Stop requested. Workers will exit shortly; partial tiles are kept for Resume.',
        ];
    }

    public function logPath(): string
    {
        return storage_path('logs/map-tiles.log');
    }

    /**
     * Best-effort: when the background PID exits, drop the lock and mark progress failed if still "generating".
     */
    private function scheduleLockCleanup(int $pid, string $lock): void
    {
        if (PHP_OS_FAMILY === 'Windows' || $pid <= 1) {
            return;
        }

        $progressPath = $this->progress->path();
        $script = <<<'SH'
pid="$1"
lock="$2"
progress="$3"
while kill -0 "$pid" 2>/dev/null; do sleep 5; done
rm -f "$lock"
if [ -f "$progress" ]; then
  php -r '
    $p = $argv[1];
    $j = json_decode((string) @file_get_contents($p), true);
    if (!is_array($j) || empty($j["generating"])) { exit(0); }
    $j["generating"] = false;
    $j["stage"] = "failed";
    $j["message"] = "Generation process exited unexpectedly. Check storage/logs/map-tiles.log";
    $j["updated_at"] = date("c");
    $j["finished_at"] = date("c");
    file_put_contents($p, json_encode($j, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  ' "$progress" 2>/dev/null || true
fi
SH;

        $cmd = sprintf(
            'setsid sh -c %s -- %s %s %s >/dev/null 2>&1 &',
            escapeshellarg($script),
            escapeshellarg((string) $pid),
            escapeshellarg($lock),
            escapeshellarg($progressPath),
        );
        @exec($cmd);
    }
}
