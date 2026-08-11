<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\BakeVectorMapRequest;
use App\Models\GameEvent;
use App\Services\AuditLogger;
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
use App\Services\VehicleReader;
use App\Services\WorldMapVectorBakeService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Inertia\Inertia;
use Inertia\Response as InertiaResponse;

class PlayerMapController extends Controller
{
    /** Widest activity window the heatmap will look back over. */
    private const MAX_ACTIVITY_DAYS = 30;

    /** Cap on plotted activity points, so a busy month cannot flood the page. */
    private const MAX_ACTIVITY_POINTS = 2000;

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
        private readonly WorldMapVectorBakeService $vectorBake,
        private readonly VehicleReader $vehicleReader,
        private readonly AuditLogger $auditLogger,
    ) {}

    public function __invoke(Request $request): InertiaResponse
    {
        $activityDays = max(1, min(
            self::MAX_ACTIVITY_DAYS,
            (int) $request->integer('activity_days', 7),
        ));
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
                    'last_seen' => null,
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
                    'last_seen' => null,
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
                    'last_seen' => null,
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
                    'last_seen' => null,
                ];
            }
        }

        $markers = $this->datePositions($markers);

        $mapModes = $this->mapConfigBuilder->buildModes();
        $mapConfig = $this->mapConfigBuilder->build();
        $safeZoneConfig = $this->safeZoneManager->getConfig();
        $holdings = $this->holdingsReader->read();
        $hasBasemap = (bool) ($mapConfig['hasBasemap'] ?? false)
            || (bool) ($mapModes['vector']['hasBasemap'] ?? false)
            || (bool) ($mapModes['isometric']['hasBasemap'] ?? false);
        $canResume = $this->tileStore->hasLooseTiles() && ! $this->tileGenerator->isRunning();

        return Inertia::render('admin/player-map', [
            'markers' => $markers,
            'onlineCount' => $resolved['player_count'],
            'serverStatus' => $resolved['game_status'],
            'mapConfig' => $mapConfig,
            'mapModes' => $mapModes,
            'hasTiles' => $hasBasemap,
            'tileSource' => $mapConfig['source'] ?? 'none',
            'localTilesReady' => (bool) ($mapModes['isometric_local_ready'] ?? false),
            'canResume' => $canResume,
            'tileProgress' => $this->readTileProgress(),
            'tilesGenerating' => $this->tileGenerator->isRunning(),
            'safeZones' => $safeZoneConfig['enabled'] ? $safeZoneConfig['zones'] : [],
            'safehouses' => $holdings['safehouses'],
            'factions' => $holdings['factions'],
            'vehicles' => $this->plottableVehicles(),
            'activityDays' => $activityDays,
            /**
             * Optional, not deferred: the heatmap is off until an admin asks
             * for it, and a month of events has no business being queried —
             * let alone re-sent on every 5s poll — before then.
             */
            'activity' => Inertia::optional(fn () => $this->recentActivity($activityDays)),
            /**
             * Optional for the same reason, and a sharper one: resolving the
             * Map= packs globs the Workshop tree. That belongs to opening the
             * basemap panel, not to watching where players are.
             */
            'vectorSources' => Inertia::optional(fn () => $this->vectorBake->listSources()),
            'vectorAsset' => Inertia::optional(fn () => $this->vectorBake->assetStatus()),
            'vectorBakeResult' => Inertia::optional(fn () => $this->vectorBake->lastResult()),
        ]);
    }

    /**
     * Vehicles the map can actually place, newest export wins.
     *
     * @return array<int, array{id: int, model: string, x: int, y: int, fuel_percent: int|null, engine_running: bool, key_holders: array<int, string>}>
     */
    private function plottableVehicles(): array
    {
        $placed = array_filter(
            $this->vehicleReader->read()['vehicles'],
            fn (array $vehicle) => $vehicle['x'] !== null && $vehicle['y'] !== null,
        );

        return array_values(array_map(
            fn (array $vehicle) => [
                'id' => $vehicle['id'],
                'model' => $vehicle['model'],
                'x' => (int) $vehicle['x'],
                'y' => (int) $vehicle['y'],
                'fuel_percent' => $vehicle['fuel_percent'],
                'engine_running' => $vehicle['engine_running'],
                'key_holders' => $vehicle['key_holders'],
            ],
            $placed,
        ));
    }

    /**
     * Located events from the last N days, for the activity overlay.
     *
     * @return array<int, array{id: int, x: int, y: int, type: string, player: string, target: string|null, at: string|null}>
     */
    private function recentActivity(int $days): array
    {
        return GameEvent::query()
            ->whereNotNull('x')
            ->whereNotNull('y')
            ->where('game_time', '>=', now()->subDays($days))
            ->latest('game_time')
            ->limit(self::MAX_ACTIVITY_POINTS)
            ->get(['id', 'x', 'y', 'event_type', 'player', 'target', 'game_time'])
            ->map(fn (GameEvent $event) => [
                'id' => $event->id,
                'x' => (int) $event->x,
                'y' => (int) $event->y,
                'type' => $event->event_type,
                'player' => $event->player,
                'target' => $event->target,
                'at' => $event->game_time?->toIso8601String(),
            ])
            ->all();
    }

    /**
     * Stamp offline markers with when that player was last seen.
     *
     * Scoped to the players actually on the map: this runs on every poll, and
     * grouping the whole event history every five seconds is not something a
     * server with a year of logs should be asked to do.
     *
     * @param  array<int, array<string, mixed>>  $markers
     * @return array<int, array<string, mixed>>
     */
    private function datePositions(array $markers): array
    {
        $offline = array_values(array_filter(
            $markers,
            fn (array $marker) => $marker['is_online'] === false,
        ));

        if ($offline === []) {
            return $markers;
        }

        /**
         * The log carries the username on a vanilla server and the character
         * name on some Log Extender builds, so both are asked for rather than
         * guessing which one this server writes.
         */
        $names = array_values(array_unique(array_merge(
            array_column($offline, 'username'),
            array_column($offline, 'name'),
        )));

        $lastSeen = GameEvent::query()
            ->whereIn('event_type', ['connect', 'disconnect'])
            ->whereIn('player', $names)
            ->selectRaw('player, MAX(game_time) as seen_at')
            ->groupBy('player')
            ->pluck('seen_at', 'player')
            ->filter()
            /**
             * The raw aggregate skips the model's date casting, so it arrives
             * as a naive string. It is stored UTC; parsing it as anything else
             * would date every offline player wrong by the server's offset.
             */
            ->map(fn ($seenAt) => Carbon::parse($seenAt, 'UTC')->toIso8601String())
            ->all();

        return array_map(
            fn (array $marker) => $marker['is_online']
                ? $marker
                : [
                    ...$marker,
                    'last_seen' => $lastSeen[$marker['username']] ?? $lastSeen[$marker['name']] ?? null,
                ],
            $markers,
        );
    }

    /**
     * Rebuild the vector basemap from Map= / workshop worldmap.xml packs.
     */
    public function bakeVector(BakeVectorMapRequest $request): JsonResponse
    {
        $scanWorkshop = (bool) $request->boolean('scan_workshop');
        $includeForest = $request->has('include_forest')
            ? (bool) $request->boolean('include_forest')
            : true;

        try {
            $result = $this->vectorBake->bake(
                scanWorkshop: $scanWorkshop,
                includeForest: $includeForest,
            );
        } catch (\Throwable $e) {
            report($e);

            return response()->json([
                'ok' => false,
                'message' => 'Bake failed: '.$e->getMessage(),
                'error' => $e->getMessage(),
            ], 500);
        }

        try {
            $this->auditLogger->log(
                actor: $request->user()?->name ?? 'admin',
                action: 'map.vector_bake',
                target: 'vector-basemap',
                details: [
                    'ok' => $result['ok'],
                    'scan_workshop' => $scanWorkshop,
                    'include_forest' => $includeForest,
                    'source' => $result['source'] ?? null,
                    'bytes' => $result['bytes'] ?? null,
                    'maps' => $result['maps'] ?? null,
                    'message' => $result['message'] ?? null,
                ],
                ip: $request->ip(),
            );
        } catch (\Throwable $e) {
            // Never hide bake outcome because audit logging failed
            report($e);
        }

        return response()->json($result, $result['ok'] ? 200 : 422);
    }

    /**
     * Kick off local map tile generation (background).
     */
    public function generateTiles(Request $request): JsonResponse
    {
        $profile = (string) $request->input('profile', 'lite');
        $result = $this->tileGenerator->start(
            force: (bool) $request->boolean('force'),
            resume: (bool) $request->boolean('resume'),
            profile: $profile,
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
