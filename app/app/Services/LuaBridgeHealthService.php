<?php

namespace App\Services;

use App\Models\MoneyDeposit;
use App\Support\LuaBridgeFile;

/**
 * Reports health of the shared PZ Lua bridge bind mount.
 */
class LuaBridgeHealthService
{
    /**
     * @return array{
     *     path: string,
     *     healthy: bool,
     *     writable: bool,
     *     issues: list<string>,
     *     directories: list<array<string, mixed>>,
     *     files: list<array<string, mixed>>,
     *     recent_errors: list<string>,
     *     pending_deposits: int,
     *     rates: array{money_value: int, bundle_value: int}
     * }
     */
    public function status(): array
    {
        $path = (string) config('zomboid.lua_bridge.path');
        $issues = [];
        $files = [];
        $directories = [];

        $requiredDirs = [
            $path,
            $path.'/inventory',
        ];

        foreach ($requiredDirs as $dir) {
            $exists = is_dir($dir);
            $writable = $exists && is_writable($dir);
            $mode = $exists ? $this->mode($dir) : null;
            $sticky = $mode !== null && (($mode & 0o1000) !== 0);

            $directories[] = [
                'path' => $dir,
                'exists' => $exists,
                'writable' => $writable,
                'mode' => $mode !== null ? sprintf('%04o', $mode) : null,
                'sticky' => $sticky,
            ];

            if (! $exists) {
                $issues[] = "Missing directory: {$dir}";
            } elseif (! $writable) {
                $issues[] = "Directory not writable: {$dir}";
            } elseif ($sticky) {
                $issues[] = "Sticky bit set on {$dir} (breaks cross-UID replace)";
            }
        }

        $watched = [
            'deposit_requests.json',
            'deposit_results.json',
            'export_requests.json',
            'player_stats.json',
            'players_live.json',
            'game_state.json',
            'items_catalog.json',
            'delivery_queue.json',
            'delivery_results.json',
            'money_deposit_config.json',
        ];

        foreach ($watched as $name) {
            $full = $path.'/'.$name;
            $exists = is_file($full);
            $writable = $exists && is_writable($full);
            $mode = $exists ? $this->mode($full) : null;
            $mtime = $exists ? filemtime($full) : null;
            $size = $exists ? filesize($full) : null;
            $worldWritable = $mode !== null && (($mode & 0o002) !== 0);

            $files[] = [
                'name' => $name,
                'path' => $full,
                'exists' => $exists,
                'writable' => $writable,
                'world_writable' => $worldWritable,
                'mode' => $mode !== null ? sprintf('%04o', $mode) : null,
                'size' => $size,
                'mtime' => $mtime ? date('c', $mtime) : null,
                'age_seconds' => $mtime ? max(0, time() - $mtime) : null,
            ];

            if ($exists && ! $worldWritable && PHP_OS_FAMILY !== 'Windows') {
                $issues[] = "{$name} is not world-writable (mode ".sprintf('%04o', $mode).')';
            }
        }

        $writableProbe = $this->probeWrite($path);
        if (! $writableProbe['ok']) {
            $issues[] = 'Write probe failed: '.($writableProbe['error'] ?? 'unknown');
        }

        $pendingDeposits = 0;
        try {
            $pendingDeposits = MoneyDeposit::query()->where('status', 'pending')->count();
        } catch (\Throwable) {
            // table may not exist yet during migrate
        }

        return [
            'path' => $path,
            'healthy' => $issues === [] && $writableProbe['ok'],
            'writable' => $writableProbe['ok'],
            'issues' => $issues,
            'directories' => $directories,
            'files' => $files,
            'recent_errors' => $this->recentBridgeErrorsFromLogs(),
            'pending_deposits' => $pendingDeposits,
            'rates' => [
                'money_value' => (int) config('zomboid.money_deposit.money_value', 1),
                'bundle_value' => (int) config('zomboid.money_deposit.bundle_value', 100),
            ],
        ];
    }

    /**
     * @return array{ok: bool, error: ?string}
     */
    private function probeWrite(string $path): array
    {
        if (! is_dir($path)) {
            return ['ok' => false, 'error' => 'bridge path missing'];
        }

        $probe = rtrim($path, '/\\').'/.bridge_health_probe';
        try {
            if (! LuaBridgeFile::writeAtomic($probe, (string) time())) {
                return ['ok' => false, 'error' => 'atomic write failed'];
            }
            @unlink($probe);

            return ['ok' => true, 'error' => null];
        } catch (\Throwable $e) {
            return ['ok' => false, 'error' => $e->getMessage()];
        }
    }

    private function mode(string $path): ?int
    {
        $perms = @fileperms($path);
        if ($perms === false) {
            return null;
        }

        return $perms & 0o7777;
    }

    /**
     * @return list<string>
     */
    private function recentBridgeErrorsFromLogs(): array
    {
        try {
            /** @var DockerManager $docker */
            $docker = app(DockerManager::class);
            $lines = $docker->getContainerLogs(200);
        } catch (\Throwable) {
            return [];
        }

        $out = [];
        foreach (array_reverse($lines) as $line) {
            if (stripos($line, '[KnoxRelay]') === false) {
                continue;
            }
            if (stripos($line, 'ERROR') === false && stripos($line, 'CRITICAL') === false && stripos($line, 'WARNING') === false) {
                continue;
            }
            $out[] = $line;
            if (count($out) >= 25) {
                break;
            }
        }

        return array_reverse($out);
    }
}
