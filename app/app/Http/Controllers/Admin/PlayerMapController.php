<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Services\HoldingsReader;
use App\Services\MapConfigBuilder;
use App\Services\MapTileGenerator;
use App\Services\MapTileProgress;
use App\Services\MapTileStore;
use App\Services\OnlinePlayersReader;
use App\Services\PlayerPositionReader;
use App\Services\PlayersDbReader;
use App\Services\SafeZoneManager;
use App\Services\ServerStatusResolver;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
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
        private readonly MapTileProgress $tileProgress,
        private readonly MapTileGenerator $tileGenerator,
        private readonly HoldingsReader $holdingsReader,
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
        $holdings = $this->holdingsReader->read();
        $hasBasemap = (bool) ($mapConfig['hasBasemap'] ?? false);
        $canResume = $this->tileStore->hasLooseTiles() && ! $this->tileGenerator->isRunning();

        return Inertia::render('admin/player-map', [
            'markers' => $markers,
            'onlineCount' => $resolved['player_count'],
            'serverStatus' => $resolved['game_status'],
            'mapConfig' => $mapConfig,
            'hasTiles' => $hasBasemap,
            'tileSource' => $mapConfig['source'] ?? 'none',
            'localTilesReady' => (bool) ($mapConfig['local_ready'] ?? false),
            'canResume' => $canResume,
            'tileProgress' => $this->readTileProgress(),
            'tilesGenerating' => $this->tileGenerator->isRunning(),
            'safeZones' => $safeZoneConfig['enabled'] ? $safeZoneConfig['zones'] : [],
            'safehouses' => $holdings['safehouses'],
            'factions' => $holdings['factions'],
        ]);
    }

    /**
     * Kick off local map tile generation (background).
     */
    public function generateTiles(Request $request): JsonResponse
    {
        $result = $this->tileGenerator->start(
            force: (bool) $request->boolean('force'),
            resume: (bool) $request->boolean('resume'),
        );

        return response()->json($result, $result['ok'] ? 200 : (
            str_contains($result['message'], 'already running') ? 409 : 422
        ));
    }

    /**
     * Request stop of a running generation job (keeps partial tiles for resume).
     */
    public function stopTiles(): JsonResponse
    {
        $result = $this->tileGenerator->requestStop();

        return response()->json($result, $result['ok'] ? 200 : 409);
    }

    /**
     * @return array{
     *     generating: bool,
     *     completed: int,
     *     total: int,
     *     percent: int,
     *     stage?: string,
     *     step?: int,
     *     steps?: int,
     *     message?: string,
     *     tiles_on_disk?: int
     * }|null
     */
    private function readTileProgress(): ?array
    {
        // Clears ghost "generating" state after restarts before the page reads it
        $running = $this->tileGenerator->isRunning();
        $progress = $this->tileProgress->read();

        if ($progress !== null && ($running || in_array($progress['stage'], ['failed', 'stopped', 'done', 'starting', 'unpack', 'render', 'pack'], true) || $progress['generating'])) {
            return [
                'generating' => $running,
                'completed' => (int) $progress['completed'],
                'total' => (int) $progress['total'],
                'percent' => (int) $progress['percent'],
                'stage' => (string) $progress['stage'],
                'step' => (int) $progress['step'],
                'steps' => (int) $progress['steps'],
                'message' => (string) $progress['message'],
                'tiles_on_disk' => (int) $progress['tiles_on_disk'],
            ];
        }

        if (! $running) {
            return null;
        }

        return [
            'generating' => true,
            'completed' => 0,
            'total' => 0,
            'percent' => 0,
            'stage' => 'starting',
            'step' => 0,
            'steps' => 3,
            'message' => 'Starting map tile generation…',
            'tiles_on_disk' => 0,
        ];
    }
}
