<?php

namespace App\Http\Controllers;

use App\Models\GameEvent;
use App\Services\GameStateReader;
use App\Services\ModManager;
use App\Services\ServerHistoryService;
use App\Services\ServerStatusResolver;
use Inertia\Inertia;
use Inertia\Response;

class StatusController extends Controller
{
    public function __construct(
        private readonly ServerStatusResolver $statusResolver,
        private readonly ModManager $modManager,
        private readonly GameStateReader $gameStateReader,
        private readonly ServerHistoryService $history,
    ) {}

    public function __invoke(): Response
    {
        $resolved = $this->statusResolver->resolve();

        $server = [
            'online' => $resolved['online'],
            'status' => $resolved['game_status'],
            'player_count' => $resolved['player_count'],
            'players' => $resolved['players'],
            'uptime' => $resolved['uptime'],
            'map' => $resolved['map'],
            'max_players' => $resolved['max_players'],
        ];

        $mods = [];
        try {
            $iniPath = config('zomboid.paths.server_ini');
            $mods = $this->modManager->list($iniPath);
        } catch (\Throwable) {
            // Config file not available
        }

        $gameState = $resolved['online'] ? $this->gameStateReader->getGameState() : null;

        $killFeed = GameEvent::query()
            ->whereIn('event_type', ['death', 'player_death', 'pvp_kill', 'pvp_hit', 'zombie_kill'])
            ->orderByDesc('created_at')
            ->limit(20)
            ->get()
            ->map(fn (GameEvent $event) => [
                'id' => $event->id,
                'event_type' => $event->event_type,
                'player' => $event->player,
                'target' => $event->target,
                'details' => $event->details,
                'created_at' => $event->created_at?->toIso8601String(),
            ])
            ->all();

        // Prefer death / pvp for public feed; fall back to recent events
        if ($killFeed === []) {
            $killFeed = GameEvent::query()
                ->orderByDesc('created_at')
                ->limit(15)
                ->get()
                ->map(fn (GameEvent $event) => [
                    'id' => $event->id,
                    'event_type' => $event->event_type,
                    'player' => $event->player,
                    'target' => $event->target,
                    'details' => $event->details,
                    'created_at' => $event->created_at?->toIso8601String(),
                ])
                ->all();
        }

        return Inertia::render('status', [
            'server' => $server,
            'game_state' => $gameState,
            'mods' => $mods,
            'server_name' => config('zomboid.server_name', 'ZomboidServer'),
            'kill_feed' => $killFeed,
            /** Deferred: the history queries are irrelevant to "is it up right now". */
            'history' => Inertia::defer(fn () => $this->history->summary()),
        ]);
    }
}
