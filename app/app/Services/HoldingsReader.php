<?php

namespace App\Services;

/**
 * Claimed safehouses and factions, as the Lua mod last saw them.
 *
 * Everything here is read-only. Claims are the game's own state — the panel
 * shows who holds what, it does not hand out territory.
 */
class HoldingsReader
{
    private string $path;

    public function __construct(?string $path = null)
    {
        $this->path = $path ?? config('zomboid.lua_bridge.holdings');
    }

    /**
     * @return array{
     *     timestamp: string|null,
     *     safehouses: array<int, array{title: string, owner: string|null, members: array<int, string>, x: int, y: int, x2: int, y2: int}>,
     *     factions: array<int, array{name: string, tag: string|null, owner: string|null, members: array<int, string>}>
     * }
     */
    public function read(): array
    {
        $empty = ['timestamp' => null, 'safehouses' => [], 'factions' => []];

        if (! is_file($this->path)) {
            return $empty;
        }

        $content = file_get_contents($this->path);
        if ($content === false) {
            return $empty;
        }

        $data = json_decode($content, true);
        if (json_last_error() !== JSON_ERROR_NONE || ! is_array($data)) {
            return $empty;
        }

        return [
            'timestamp' => $data['timestamp'] ?? null,
            'safehouses' => array_values(array_map($this->normaliseSafehouse(...), $data['safehouses'] ?? [])),
            'factions' => array_values($data['factions'] ?? []),
        ];
    }

    /**
     * Who is entitled to be inside a claim: the owner plus every member.
     *
     * @return array<int, string>
     */
    public function membersOf(array $safehouse): array
    {
        $members = $safehouse['members'] ?? [];

        if (! empty($safehouse['owner'])) {
            $members[] = $safehouse['owner'];
        }

        return array_values(array_unique($members));
    }

    /**
     * The claim containing a point, or null. Bounds are half-open on x2/y2,
     * matching how the game stores them.
     *
     * @return array<string, mixed>|null
     */
    public function claimAt(float $x, float $y): ?array
    {
        foreach ($this->read()['safehouses'] as $safehouse) {
            if ($x >= $safehouse['x'] && $x < $safehouse['x2']
                && $y >= $safehouse['y'] && $y < $safehouse['y2']
            ) {
                return $safehouse;
            }
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $safehouse
     * @return array<string, mixed>
     */
    private function normaliseSafehouse(array $safehouse): array
    {
        return [
            'title' => (string) ($safehouse['title'] ?? 'Safehouse'),
            'owner' => $safehouse['owner'] ?? null,
            'members' => array_values(array_map('strval', $safehouse['members'] ?? [])),
            'x' => (int) ($safehouse['x'] ?? 0),
            'y' => (int) ($safehouse['y'] ?? 0),
            'x2' => (int) ($safehouse['x2'] ?? 0),
            'y2' => (int) ($safehouse['y2'] ?? 0),
        ];
    }
}
