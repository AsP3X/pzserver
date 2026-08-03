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

    /**
     * Whether a live generation process is actually running.
     * Reconciles stale lock/progress left after container restarts.
     */
    public function isRunning(): bool
    {
        return $this->reconcileRunningState();
    }

    /**
     * Drop stale "generating" state when the worker PID is dead (e.g. after restart).
     */
    public function reconcileRunningState(): bool
    {
        $lock = $this->progress->lockPath();
        $lockData = $this->readLock();
        $pid = (int) ($lockData['pid'] ?? 0);

        $alive = $this->isProcessAlive($pid) || $this->findGenerateProcessPid() !== null;

        if ($alive) {
            return true;
        }

        // No live worker — clear ghost state so the UI can start again
        $progress = $this->progress->read();
        if ($progress !== null && ! empty($progress['generating'])) {
            $this->progress->update([
                'generating' => false,
                'stage' => 'failed',
                'message' => 'Generation stopped (process no longer running — often after a container restart). Click Generate again.',
                'error' => 'stale_after_restart',
                'finished_at' => now()->toIso8601String(),
            ]);
        }

        if (is_file($lock)) {
            @unlink($lock);
        }

        $this->progress->clearStopRequest();

        return false;
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

        // Always reconcile first — restart leaves generating=true with a dead PID
        if ($this->reconcileRunningState()) {
            return [
                'ok' => false,
                'message' => 'Tile generation is already running. Use Stop, or wait for it to finish.',
                'log' => $this->logPath(),
            ];
        }

        $this->progress->clearStopRequest();

        $php = $this->phpCliBinary();
        $this->progress->start([
            'stage' => 'starting',
            'step' => 0,
            'steps' => 3,
            'message' => $force
                ? 'Queued full regenerate…'
                : ($resume ? 'Queued resume…' : 'Queued map tile generation…'),
        ]);

        $log = $this->logPath();
        @file_put_contents(
            $log,
            '['.now()->toIso8601String()."] UI generate force=".($force ? '1' : '0')
            .' resume='.($resume ? '1' : '0')
            ." php={$php}\n",
            FILE_APPEND
        );

        $flags = '';
        if ($force) {
            $flags = '--force';
        } elseif ($resume) {
            $flags = '--resume';
        }

        $artisan = base_path('artisan');
        $lock = $this->progress->lockPath();

        // setsid detaches from php-fpm so the job survives request end
        // IMPORTANT: use CLI php binary — PHP_BINARY under FPM is php-fpm and cannot run artisan
        // nice/ionice so map gen does not starve the game disk (avoid idle class by default)
        $prio = '';
        if (config('zomboid.map.generate_low_priority', true)) {
            $nice = (int) config('zomboid.map.generate_nice', 15);
            $ioClass = (int) config('zomboid.map.generate_ionice_class', 2);
            $ioLevel = (int) config('zomboid.map.generate_ionice_level', 7);
            $prio = 'nice -n '.$nice.' ';
            $ioniceOut = [];
            $ioniceCode = 1;
            @exec('command -v ionice 2>/dev/null', $ioniceOut, $ioniceCode);
            if ($ioniceCode === 0) {
                $prio .= $ioClass === 3
                    ? 'ionice -c 3 '
                    : 'ionice -c '.$ioClass.' -n '.$ioLevel.' ';
            }
        }
        $cmd = sprintf(
            'cd %s && setsid %s%s %s zomboid:generate-map-tiles %s >> %s 2>&1 < /dev/null & echo $!',
            escapeshellarg(base_path()),
            $prio,
            escapeshellarg($php),
            escapeshellarg($artisan),
            $flags,
            escapeshellarg($log),
        );

        $output = [];
        $exit = 0;
        exec($cmd, $output, $exit);
        $pid = isset($output[0]) && ctype_digit(trim((string) $output[0])) ? (int) trim((string) $output[0]) : 0;

        if ($pid <= 0) {
            $cmd2 = sprintf(
                'cd %s && nohup %s %s zomboid:generate-map-tiles %s >> %s 2>&1 < /dev/null & echo $!',
                escapeshellarg(base_path()),
                escapeshellarg($php),
                escapeshellarg($artisan),
                $flags,
                escapeshellarg($log),
            );
            $output = [];
            exec($cmd2, $output, $exit);
            $pid = isset($output[0]) && ctype_digit(trim((string) $output[0])) ? (int) trim((string) $output[0]) : 0;
        }

        if ($pid <= 0) {
            $this->progress->finish(false, 'Failed to start background process.', 'spawn_failed');

            return [
                'ok' => false,
                'message' => 'Failed to start background generation. Check storage/logs/map-tiles.log (php CLI / exec).',
                'log' => 'storage/logs/map-tiles.log',
            ];
        }

        // Confirm the process is still alive a moment later
        usleep(300000);
        if (! $this->isProcessAlive($pid) && $this->findGenerateProcessPid() === null) {
            $tail = $this->tailLog(40);
            $this->progress->finish(
                false,
                'Generation process exited immediately. See storage/logs/map-tiles.log',
                'spawn_exited'
            );
            @file_put_contents($log, "[spawn] PID {$pid} died immediately\n{$tail}\n", FILE_APPEND);

            return [
                'ok' => false,
                'message' => 'Generation process exited immediately. Check storage/logs/map-tiles.log',
                'log' => 'storage/logs/map-tiles.log',
            ];
        }

        // Prefer the real artisan PID if setsid wrapped it
        $realPid = $this->findGenerateProcessPid() ?? $pid;

        file_put_contents($lock, json_encode([
            'started_at' => now()->toIso8601String(),
            'pid' => $realPid,
            'force' => $force,
            'resume' => $resume,
            'php' => $php,
        ], JSON_PRETTY_PRINT));

        $this->progress->update([
            'message' => 'Generation running (PID '.$realPid.')…',
            'generating' => true,
        ]);

        $this->scheduleLockCleanup($realPid, $lock);

        $message = $force
            ? 'Full regenerate started (PID '.$realPid.'). This can take a long time.'
            : ($resume
                ? 'Resume started (PID '.$realPid.').'
                : 'Map tile generation started (PID '.$realPid.'). This can take 10–60+ minutes.');

        return [
            'ok' => true,
            'message' => $message,
            'log' => 'storage/logs/map-tiles.log',
            'pid' => $realPid,
        ];
    }

    public function requestStop(): array
    {
        if (! $this->reconcileRunningState()) {
            return [
                'ok' => false,
                'message' => 'No map tile generation is running (cleared stale state if any).',
            ];
        }

        $this->progress->requestStop();

        $lock = $this->readLock();
        $pid = (int) ($lock['pid'] ?? 0);
        if ($pid > 1 && $this->isProcessAlive($pid) && function_exists('posix_kill')) {
            @posix_kill($pid, defined('SIGTERM') ? SIGTERM : 15);
        }

        return [
            'ok' => true,
            'message' => 'Stop requested. Partial tiles are kept for Resume.',
        ];
    }

    public function logPath(): string
    {
        return storage_path('logs/map-tiles.log');
    }

    /**
     * CLI php binary — never php-fpm (PHP_BINARY under FPM).
     */
    public function phpCliBinary(): string
    {
        $candidates = [];

        if (defined('PHP_BINARY') && is_string(PHP_BINARY) && PHP_BINARY !== '' && ! str_contains(PHP_BINARY, 'php-fpm')) {
            $candidates[] = PHP_BINARY;
        }

        $candidates = array_merge($candidates, [
            '/usr/local/bin/php',
            '/usr/bin/php',
            'php',
        ]);

        foreach ($candidates as $bin) {
            if ($bin === 'php') {
                return 'php';
            }
            if (is_executable($bin)) {
                return $bin;
            }
        }

        return 'php';
    }

    /**
     * @return array<string, mixed>
     */
    private function readLock(): array
    {
        $lock = $this->progress->lockPath();
        if (! is_file($lock)) {
            return [];
        }

        $data = json_decode((string) @file_get_contents($lock), true);

        return is_array($data) ? $data : [];
    }

    private function isProcessAlive(int $pid): bool
    {
        if ($pid <= 1) {
            return false;
        }

        if (function_exists('posix_kill')) {
            return @posix_kill($pid, 0);
        }

        if (PHP_OS_FAMILY !== 'Windows' && is_dir('/proc/'.$pid)) {
            return true;
        }

        return false;
    }

    /**
     * Find a running zomboid:generate-map-tiles artisan process.
     */
    private function findGenerateProcessPid(): ?int
    {
        if (PHP_OS_FAMILY === 'Windows') {
            return null;
        }

        $out = [];
        @exec("pgrep -f 'artisan zomboid:generate-map-tiles' 2>/dev/null", $out);
        foreach ($out as $line) {
            $pid = (int) trim($line);
            if ($pid > 1 && $pid !== getmypid()) {
                return $pid;
            }
        }

        return null;
    }

    private function tailLog(int $lines): string
    {
        $path = $this->logPath();
        if (! is_file($path)) {
            return '(no log file)';
        }

        $content = @file($path);
        if (! is_array($content) || $content === []) {
            return '(empty log)';
        }

        return implode('', array_slice($content, -$lines));
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
# If another generate started, leave its lock alone
if [ -f "$lock" ]; then
  if grep -q "\"pid\": $pid" "$lock" 2>/dev/null || grep -q "\"pid\":$pid" "$lock" 2>/dev/null; then
    rm -f "$lock"
  fi
fi
if [ -f "$progress" ]; then
  php -r '
    $p = $argv[1];
    $j = json_decode((string) @file_get_contents($p), true);
    if (!is_array($j) || empty($j["generating"])) { exit(0); }
    $j["generating"] = false;
    $j["stage"] = "failed";
    $j["message"] = "Generation process exited. Check storage/logs/map-tiles.log";
    $j["updated_at"] = date("c");
    $j["finished_at"] = date("c");
    file_put_contents($p, json_encode($j, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  ' "$progress" 2>/dev/null || true
fi
SH;

        $php = $this->phpCliBinary();
        $script = str_replace('php -r', escapeshellarg($php).' -r', $script);

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
