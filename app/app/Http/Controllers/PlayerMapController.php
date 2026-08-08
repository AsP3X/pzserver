<?php

namespace App\Http\Controllers;

use App\Services\MapConfigBuilder;
use App\Services\OnlinePlayersReader;
use App\Services\PlayerPositionReader;
use App\Services\PlayersDbReader;
use App\Services\PzIdentityResolver;
use App\Services\SafeZoneManager;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

/**
 * The player's own live map.
 *
 * Deliberately shows one marker — the caller's character. Where everyone else
 * is standing is exactly the information a PvP server must not hand out, so
 * this page never reads the full roster; that stays on the admin map.
 */
class PlayerMapController extends Controller
{
    public function __construct(
        private readonly PzIdentityResolver $identity,
        private readonly PlayerPositionReader $positionReader,
        private readonly PlayersDbReader $playersDb,
        private readonly OnlinePlayersReader $onlinePlayersReader,
        private readonly MapConfigBuilder $mapConfigBuilder,
        private readonly SafeZoneManager $safeZoneManager,
    ) {}

    public function __invoke(Request $request): Response
    {
        $pzUsername = $this->identity->resolve($request->user());
        $mapConfig = $this->mapConfigBuilder->build();
        $safeZoneConfig = $this->safeZoneManager->getConfig();

        return Inertia::render('portal/map', [
            'username' => $pzUsername,
            'hasPzAccount' => $pzUsername !== null,
            'marker' => $pzUsername === null ? null : $this->resolveMarker($pzUsername),
            'mapConfig' => $mapConfig,
            'hasTiles' => (bool) ($mapConfig['hasBasemap'] ?? false),
            'safeZones' => $safeZoneConfig['enabled'] ? $safeZoneConfig['zones'] : [],
        ]);
    }

    /**
     * Where the player is now: the live export when they are connected, the
     * save database otherwise, so a logged-out player still sees where they
     * left their character.
     *
     * @return array{username: string, name: string, x: float, y: float, z: int, status: string, is_online: bool, source: string}|null
     */
    private function resolveMarker(string $username): ?array
    {
        $isOnline = in_array($username, $this->onlinePlayersReader->getOnlineUsernames(), true);
        $live = $isOnline ? $this->positionReader->getPlayerPosition($username) : null;
        $position = $live ?? $this->playersDb->getPlayerPosition($username);

        if ($position === null) {
            return null;
        }

        $isDead = (bool) ($position['is_dead'] ?? false);

        return [
            'username' => $username,
            // The live export carries no character name; the save database does.
            'name' => (string) ($position['name'] ?? $username),
            'x' => (float) $position['x'],
            'y' => (float) $position['y'],
            'z' => (int) ($position['z'] ?? 0),
            'status' => $isDead ? 'dead' : ($isOnline ? 'online' : 'offline'),
            'is_online' => $isOnline,
            'source' => $live !== null ? 'live' : 'save',
        ];
    }
}
