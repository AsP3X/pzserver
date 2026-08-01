<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class PlayersDbReader
{
    /**
     * Get all player positions from the networkPlayers table.
     *
     * @return array<int, array{username: string, name: string, x: float, y: float, z: int, is_dead: bool}>
     */
    public function getAllPlayerPositions(): array
    {
        try {
            $rows = DB::connection('pz_players')
                ->table('networkPlayers')
                ->select('username', 'name', 'x', 'y', 'z', 'isDead')
                ->get();

            return $rows->map(fn ($row) => [
                'username' => $row->username,
                'name' => $row->name ?? $row->username,
                'x' => (float) $row->x,
                'y' => (float) $row->y,
                'z' => (int) $row->z,
                'is_dead' => (bool) $row->isDead,
            ])->all();
        } catch (\Throwable $e) {
            Log::debug('PlayersDbReader: unable to read players.db', ['error' => $e->getMessage()]);

            return [];
        }
    }

    /**
     * Get a single player's position by username.
     *
     * @return array{username: string, name: string, x: float, y: float, z: int, is_dead: bool}|null
     */
    public function getPlayerPosition(string $username): ?array
    {
        try {
            $row = DB::connection('pz_players')
                ->table('networkPlayers')
                ->select('username', 'name', 'x', 'y', 'z', 'isDead')
                ->where('username', $username)
                ->first();

            if ($row === null) {
                return null;
            }

            return [
                'username' => $row->username,
                'name' => $row->name ?? $row->username,
                'x' => (float) $row->x,
                'y' => (float) $row->y,
                'z' => (int) $row->z,
                'is_dead' => (bool) $row->isDead,
            ];
        } catch (\Throwable $e) {
            Log::debug('PlayersDbReader: unable to read player position', [
                'username' => $username,
                'error' => $e->getMessage(),
            ]);

            return null;
        }
    }
}
