<?php

namespace App\Console\Commands;

use App\Models\GameEvent;
use App\Support\LuaBridgeFile;
use Carbon\Carbon;
use Illuminate\Console\Command;

class ImportDeaths extends Command
{
    protected $signature = 'zomboid:import-deaths';

    protected $description = 'Import cause-of-death records from the Lua bridge into game_events';

    /**
     * How far apart the mod's clock and the server log's clock may be while
     * still describing the same death.
     */
    private const MATCH_WINDOW_SECONDS = 120;

    public function handle(): int
    {
        $path = config('zomboid.lua_bridge.deaths');

        if (! is_file($path)) {
            return self::SUCCESS;
        }

        $content = file_get_contents($path);
        if ($content === false || $content === '') {
            return self::SUCCESS;
        }

        $data = json_decode($content, true);
        if (json_last_error() !== JSON_ERROR_NONE || empty($data['deaths'])) {
            return self::SUCCESS;
        }

        $created = 0;
        $enriched = 0;

        foreach ($data['deaths'] as $death) {
            $this->store($death) ? $created++ : $enriched++;
        }

        LuaBridgeFile::writeJsonAtomic($path, ['deaths' => []]);

        if ($created > 0 || $enriched > 0) {
            $this->info("Imported {$created} death(s), enriched {$enriched} already logged.");
        }

        return self::SUCCESS;
    }

    /**
     * Record one death. Returns true when a new event was created, false when
     * an existing log-parsed event was enriched instead.
     *
     * The server log already produces a `death` event for every death, so
     * inserting blindly would double every entry in the feed. A death the log
     * got to first is updated in place with what only the mod can know.
     *
     * @param  array<string, mixed>  $death
     */
    private function store(array $death): bool
    {
        $username = (string) ($death['username'] ?? '');
        $occurredAt = isset($death['occurred_at'])
            ? Carbon::createFromTimestamp((int) $death['occurred_at'])
            : now();

        $details = [
            'cause' => (string) ($death['cause'] ?? 'unknown'),
            'killer' => $death['killer'] ?? null,
            'weapon' => $death['weapon'] ?? null,
            'hours_survived' => (float) ($death['hours_survived'] ?? 0),
            'zombie_kills' => (int) ($death['zombie_kills'] ?? 0),
            'world_time' => $death['world_time'] ?? null,
            'source' => 'mod',
        ];

        $existing = GameEvent::query()
            ->where('event_type', 'death')
            ->where('player', $username)
            ->whereBetween('game_time', [
                $occurredAt->copy()->subSeconds(self::MATCH_WINDOW_SECONDS),
                $occurredAt->copy()->addSeconds(self::MATCH_WINDOW_SECONDS),
            ])
            ->latest('game_time')
            ->first();

        if ($existing !== null) {
            $existing->update([
                'x' => $existing->x ?? ($death['x'] ?? null),
                'y' => $existing->y ?? ($death['y'] ?? null),
                'details' => [...($existing->details ?? []), ...$details],
            ]);

            return false;
        }

        GameEvent::query()->create([
            'event_type' => 'death',
            'player' => $username,
            'target' => $death['killer'] ?? null,
            'x' => $death['x'] ?? null,
            'y' => $death['y'] ?? null,
            'details' => $details,
            'game_time' => $occurredAt,
        ]);

        return true;
    }
}
