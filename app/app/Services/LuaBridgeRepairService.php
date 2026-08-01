<?php

namespace App\Services;

use App\Support\LuaBridgeFile;

/**
 * Self-heal permissions and placeholder files on the Lua bridge volume.
 */
class LuaBridgeRepairService
{
    /**
     * @return array{ok: bool, actions: list<string>, errors: list<string>}
     */
    public function repair(): array
    {
        $path = (string) config('zomboid.lua_bridge.path');
        $actions = [];
        $errors = [];

        $dirs = [$path, $path.'/inventory'];
        foreach ($dirs as $dir) {
            if (! is_dir($dir)) {
                if (LuaBridgeFile::ensureDirectory($dir)) {
                    $actions[] = "created {$dir}";
                } else {
                    $errors[] = "failed to create {$dir}";
                }
            } else {
                LuaBridgeFile::makeWorldWritable($dir);
                $actions[] = "chmod dir {$dir}";
            }
        }

        $placeholders = [
            'export_requests.json' => ['usernames' => [], 'updated_at' => date('c')],
            'player_stats.json' => ['players' => [], 'updated_at' => date('c')],
            'players_live.json' => ['players' => [], 'updated_at' => date('c')],
            'game_state.json' => ['updated_at' => date('c')],
            'items_catalog.json' => ['items' => [], 'updated_at' => date('c')],
            'delivery_queue.json' => ['version' => 1, 'entries' => [], 'updated_at' => date('c')],
            'delivery_results.json' => ['version' => 1, 'results' => [], 'updated_at' => date('c')],
            'deposit_requests.json' => ['version' => 1, 'requests' => [], 'updated_at' => date('c')],
            'deposit_results.json' => ['version' => 1, 'results' => [], 'updated_at' => date('c')],
            'money_deposit_config.json' => [
                'money_value' => (int) config('zomboid.money_deposit.money_value', 1),
                'bundle_value' => (int) config('zomboid.money_deposit.bundle_value', 100),
                'updated_at' => date('c'),
            ],
        ];

        foreach ($placeholders as $name => $default) {
            $full = $path.'/'.$name;
            if (! is_file($full)) {
                if (LuaBridgeFile::writeJsonAtomic($full, $default)) {
                    $actions[] = "created {$name}";
                } else {
                    $errors[] = "failed to create {$name}";
                }
            } else {
                LuaBridgeFile::makeWorldWritable($full);
                $actions[] = "chmod file {$name}";
            }
        }

        // chmod all files under bridge
        if (is_dir($path)) {
            $iterator = new \RecursiveIteratorIterator(
                new \RecursiveDirectoryIterator($path, \FilesystemIterator::SKIP_DOTS)
            );
            foreach ($iterator as $file) {
                /** @var \SplFileInfo $file */
                if ($file->isDir()) {
                    @chmod($file->getPathname(), 0777);
                } else {
                    @chmod($file->getPathname(), 0666);
                }
            }
            $actions[] = 'chmod -R bridge tree';
        }

        // Write deposit rates config for Lua
        $this->syncDepositRatesConfig();
        $actions[] = 'synced money_deposit_config.json';

        $health = app(LuaBridgeHealthService::class)->status();

        return [
            'ok' => $health['healthy'] && $errors === [],
            'actions' => $actions,
            'errors' => array_merge($errors, $health['issues']),
            'health' => $health,
        ];
    }

    public function syncDepositRatesConfig(): bool
    {
        $path = (string) config('zomboid.lua_bridge.path').'/money_deposit_config.json';

        return LuaBridgeFile::writeJsonAtomic($path, [
            'money_value' => (int) config('zomboid.money_deposit.money_value', 1),
            'bundle_value' => (int) config('zomboid.money_deposit.bundle_value', 100),
            'updated_at' => date('c'),
        ]);
    }
}
