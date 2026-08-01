<?php

namespace App\Services;

class PlayerPositionReader
{
    private string $positionsPath;

    public function __construct(?string $positionsPath = null)
    {
        $this->positionsPath = $positionsPath ?? config('zomboid.lua_bridge.players_live');
    }

    /**
     * Get all live player positions.
     *
     * @return array{timestamp: string, players: array<int, array{username: string, x: float, y: float, z: int, is_dead: bool, is_ghost: bool}>}|null
     */
    public function getLivePositions(): ?array
    {
        if (! file_exists($this->positionsPath)) {
            return null;
        }

        $content = file_get_contents($this->positionsPath);
        if ($content === false) {
            return null;
        }

        $data = json_decode($content, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            return null;
        }

        return $data;
    }

    /**
     * Get a specific player's position.
     *
     * @return array{username: string, x: float, y: float, z: int, is_dead: bool, is_ghost: bool}|null
     */
    public function getPlayerPosition(string $username): ?array
    {
        $data = $this->getLivePositions();
        if ($data === null || empty($data['players'])) {
            return null;
        }

        foreach ($data['players'] as $player) {
            if (($player['username'] ?? '') === $username) {
                return $player;
            }
        }

        return null;
    }

    /**
     * Check if position data is stale (older than given seconds).
     */
    public function isStale(int $maxAgeSeconds = 120): bool
    {
        $data = $this->getLivePositions();
        if ($data === null || empty($data['timestamp'])) {
            return true;
        }

        $timestamp = strtotime($data['timestamp']);
        if ($timestamp === false) {
            return true;
        }

        return (time() - $timestamp) > $maxAgeSeconds;
    }
}
