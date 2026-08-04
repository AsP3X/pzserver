<?php

namespace App\Services;

use App\Support\LuaBridgeFile;
use Illuminate\Support\Str;

/**
 * Queues world-scoped actions for the Lua mod: weather, and anything else that
 * acts on the map rather than on one player's inventory.
 *
 * Kept apart from DeliveryQueueManager because that queue is money-critical and
 * every entry in it is addressed to a player who must be online.
 */
class WorldActionManager
{
    /** Longest storm the panel will queue, matching the mod's own cap. */
    public const MAX_STORM_HOURS = 24;

    private string $queuePath;

    private string $resultsPath;

    public function __construct(?string $queuePath = null, ?string $resultsPath = null)
    {
        $this->queuePath = $queuePath ?? config('zomboid.lua_bridge.world_actions');
        $this->resultsPath = $resultsPath ?? config('zomboid.lua_bridge.world_results');
    }

    /**
     * @return array{id: string, action: string, duration_hours: int, status: string, created_at: string}
     */
    public function triggerStorm(int $hours = 3): array
    {
        return $this->queue('storm', [
            'duration_hours' => max(1, min(self::MAX_STORM_HOURS, $hours)),
        ]);
    }

    /**
     * @return array{id: string, action: string, status: string, created_at: string}
     */
    public function clearWeather(): array
    {
        return $this->queue('clear_weather');
    }

    /**
     * Pending entries the mod has not reported on yet.
     *
     * @return array<int, array<string, mixed>>
     */
    public function pending(): array
    {
        $reported = array_column($this->results(), 'id');

        return array_values(array_filter(
            $this->read($this->queuePath)['entries'] ?? [],
            fn (array $entry) => ($entry['status'] ?? '') === 'pending'
                && ! in_array($entry['id'], $reported, true),
        ));
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function results(int $limit = 20): array
    {
        $results = $this->read($this->resultsPath)['results'] ?? [];

        return array_slice(array_reverse($results), 0, $limit);
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    private function queue(string $action, array $payload = []): array
    {
        $entry = [
            'id' => (string) Str::uuid(),
            'action' => $action,
            ...$payload,
            'status' => 'pending',
            'created_at' => now()->toIso8601String(),
        ];

        $queue = $this->read($this->queuePath);
        $entries = $queue['entries'] ?? [];
        $entries[] = $entry;

        /**
         * Trim entries the mod has already reported on. The queue file is the
         * inbox, not the history — results.json is the record.
         */
        $reported = array_column($this->results(100), 'id');
        $entries = array_values(array_filter(
            $entries,
            fn (array $candidate) => ! in_array($candidate['id'], $reported, true),
        ));

        LuaBridgeFile::writeJsonAtomic($this->queuePath, [
            'entries' => $entries,
            'updated_at' => now()->toIso8601String(),
        ]);

        return $entry;
    }

    /**
     * @return array<string, mixed>
     */
    private function read(string $path): array
    {
        if (! is_file($path)) {
            return [];
        }

        $content = file_get_contents($path);
        if ($content === false) {
            return [];
        }

        $data = json_decode($content, true);

        return json_last_error() === JSON_ERROR_NONE && is_array($data) ? $data : [];
    }
}
