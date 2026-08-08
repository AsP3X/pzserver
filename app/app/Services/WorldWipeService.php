<?php

namespace App\Services;

use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Process;

/**
 * Wipe Project Zomboid world/player save data while preserving server configuration.
 *
 * Kept (PZ "how the world behaves"):
 * - Server/{name}.ini
 * - Server/{name}_SandboxVars.lua  (zombies, loot, environment, etc.)
 * - Server/{name}_spawnpoints.lua
 * - Server/{name}_spawnregions.lua
 * - Server/.mod_state* / .config_state* (mod + Map= persistence)
 *
 * Cleared (world + characters + accounts that would restore the old world):
 * - Saves/Multiplayer/*  (map chunks, players.db, vehicles, zpop, …)
 * - db/{name}.db (+ shm/wal)  (whitelist / account DB for that server)
 * - backups/startup, backups/version  (PZ auto-restores worlds from these)
 * - Lua bridge live state (inventory exports, positions, queues)
 */
class WorldWipeService
{
    /**
     * @return array{
     *     ok: bool,
     *     deleted: list<string>,
     *     preserved: list<string>,
     *     errors: list<string>,
     *     save_path: string,
     *     server_name: string
     * }
     */
    public function wipeSaveData(): array
    {
        $dataPath = rtrim((string) config('zomboid.paths.data', '/pz-data'), '/');
        $serverName = (string) config('zomboid.server_name', 'ZomboidServer');

        $deleted = [];
        $errors = [];
        $preserved = $this->listPreservedConfigs($dataPath, $serverName);

        // 1) Multiplayer world saves (all worlds under Multiplayer — not just current name)
        $multiplayerRoot = $dataPath.'/Saves/Multiplayer';
        if (is_dir($multiplayerRoot)) {
            foreach ($this->listChildren($multiplayerRoot) as $child) {
                if ($this->forceRemove($child)) {
                    $deleted[] = $child;
                } else {
                    $errors[] = "Failed to delete save path: {$child}";
                }
            }
        }

        // Named path (in case Multiplayer root missing but path known)
        $savePath = "{$dataPath}/Saves/Multiplayer/{$serverName}";
        if (file_exists($savePath) || is_link($savePath)) {
            if ($this->forceRemove($savePath)) {
                $deleted[] = $savePath;
            } else {
                $errors[] = "Failed to delete primary save path: {$savePath}";
            }
        }

        // 2) Account / whitelist DB for this server name
        $dbPath = "{$dataPath}/db/{$serverName}.db";
        foreach ([$dbPath, "{$dbPath}-shm", "{$dbPath}-wal"] as $dbFile) {
            if (file_exists($dbFile) || is_link($dbFile)) {
                if ($this->forceRemove($dbFile)) {
                    $deleted[] = $dbFile;
                } else {
                    $errors[] = "Failed to delete database file: {$dbFile}";
                }
            }
        }

        // Also remove legacy serverPZ.db if present (older naming)
        $legacyDb = $dataPath.'/db/serverPZ.db';
        foreach ([$legacyDb, "{$legacyDb}-shm", "{$legacyDb}-wal"] as $dbFile) {
            if (file_exists($dbFile) || is_link($dbFile)) {
                if ($this->forceRemove($dbFile)) {
                    $deleted[] = $dbFile;
                }
            }
        }

        // 3) PZ auto-restore archives (if left, PZ can recreate the old world on boot)
        foreach (['startup', 'version', 'periodic', 'onVersion'] as $backupKind) {
            $dir = "{$dataPath}/backups/{$backupKind}";
            if (is_dir($dir)) {
                foreach ($this->listChildren($dir) as $child) {
                    if ($this->forceRemove($child)) {
                        $deleted[] = $child;
                    } else {
                        $errors[] = "Failed to delete PZ backup: {$child}";
                    }
                }
            }
        }

        // 4) Soft-reset / worldgen leftovers under Saves if any
        $savesRoot = $dataPath.'/Saves';
        if (is_dir($savesRoot)) {
            foreach ($this->listChildren($savesRoot) as $child) {
                $base = basename($child);
                // Keep Multiplayer directory shell; contents already cleared
                if ($base === 'Multiplayer') {
                    continue;
                }
                // Single-player leftovers etc.
                if ($this->forceRemove($child)) {
                    $deleted[] = $child;
                }
            }
        }

        // 5) Lua bridge live/player state (world-tied); keep directory structure
        $luaRoot = $dataPath.'/Lua';
        if (is_dir($luaRoot)) {
            foreach ($this->listChildren($luaRoot) as $child) {
                $base = basename($child);
                if ($base === '.gitkeep') {
                    continue;
                }
                if (is_dir($child) && $base === 'inventory') {
                    foreach ($this->listChildren($child) as $invFile) {
                        if ($this->forceRemove($invFile)) {
                            $deleted[] = $invFile;
                        }
                    }

                    continue;
                }
                if (is_file($child) && str_ends_with($base, '.json')) {
                    // Truncate JSON bridge files rather than delete (mod expects them)
                    if (@file_put_contents($child, '') !== false) {
                        $deleted[] = $child.' (cleared)';
                    } else {
                        $errors[] = "Failed to clear Lua bridge file: {$child}";
                    }
                }
            }
        }

        // Verify primary save is gone
        if (is_dir($savePath)) {
            $errors[] = "Primary save directory still exists after wipe: {$savePath}";
        }

        $ok = $errors === [];

        Log::info('World wipe completed', [
            'ok' => $ok,
            'server_name' => $serverName,
            'deleted_count' => count($deleted),
            'preserved_count' => count($preserved),
            'errors' => $errors,
        ]);

        return [
            'ok' => $ok,
            'deleted' => $deleted,
            'preserved' => $preserved,
            'errors' => $errors,
            'save_path' => $savePath,
            'server_name' => $serverName,
        ];
    }

    /**
     * Config files that must survive a wipe.
     *
     * @return list<string>
     */
    public function listPreservedConfigs(?string $dataPath = null, ?string $serverName = null): array
    {
        $dataPath = rtrim($dataPath ?? (string) config('zomboid.paths.data', '/pz-data'), '/');
        $serverName = $serverName ?? (string) config('zomboid.server_name', 'ZomboidServer');
        $serverDir = $dataPath.'/Server';

        $candidates = [
            "{$serverDir}/{$serverName}.ini",
            "{$serverDir}/{$serverName}_SandboxVars.lua",
            "{$serverDir}/{$serverName}_spawnpoints.lua",
            "{$serverDir}/{$serverName}_spawnregions.lua",
            "{$serverDir}/.mod_state",
            "{$serverDir}/.mod_state_applied",
            "{$serverDir}/.mod_state_backup",
            "{$serverDir}/.config_state",
        ];

        $found = [];
        foreach ($candidates as $path) {
            if (is_file($path)) {
                $found[] = $path;
            }
        }

        return $found;
    }

    /**
     * @return list<string>
     */
    private function listChildren(string $dir): array
    {
        $items = @scandir($dir);
        if ($items === false) {
            return [];
        }

        $out = [];
        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            $out[] = $dir.DIRECTORY_SEPARATOR.$item;
        }

        return $out;
    }

    private function forceRemove(string $path): bool
    {
        if (! file_exists($path) && ! is_link($path)) {
            return true;
        }

        // Make writable then remove (game process may create root-owned files)
        if (is_dir($path) && ! is_link($path)) {
            Process::run(['chmod', '-R', 'a+rwx', $path]);
            $result = Process::run(['rm', '-rf', $path]);
            if ($result->successful() && ! file_exists($path)) {
                return true;
            }

            return $this->phpRemoveDirectory($path);
        }

        Process::run(['chmod', 'a+w', $path]);
        if (@unlink($path)) {
            return true;
        }

        $result = Process::run(['rm', '-f', $path]);

        return $result->successful() && ! file_exists($path);
    }

    private function phpRemoveDirectory(string $dir): bool
    {
        if (! is_dir($dir)) {
            return ! file_exists($dir);
        }

        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST,
        );

        foreach ($iterator as $file) {
            $path = $file->getPathname();
            if ($file->isDir()) {
                @rmdir($path);
            } else {
                @chmod($path, 0666);
                @unlink($path);
            }
        }

        @chmod($dir, 0777);

        return @rmdir($dir) || ! is_dir($dir);
    }
}
