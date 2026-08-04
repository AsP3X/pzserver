<?php

use App\Enums\BackupType;
use App\Jobs\CreateBackupJob;
use Illuminate\Support\Facades\Schedule;

Schedule::job(new CreateBackupJob(BackupType::Scheduled))
    ->everyFourHours()
    ->when(function () {
        try {
            return cache()->get('backup.schedule.hourly_enabled', true);
        } catch (\Throwable) {
            return true;
        }
    });

Schedule::command('pz:sync-accounts')->everyFiveMinutes();

Schedule::command('zomboid:sync-player-stats')->everyTenMinutes();

Schedule::command('zomboid:auto-restart-check')->everyMinute();

Schedule::command('zomboid:send-broadcasts')->everyMinute();

Schedule::command('zomboid:import-pvp-violations')->everyFiveMinutes();

Schedule::command('zomboid:import-pvp-kills')->everyFiveMinutes();

Schedule::command('zomboid:process-respawn-kicks')->everyFiveMinutes();

Schedule::command('zomboid:parse-game-events')->everyFiveMinutes();

// Deliberately after the log parser: the log records that someone died, this
// records why. Whichever lands first, the other enriches it instead of
// inserting a second row for the same death.
Schedule::command('zomboid:import-deaths')->everyFiveMinutes();

Schedule::command('zomboid:process-shop-deliveries')->everyMinute();

Schedule::command('zomboid:process-money-deposits')->everyMinute();

// Keep Lua bridge world-writable (PHP + game share the bind mount)
Schedule::command('zomboid:heal-lua-bridge')->everyFiveMinutes();

// Periodic B42 catalog touch so shop item metadata stays fresh after updates
Schedule::command('zomboid:refresh-item-catalog')
    ->dailyAt('05:15')
    ->runInBackground();

// Map tiles are intentionally NOT scheduled — generation is heavy and opt-in only
// (docker exec -it pz-app php artisan zomboid:generate-map-tiles, or Admin → Player map button).
// After render, tiles are packed into a single tiles.sqlite under PZ_MAP_TILES_PATH.

Schedule::command('zomboid:download-item-icons')
    ->hourly()
    ->when(function () {
        $catalog = config('zomboid.lua_bridge.items_catalog');

        return file_exists($catalog) && ! glob(public_path('images/items/*.png'));
    })
    ->runInBackground();

Schedule::job(new CreateBackupJob(BackupType::Daily))
    ->dailyAt('04:00')
    ->when(function () {
        try {
            return cache()->get('backup.schedule.daily_enabled', true);
        } catch (\Throwable) {
            return true;
        }
    });
