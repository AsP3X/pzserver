<?php

namespace App\Http\Controllers;

use App\Services\GameStateReader;
use App\Services\ModManager;
use App\Services\ServerStatusResolver;
use Inertia\Inertia;
use Inertia\Response;

class StatusController extends Controller
{
    public function __construct(
        private readonly ServerStatusResolver $statusResolver,
        private readonly ModManager $modManager,
        private readonly GameStateReader $gameStateReader,
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

        return Inertia::render('status', [
            'server' => $server,
            'game_state' => $gameState,
            'mods' => $mods,
            'server_name' => config('zomboid.server_name', 'ZomboidServer'),
        ]);
    }
}
