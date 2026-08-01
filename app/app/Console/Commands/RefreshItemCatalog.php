<?php

namespace App\Console\Commands;

use App\Support\LuaBridgeFile;
use Illuminate\Console\Command;

/**
 * Touch/request a fresh items catalog export from the game by clearing stale
 * catalog and writing an empty shell; game ZM_ItemCatalog rewrites on next tick.
 * Also re-downloads icons if catalog has entries.
 */
class RefreshItemCatalog extends Command
{
    protected $signature = 'zomboid:refresh-item-catalog {--icons : Also run icon download}';

    protected $description = 'Refresh B42 item catalog bridge file and optionally re-download icons';

    public function handle(): int
    {
        $path = (string) config('zomboid.lua_bridge.items_catalog');
        $dir = dirname($path);
        LuaBridgeFile::ensureDirectory($dir);

        $existing = [];
        if (is_file($path)) {
            $decoded = json_decode((string) file_get_contents($path), true);
            if (is_array($decoded)) {
                $existing = $decoded;
            }
        }

        $payload = [
            'version' => $existing['version'] ?? 1,
            'updated_at' => date('c'),
            'items' => $existing['items'] ?? [],
            'refresh_requested_at' => date('c'),
        ];

        if (! LuaBridgeFile::writeJsonAtomic($path, $payload)) {
            $this->error("Failed to write {$path}");

            return self::FAILURE;
        }

        $count = is_array($payload['items'] ?? null) ? count($payload['items']) : 0;
        $this->info("Item catalog refreshed ({$count} cached items). Game will rewrite when ZM_ItemCatalog runs.");

        if ($this->option('icons')) {
            $this->call('zomboid:download-item-icons');
        }

        return self::SUCCESS;
    }
}
