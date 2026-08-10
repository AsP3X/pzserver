<?php

namespace App\Services;

use App\Support\LuaBridgeFile;

class InventoryReader
{
    /** Container id the Lua bridge uses for the player's own pockets. */
    private const ROOT = 'inventory';

    private string $inventoryDir;

    private string $exportRequestsPath;

    public function __construct(?string $inventoryDir = null, ?string $exportRequestsPath = null)
    {
        $this->inventoryDir = $inventoryDir ?? config('zomboid.lua_bridge.inventory_dir');
        $this->exportRequestsPath = $exportRequestsPath ?? config('zomboid.lua_bridge.export_requests');
    }

    /**
     * Get a player's inventory from their JSON snapshot.
     *
     * @return array{username: string, timestamp: string, items: array<int, array{full_type: string, name: string, category: string, count: int, condition: float|null, equipped: bool, container: string, container_id: string, contains: string|null}>, containers: array<int, array{id: string, parent: string|null, name: string, depth: int}>, weight: float, max_weight: float}|null
     */
    public function getPlayerInventory(string $username): ?array
    {
        // Nested path (preferred) or flat fallback if Lua cannot write subdirs
        $candidates = [
            $this->inventoryDir.'/'.$username.'.json',
            dirname($this->inventoryDir).'/inventory_'.$username.'.json',
        ];

        foreach ($candidates as $filePath) {
            if (! is_file($filePath)) {
                continue;
            }

            $content = file_get_contents($filePath);
            if ($content === false) {
                continue;
            }

            $data = json_decode($content, true);
            if (json_last_error() !== JSON_ERROR_NONE) {
                continue;
            }

            $items = isset($data['items']) && is_array($data['items'])
                ? array_map($this->normalizeItem(...), $data['items'])
                : [];

            $declared = is_array($data['containers'] ?? null) && $data['containers'] !== []
                ? $data['containers']
                : $this->inferContainers($items);

            $data['items'] = $items;
            $data['containers'] = $this->orderContainers($this->coverEveryItem($declared, $items));

            return $data;
        }

        return null;
    }

    /**
     * Items with no durability concept are written without a condition at all.
     * Spell that as an explicit null so the dashboard can tell "no durability"
     * apart from a pristine 100%.
     *
     * Snapshots written before the bridge reported container ids fall back to
     * addressing containers by name, which is what the dashboard used to do.
     *
     * @param  array<string, mixed>  $item
     * @return array<string, mixed>
     */
    private function normalizeItem(array $item): array
    {
        $condition = $item['condition'] ?? null;

        $item['condition'] = is_numeric($condition) ? (float) $condition : null;
        $item['container'] = (string) ($item['container'] ?? self::ROOT);
        $item['container_id'] = (string) ($item['container_id'] ?? $item['container']);
        $item['contains'] = isset($item['contains']) ? (string) $item['contains'] : null;

        return $item;
    }

    /**
     * Rebuild the container tree for a snapshot written before the bridge
     * reported one, by matching each container's name against the item that
     * carries it. Two bags sharing a name are indistinguishable this way —
     * which is exactly why the bridge now sends ids — but an older snapshot
     * still reads as well as it ever did.
     *
     * @param  array<int, array<string, mixed>>  $items
     * @return array<int, array<string, mixed>>
     */
    private function inferContainers(array $items): array
    {
        $names = [];
        foreach ($items as $item) {
            $names[(string) $item['container']] = true;
        }

        unset($names[self::ROOT]);

        $containers = [['id' => self::ROOT, 'parent' => null, 'name' => self::ROOT]];

        foreach (array_keys($names) as $name) {
            $parent = null;

            foreach ($items as $item) {
                if ($item['name'] === $name && $item['container'] !== $name) {
                    $parent = (string) $item['container'];
                    break;
                }
            }

            $containers[] = [
                'id' => $name,
                'parent' => $parent ?? self::ROOT,
                'name' => $name,
            ];
        }

        return $containers;
    }

    /**
     * Give every container an item points at a node of its own, so a bag the
     * bridge failed to describe hides its contents from nobody. The player's
     * own pockets are always present, even for an empty inventory.
     *
     * @param  array<int, array<string, mixed>>  $containers
     * @param  array<int, array<string, mixed>>  $items
     * @return array<int, array<string, mixed>>
     */
    private function coverEveryItem(array $containers, array $items): array
    {
        $known = [];
        foreach ($containers as $container) {
            $known[(string) ($container['id'] ?? '')] = true;
        }

        if (! isset($known[self::ROOT])) {
            array_unshift($containers, ['id' => self::ROOT, 'parent' => null, 'name' => self::ROOT]);
            $known[self::ROOT] = true;
        }

        foreach ($items as $item) {
            $id = (string) $item['container_id'];

            if (isset($known[$id])) {
                continue;
            }

            $known[$id] = true;
            $containers[] = [
                'id' => $id,
                'parent' => self::ROOT,
                'name' => (string) $item['container'],
            ];
        }

        return $containers;
    }

    /**
     * Flatten the container tree depth-first so each bag is listed straight
     * after the bag holding it, stamping every node with its nesting depth.
     *
     * Nodes whose parent is missing, or that sit in a cycle the game should
     * never produce, are pulled up to the top level rather than dropped.
     *
     * @param  array<int, array<string, mixed>>  $containers
     * @return array<int, array<string, mixed>>
     */
    private function orderContainers(array $containers): array
    {
        /** @var array<string, array<string, mixed>> $byId */
        $byId = [];
        foreach ($containers as $container) {
            $id = (string) ($container['id'] ?? '');
            if ($id !== '' && ! isset($byId[$id])) {
                $container['id'] = $id;
                $container['name'] = (string) ($container['name'] ?? $id);
                $byId[$id] = $container;
            }
        }

        /** @var array<string, array<int, string>> $children */
        $children = [];
        $roots = [];

        foreach ($byId as $id => $container) {
            $parent = $container['parent'] ?? null;
            $parent = is_string($parent) ? $parent : null;

            if ($parent === null || $parent === $id || ! isset($byId[$parent])) {
                $roots[] = $id;

                continue;
            }

            $children[$parent][] = $id;
        }

        /** The player's own pockets lead, whatever order the snapshot arrived in. */
        usort($roots, fn (string $a, string $b): int => ($b === self::ROOT ? 1 : 0) <=> ($a === self::ROOT ? 1 : 0));

        $ordered = [];
        $visited = [];

        $descend = function (string $id, int $depth) use (&$descend, &$ordered, &$visited, $byId, $children): void {
            if (isset($visited[$id])) {
                return;
            }
            $visited[$id] = true;

            $ordered[] = [...$byId[$id], 'parent' => $byId[$id]['parent'] ?? null, 'depth' => $depth];

            foreach ($children[$id] ?? [] as $child) {
                $descend($child, $depth + 1);
            }
        };

        foreach ($roots as $root) {
            $descend($root, 0);
        }

        /** A bag reported as its own ancestor would otherwise vanish from the view. */
        foreach (array_keys($byId) as $id) {
            $descend($id, 0);
        }

        return $ordered;
    }

    /**
     * List all players that have inventory snapshots.
     *
     * @return array<int, string>
     */
    public function listPlayers(): array
    {
        $names = [];

        if (is_dir($this->inventoryDir)) {
            $files = glob($this->inventoryDir.'/*.json') ?: [];
            foreach ($files as $file) {
                $names[] = pathinfo($file, PATHINFO_FILENAME);
            }
        }

        // Flat fallback inventory_<user>.json next to inventory/
        $parent = dirname($this->inventoryDir);
        $flat = glob($parent.'/inventory_*.json') ?: [];
        foreach ($flat as $file) {
            $base = pathinfo($file, PATHINFO_FILENAME); // inventory_AsP3X
            if (str_starts_with($base, 'inventory_')) {
                $names[] = substr($base, strlen('inventory_'));
            }
        }

        return array_values(array_unique($names));
    }

    /**
     * Get all player inventories.
     *
     * @return array<string, array{username: string, timestamp: string, items: array, weight: float, max_weight: float}>
     */
    public function getAllInventories(): array
    {
        $inventories = [];

        foreach ($this->listPlayers() as $username) {
            $inventory = $this->getPlayerInventory($username);
            if ($inventory !== null) {
                $inventories[$username] = $inventory;
            }
        }

        return $inventories;
    }

    /**
     * Request the Lua mod to export a player's inventory on-demand.
     * Writes to export_requests.json atomically (temp file + rename).
     */
    public function requestExport(string $username): bool
    {
        $existing = [];

        if (file_exists($this->exportRequestsPath)) {
            $content = file_get_contents($this->exportRequestsPath);
            if ($content !== false) {
                $data = json_decode($content, true);
                if (json_last_error() === JSON_ERROR_NONE && isset($data['usernames'])) {
                    $existing = $data['usernames'];
                }
            }
        }

        if (! in_array($username, $existing, true)) {
            $existing[] = $username;
        }

        $payload = [
            'usernames' => $existing,
            'updated_at' => date('c'),
        ];

        return LuaBridgeFile::writeJsonAtomic($this->exportRequestsPath, $payload);
    }
}
