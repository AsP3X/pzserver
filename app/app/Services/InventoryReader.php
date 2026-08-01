<?php

namespace App\Services;

use App\Support\LuaBridgeFile;

class InventoryReader
{
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
     * @return array{username: string, timestamp: string, items: array<int, array{full_type: string, name: string, category: string, count: int, condition: float, equipped: bool, container: string}>, weight: float, max_weight: float}|null
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

            return $data;
        }

        return null;
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
