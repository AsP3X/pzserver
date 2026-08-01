<?php

namespace App\Console\Commands;

use App\Models\GameEvent;
use Carbon\Carbon;
use Illuminate\Console\Command;

class ImportPvpKills extends Command
{
    protected $signature = 'zomboid:import-pvp-kills';

    protected $description = 'Import PvP kills from Lua bridge JSON to the game_events table';

    public function handle(): int
    {
        $path = config('zomboid.lua_bridge.pvp_kills');

        if (! file_exists($path)) {
            return self::SUCCESS;
        }

        $content = file_get_contents($path);
        if ($content === false || $content === '') {
            return self::SUCCESS;
        }

        $data = json_decode($content, true);
        if (json_last_error() !== JSON_ERROR_NONE || empty($data['kills'])) {
            return self::SUCCESS;
        }

        $count = 0;
        foreach ($data['kills'] as $kill) {
            GameEvent::query()->create([
                'event_type' => 'pvp_kill',
                'player' => $kill['killer'] ?? 'unknown',
                'target' => $kill['victim'] ?? 'unknown',
                'x' => $kill['killer_x'] ?? null,
                'y' => $kill['killer_y'] ?? null,
                'details' => [
                    'weapon' => $kill['weapon'] ?? 'unknown',
                    'victim_x' => $kill['victim_x'] ?? null,
                    'victim_y' => $kill['victim_y'] ?? null,
                ],
                'game_time' => isset($kill['occurred_at'])
                    ? Carbon::createFromTimestamp($kill['occurred_at'])
                    : now(),
            ]);
            $count++;
        }

        // Clear the file after import
        file_put_contents($path, json_encode(['kills' => []]));

        if ($count > 0) {
            $this->info("Imported {$count} PvP kill(s).");
        }

        return self::SUCCESS;
    }
}
