<?php

namespace App\Services;

use App\Enums\UserRole;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Schema;

/**
 * Wipe Project Zomboid world/player save data + website player accounts,
 * while preserving server sandbox/spawn config and staff/site/shop catalog.
 *
 * Kept (PZ "how the world behaves"):
 * - Server/{name}.ini
 * - Server/{name}_SandboxVars.lua  (zombies, loot, environment, etc.)
 * - Server/{name}_spawnpoints.lua
 * - Server/{name}_spawnregions.lua
 * - Server/.mod_state* / .config_state* (mod + Map= persistence)
 *
 * Kept (website):
 * - staff users (super_admin, admin, moderator)
 * - shop catalog, site settings, translations, news, backups metadata, audit logs
 *
 * Cleared (world + characters + website players):
 * - Saves/Multiplayer/*, db/{name}.db, PZ auto-restore backups, Lua bridge state
 * - users with role=player and related wallets/vaults/purchases/whitelist/stats/events
 */
class WorldWipeService
{
    /**
     * Full wipe: filesystem saves + website player data.
     *
     * @return array{
     *     ok: bool,
     *     filesystem: array<string, mixed>,
     *     website: array<string, mixed>
     * }
     */
    public function wipeAll(): array
    {
        $filesystem = $this->wipeSaveData();
        $website = $this->wipeWebsitePlayerData();

        return [
            'ok' => $filesystem['ok'] && $website['ok'],
            'filesystem' => $filesystem,
            'website' => $website,
        ];
    }

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
     * Delete website player accounts and all related player data.
     * Keeps staff accounts and non-player site configuration (shop catalog, settings, etc.).
     *
     * @return array{
     *     ok: bool,
     *     players_deleted: int,
     *     counts: array<string, int>,
     *     errors: list<string>
     * }
     */
    public function wipeWebsitePlayerData(): array
    {
        $counts = [];
        $errors = [];
        $playersDeleted = 0;

        try {
            DB::transaction(function () use (&$counts, &$playersDeleted): void {
                $playerIds = User::query()
                    ->where('role', UserRole::Player)
                    ->pluck('id')
                    ->map(fn ($id): int => (int) $id)
                    ->all();

                // Username-keyed / world-tied tables (no user FK)
                $counts['game_events'] = $this->truncateIfExists('game_events');
                $counts['player_stats'] = $this->truncateIfExists('player_stats');
                $counts['pvp_violations'] = $this->truncateIfExists('pvp_violations');
                $counts['vehicle_key_holders'] = $this->truncateIfExists('vehicle_key_holders');

                if ($playerIds === []) {
                    // Still clear orphan whitelist rows not linked to staff
                    $counts['whitelist_entries'] = $this->deleteWhereInOrNullUser('whitelist_entries', []);
                    $playersDeleted = 0;

                    return;
                }

                // Shop: deliveries → purchases (null wallet TX first — restrictOnDelete)
                if (Schema::hasTable('shop_purchases')) {
                    $purchaseIds = DB::table('shop_purchases')->whereIn('user_id', $playerIds)->pluck('id')->all();
                    if ($purchaseIds !== [] && Schema::hasTable('shop_deliveries')) {
                        $counts['shop_deliveries'] = DB::table('shop_deliveries')
                            ->whereIn('shop_purchase_id', $purchaseIds)
                            ->delete();
                    }
                    if (Schema::hasColumn('shop_purchases', 'wallet_transaction_id')) {
                        DB::table('shop_purchases')
                            ->whereIn('user_id', $playerIds)
                            ->update(['wallet_transaction_id' => null]);
                    }
                    $counts['shop_purchases'] = DB::table('shop_purchases')->whereIn('user_id', $playerIds)->delete();
                }

                // Vaults (items/transactions cascade via FK when vault deleted — do children first if needed)
                if (Schema::hasTable('vaults')) {
                    $vaultIds = DB::table('vaults')->whereIn('user_id', $playerIds)->pluck('id')->all();
                    if ($vaultIds !== []) {
                        if (Schema::hasTable('vault_transactions')) {
                            // null wallet_transaction_id if restricted
                            if (Schema::hasColumn('vault_transactions', 'wallet_transaction_id')) {
                                DB::table('vault_transactions')
                                    ->whereIn('vault_id', $vaultIds)
                                    ->update(['wallet_transaction_id' => null]);
                            }
                            $counts['vault_transactions'] = DB::table('vault_transactions')
                                ->whereIn('vault_id', $vaultIds)
                                ->delete();
                        }
                        if (Schema::hasTable('vault_items')) {
                            $counts['vault_items'] = DB::table('vault_items')
                                ->whereIn('vault_id', $vaultIds)
                                ->delete();
                        }
                        $counts['vaults'] = DB::table('vaults')->whereIn('user_id', $playerIds)->delete();
                    }
                }

                // Wallets
                if (Schema::hasTable('wallets')) {
                    $walletIds = DB::table('wallets')->whereIn('user_id', $playerIds)->pluck('id')->all();
                    if ($walletIds !== [] && Schema::hasTable('wallet_transactions')) {
                        $counts['wallet_transactions'] = DB::table('wallet_transactions')
                            ->whereIn('wallet_id', $walletIds)
                            ->delete();
                    }
                    $counts['wallets'] = DB::table('wallets')->whereIn('user_id', $playerIds)->delete();
                }

                if (Schema::hasTable('money_deposits')) {
                    $counts['money_deposits'] = DB::table('money_deposits')->whereIn('user_id', $playerIds)->delete();
                }
                if (Schema::hasTable('reward_claims')) {
                    $counts['reward_claims'] = DB::table('reward_claims')->whereIn('user_id', $playerIds)->delete();
                }
                if (Schema::hasTable('player_reports')) {
                    $counts['player_reports'] = DB::table('player_reports')->whereIn('user_id', $playerIds)->delete();
                }
                if (Schema::hasTable('whitelist_entries')) {
                    $counts['whitelist_entries'] = DB::table('whitelist_entries')
                        ->where(function ($q) use ($playerIds): void {
                            $q->whereIn('user_id', $playerIds)->orWhereNull('user_id');
                        })
                        ->delete();
                }
                if (Schema::hasTable('personal_access_tokens')) {
                    $counts['personal_access_tokens'] = DB::table('personal_access_tokens')
                        ->where('tokenable_type', User::class)
                        ->whereIn('tokenable_id', $playerIds)
                        ->delete();
                }
                if (Schema::hasTable('sessions')) {
                    $counts['sessions'] = DB::table('sessions')->whereIn('user_id', $playerIds)->delete();
                }

                $playersDeleted = User::query()->whereIn('id', $playerIds)->delete();
                $counts['users'] = $playersDeleted;
            });
        } catch (\Throwable $e) {
            Log::error('Website player wipe failed', ['error' => $e->getMessage()]);
            $errors[] = $e->getMessage();
        }

        $ok = $errors === [];

        Log::info('Website player wipe completed', [
            'ok' => $ok,
            'players_deleted' => $playersDeleted,
            'counts' => $counts,
            'errors' => $errors,
        ]);

        return [
            'ok' => $ok,
            'players_deleted' => $playersDeleted,
            'counts' => $counts,
            'errors' => $errors,
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

    private function truncateIfExists(string $table): int
    {
        if (! Schema::hasTable($table)) {
            return 0;
        }

        return DB::table($table)->delete();
    }

    /**
     * @param  list<int|string>  $userIds
     */
    private function deleteWhereInOrNullUser(string $table, array $userIds): int
    {
        if (! Schema::hasTable($table)) {
            return 0;
        }

        return DB::table($table)
            ->where(function ($q) use ($userIds): void {
                if ($userIds !== []) {
                    $q->whereIn('user_id', $userIds);
                }
                $q->orWhereNull('user_id');
            })
            ->delete();
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
