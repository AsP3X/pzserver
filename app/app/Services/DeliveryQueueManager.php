<?php

namespace App\Services;

use App\Support\LuaBridgeFile;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class DeliveryQueueManager
{
    private string $queuePath;

    private string $resultsPath;

    public function __construct(
        private readonly RconClient $rcon,
        private readonly OnlinePlayersReader $onlinePlayers,
        private readonly InventoryReader $inventoryReader,
        ?string $queuePath = null,
        ?string $resultsPath = null,
    ) {
        $this->queuePath = $queuePath ?? config('zomboid.lua_bridge.delivery_queue');
        $this->resultsPath = $resultsPath ?? config('zomboid.lua_bridge.delivery_results');
    }

    /**
     * Give item to player. Tries RCON for instant delivery if the player is online,
     * falls back to the Lua delivery queue otherwise.
     *
     * @return array{id: string, action: string, username: string, item_type: string, count: int, status: string, created_at: string}
     */
    public function giveItem(string $username, string $itemType, int $count = 1): array
    {
        if ($this->tryRconAddItem($username, $itemType, $count)) {
            return $this->makeEntry('give', $username, $itemType, $count, 'delivered');
        }

        return $this->addEntry('give', $username, $itemType, $count);
    }

    /**
     * Give item to player with Lua-side verification (count before/after).
     * Always queues to Lua — no RCON fast path — so delivery can be verified.
     *
     * @return array{id: string, action: string, username: string, item_type: string, count: int, status: string, created_at: string}
     */
    public function giveItemVerified(string $username, string $itemType, int $count = 1): array
    {
        return $this->addEntry('give_verified', $username, $itemType, $count);
    }

    /**
     * Remove items via Lua delivery queue.
     * PZ RCON removeitem is self-only (no player targeting), so removal always goes through Lua.
     *
     * @return array{id: string, action: string, username: string, item_type: string, count: int, status: string, created_at: string}
     */
    public function removeItem(string $username, string $itemType, int $count = 1): array
    {
        return $this->addEntry('remove', $username, $itemType, $count);
    }

    /**
     * Remove items via Lua with a full report of what actually came out.
     *
     * Unlike removeItem(), a partial removal is not an error — Lua reports the
     * exact items removed so the caller can credit precisely that much.
     *
     * @return array{id: string, action: string, username: string, item_type: string, count: int, status: string, created_at: string}
     */
    public function removeItemVerified(string $username, string $itemType, int $count = 1): array
    {
        return $this->addEntry('remove_verified', $username, $itemType, $count);
    }

    /**
     * Give items and restore a specific condition fraction on each.
     *
     * @return array{id: string, action: string, username: string, item_type: string, count: int, condition: float, status: string, created_at: string}
     */
    public function giveItemWithCondition(string $username, string $itemType, int $count, float $condition): array
    {
        return $this->addEntry('give_with_condition', $username, $itemType, $count, ['condition' => $condition]);
    }

    /**
     * Read the current delivery queue.
     *
     * @return array{version: int, updated_at: string, entries: array<int, array{id: string, action: string, username: string, item_type: string, count: int, status: string, created_at: string}>}
     */
    public function readQueue(): array
    {
        return $this->readJsonFile($this->queuePath, ['version' => 1, 'updated_at' => '', 'entries' => []]);
    }

    /**
     * Read the delivery results written by Lua.
     *
     * @return array{version: int, updated_at: string, results: array<int, array{id: string, status: string, processed_at: string, message: string|null}>}
     */
    public function readResults(): array
    {
        return $this->readJsonFile($this->resultsPath, ['version' => 1, 'updated_at' => '', 'results' => []]);
    }

    /**
     * Remove all entries from the delivery queue.
     */
    public function cleanupQueue(): bool
    {
        return $this->writeJsonFileAtomic($this->queuePath, [
            'version' => 1,
            'updated_at' => date('c'),
            'entries' => [],
        ]);
    }

    /**
     * Remove all entries from the delivery results.
     */
    public function cleanupResults(): bool
    {
        return $this->writeJsonFileAtomic($this->resultsPath, [
            'version' => 1,
            'updated_at' => date('c'),
            'results' => [],
        ]);
    }

    /**
     * Queue position / pending deliveries for a player (1-based position among pending entries).
     *
     * @return array{pending_count: int, position: ?int, total_pending: int, entries: list<array<string, mixed>>}
     */
    public function queueStatusForUsername(string $username): array
    {
        $queue = $this->readQueue();
        $pending = array_values(array_filter(
            $queue['entries'] ?? [],
            fn ($e) => ($e['status'] ?? 'pending') === 'pending',
        ));

        $mine = [];
        $position = null;
        foreach ($pending as $i => $entry) {
            if (($entry['username'] ?? '') === $username) {
                if ($position === null) {
                    $position = $i + 1;
                }
                $mine[] = $entry;
            }
        }

        return [
            'pending_count' => count($mine),
            'position' => $position,
            'total_pending' => count($pending),
            'entries' => $mine,
        ];
    }

    /**
     * Check if the player is currently online.
     */
    private function isPlayerOnline(string $username): bool
    {
        try {
            return in_array($username, $this->onlinePlayers->getOnlineUsernames(), true);
        } catch (\Throwable) {
            return false;
        }
    }

    /**
     * Try to give items via RCON additem command (instant delivery for online players).
     */
    private function tryRconAddItem(string $username, string $itemType, int $count): bool
    {
        if (! $this->isPlayerOnline($username)) {
            return false;
        }

        try {
            $this->rcon->connect();
            $safeCount = (int) $count;
            $this->rcon->command('additem "'.RconSanitizer::playerName($username).'" "'.RconSanitizer::itemId($itemType)."\" {$safeCount}");
            Log::info("[DeliveryQueue] RCON additem: {$count}x {$itemType} to {$username}");

            // Request inventory re-export so web sees the change
            $this->inventoryReader->requestExport($username);

            return true;
        } catch (\Throwable $e) {
            Log::debug("[DeliveryQueue] RCON additem failed, falling back to queue: {$e->getMessage()}");

            return false;
        }
    }

    /**
     * Build an entry array without writing to the queue file.
     */
    private function makeEntry(string $action, string $username, string $itemType, int $count, string $status): array
    {
        return [
            'id' => Str::uuid()->toString(),
            'action' => $action,
            'username' => $username,
            'item_type' => $itemType,
            'count' => $count,
            'status' => $status,
            'created_at' => date('c'),
        ];
    }

    /**
     * Add an entry to the delivery queue with atomic write.
     *
     * @param  array<string, mixed>  $extra  Additional fields merged into the entry
     */
    private function addEntry(string $action, string $username, string $itemType, int $count, array $extra = []): array
    {
        $queue = $this->readQueue();

        $entry = [
            'id' => Str::uuid()->toString(),
            'action' => $action,
            'username' => $username,
            'item_type' => $itemType,
            'count' => $count,
            'status' => 'pending',
            'created_at' => date('c'),
            ...$extra,
        ];

        $queue['entries'][] = $entry;
        $queue['updated_at'] = date('c');

        $this->writeJsonFileAtomic($this->queuePath, $queue);

        return $entry;
    }

    /**
     * Read and decode a JSON file, returning default on failure.
     */
    private function readJsonFile(string $path, array $default): array
    {
        if (! file_exists($path)) {
            return $default;
        }

        $content = file_get_contents($path);
        if ($content === false) {
            return $default;
        }

        $data = json_decode($content, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            return $default;
        }

        return $data;
    }

    /**
     * Write JSON data atomically using temp file + rename (world-writable for game UID).
     */
    private function writeJsonFileAtomic(string $path, array $data): bool
    {
        return LuaBridgeFile::writeJsonAtomic($path, $data);
    }
}
