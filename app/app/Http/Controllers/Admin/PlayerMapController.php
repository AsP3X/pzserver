<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Services\MapConfigBuilder;
use App\Services\MapTileStore;
use App\Services\OnlinePlayersReader;
use App\Services\PlayerPositionReader;
use App\Services\PlayersDbReader;
use App\Services\SafeZoneManager;
use App\Services\ServerStatusResolver;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Inertia\Inertia;
use Inertia\Response as InertiaResponse;

class PlayerMapController extends Controller
{
    public function __construct(
        private readonly PlayersDbReader $playersDb,
        private readonly PlayerPositionReader $positionReader,
        private readonly OnlinePlayersReader $onlinePlayers,
        private readonly ServerStatusResolver $statusResolver,
        private readonly MapConfigBuilder $mapConfigBuilder,
        private readonly SafeZoneManager $safeZoneManager,
        private readonly MapTileStore $tileStore,
    ) {}

    public function __invoke(): InertiaResponse
    {
        $resolved = $this->statusResolver->resolve();
        $dbPlayers = $this->playersDb->getAllPlayerPositions();
        $liveData = $this->positionReader->getLivePositions();

        // Use OnlinePlayersReader for reliable online detection (log → RCON → Lua)
        $onlineUsernames = $this->onlinePlayers->getOnlineUsernames();

        $livePositions = [];

        if ($liveData !== null && ! empty($liveData['players'])) {
            foreach ($liveData['players'] as $player) {
                $username = $player['username'] ?? '';
                $livePositions[$username] = $player;
            }
        }

        $markers = [];

        foreach ($dbPlayers as $player) {
            $username = $player['username'];
            $isOnline = in_array($username, $onlineUsernames);

            if ($isOnline && isset($livePositions[$username])) {
                $live = $livePositions[$username];
                $isDead = $live['is_dead'] ?? $player['is_dead'];

                $markers[] = [
                    'username' => $username,
                    'name' => $player['name'],
                    'x' => (float) $live['x'],
                    'y' => (float) $live['y'],
                    'z' => (int) ($live['z'] ?? 0),
                    'status' => $isDead ? 'dead' : 'online',
                    'is_online' => true,
                ];
            } elseif ($isOnline) {
                $markers[] = [
                    'username' => $username,
                    'name' => $player['name'],
                    'x' => $player['x'],
                    'y' => $player['y'],
                    'z' => $player['z'],
                    'status' => $player['is_dead'] ? 'dead' : 'online',
                    'is_online' => true,
                ];
            } else {
                $markers[] = [
                    'username' => $username,
                    'name' => $player['name'],
                    'x' => $player['x'],
                    'y' => $player['y'],
                    'z' => $player['z'],
                    'status' => $player['is_dead'] ? 'dead' : 'offline',
                    'is_online' => false,
                ];
            }
        }

        // Add any online players not in the DB (new connections or DB unavailable)
        foreach ($onlineUsernames as $username) {
            $alreadyAdded = collect($markers)->contains('username', $username);
            if (! $alreadyAdded) {
                $live = $livePositions[$username] ?? null;
                $markers[] = [
                    'username' => $username,
                    'name' => $live['name'] ?? $username,
                    'x' => $live ? (float) $live['x'] : 0.0,
                    'y' => $live ? (float) $live['y'] : 0.0,
                    'z' => $live ? (int) ($live['z'] ?? 0) : 0,
                    'status' => ($live && ($live['is_dead'] ?? false)) ? 'dead' : 'online',
                    'is_online' => true,
                ];
            }
        }

        $mapConfig = $this->mapConfigBuilder->build();
        $safeZoneConfig = $this->safeZoneManager->getConfig();
        $hasBasemap = $mapConfig['tileUrl'] !== null && $mapConfig['dzi'] !== null;

        return Inertia::render('admin/player-map', [
            'markers' => $markers,
            'onlineCount' => $resolved['player_count'],
            'serverStatus' => $resolved['game_status'],
            'mapConfig' => $mapConfig,
            'hasTiles' => $hasBasemap,
            'tileSource' => $mapConfig['source'] ?? 'none',
            'localTilesReady' => (bool) ($mapConfig['local_ready'] ?? false),
            'tileProgress' => $this->readTileProgress(),
            'tilesGenerating' => $this->isTileGenerationRunning(),
            'safeZones' => $safeZoneConfig['enabled'] ? $safeZoneConfig['zones'] : [],
        ]);
    }

    /**
     * Kick off local map tile generation (background).
     */
    public function generateTiles(Request $request): JsonResponse
    {
        $force = (bool) $request->boolean('force');
        $lock = storage_path('app/map-tiles.generating');

        if ($this->isTileGenerationRunning()) {
            return response()->json([
                'ok' => false,
                'message' => 'Tile generation is already running. Check storage/logs/map-tiles.log',
            ], 409);
        }

        file_put_contents($lock, json_encode([
            'started_at' => now()->toIso8601String(),
            'pid' => getmypid(),
            'force' => $force,
        ]));

        // Run in background so the HTTP request returns immediately
        $artisan = base_path('artisan');
        $log = storage_path('logs/map-tiles.log');
        $forceFlag = $force ? '--force' : '';
        $cmd = sprintf(
            'php %s zomboid:generate-map-tiles %s >> %s 2>&1; rm -f %s',
            escapeshellarg($artisan),
            $forceFlag,
            escapeshellarg($log),
            escapeshellarg($lock),
        );

        if (PHP_OS_FAMILY === 'Windows') {
            pclose(popen('start /B '.$cmd, 'r'));
        } else {
            exec('nohup '.$cmd.' > /dev/null 2>&1 &');
        }

        return response()->json([
            'ok' => true,
            'message' => 'Map tile generation started. This can take 10–60+ minutes. Refresh the map later.',
            'log' => 'storage/logs/map-tiles.log',
        ]);
    }

    /**
     * Serve a map tile from the packed SQLite store (or legacy loose files).
     */
    public function tile(string $level, string $tile): Response
    {
        $result = $this->tileStore->getTile($level, $tile);

        if ($result === null) {
            // Return transparent 1x1 PNG for missing tiles (avoids broken-image placeholders in Leaflet)
            return response(base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), 200, [
                'Content-Type' => 'image/png',
                'Cache-Control' => 'public, max-age=86400',
            ]);
        }

        return response($result['data'], 200, [
            'Cache-Control' => 'public, max-age=86400',
            'Content-Type' => $result['content_type'],
        ]);
    }

    private function isTileGenerationRunning(): bool
    {
        $lock = storage_path('app/map-tiles.generating');
        if (! is_file($lock)) {
            return false;
        }

        // Stale lock after 6 hours
        if (filemtime($lock) < time() - 21600) {
            @unlink($lock);

            return false;
        }

        return true;
    }

    /**
     * @return array{generating: bool, completed: int, total: int, percent: int}|null
     */
    private function readTileProgress(): ?array
    {
        if (! $this->isTileGenerationRunning()) {
            return null;
        }

        return [
            'generating' => true,
            'completed' => 0,
            'total' => 0,
            'percent' => 0,
        ];
    }
}
