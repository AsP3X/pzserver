<?php

namespace App\Http\Controllers;

use App\Models\PlayerStat;
use App\Services\GameTimeService;
use App\Services\OnlinePlayersReader;
use App\Services\PlayerStatsService;
use App\Services\PzIdentityResolver;
use App\Services\PzServerPulseService;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

/**
 * The player's own character sheet.
 *
 * The public profile at /rankings/{username} already covers what everyone is
 * allowed to see. This page adds what only the owner should: the traits they
 * picked, the state their body is in, and the live PZServerPulse dashboard data.
 */
class PlayerCharacterController extends Controller
{
    public function __construct(
        private readonly PzIdentityResolver $identity,
        private readonly OnlinePlayersReader $onlinePlayersReader,
        private readonly GameTimeService $gameTime,
        private readonly PlayerStatsService $playerStats,
        private readonly PzServerPulseService $pzPulse,
    ) {}

    public function __invoke(Request $request): Response
    {
        $pzUsername = $this->identity->resolve($request->user());

        /**
         * The page polls, so pick up whatever the mod has exported since the
         * last visit rather than waiting on the ten-minute scheduled sync.
         */
        $this->playerStats->syncIfChanged();

        $stats = $pzUsername === null ? null : PlayerStat::query()->find($pzUsername);

        $pulse = null;
        $pulseSyncedAt = null;
        $pulseAvailable = $this->pzPulse->isAvailable();

        if ($pzUsername !== null && $pulseAvailable) {
            $pulse = $this->pzPulse->heartbeatFor($pzUsername);
            $pulseSyncedAt = $this->pzPulse->lastSyncedAt($pzUsername);
        }

        return Inertia::render('portal/character', [
            'username' => $pzUsername,
            'hasPzAccount' => $pzUsername !== null,
            'isOnline' => $pzUsername !== null
                && in_array($pzUsername, $this->onlinePlayersReader->getOnlineUsernames(), true),
            'character' => $stats === null ? null : [
                'username' => $stats->username,
                'zombie_kills' => $stats->zombie_kills,
                'hours_survived' => $stats->hours_survived,
                'profession' => $stats->profession,
                'skills' => $stats->skills ?? [],
                /** Null, not empty: an older mod exports neither, and the page says so. */
                'traits' => $stats->traits,
                'vitals' => $stats->vitals,
                'is_dead' => $stats->is_dead,
                'updated_at' => $stats->updated_at?->toIso8601String(),
            ],
            /** Wall-clock age of the export behind all of the above. */
            'snapshotAt' => $this->playerStats->lastExportedAt()?->toIso8601String(),
            'day_length_minutes' => $this->gameTime->realMinutesPerInGameDay(),
            /** PZServerPulse live dashboard data, when the mod is installed. */
            'pulse' => $pulse,
            'pulseAvailable' => $pulseAvailable,
            /** Age of that heartbeat, so a stale dashboard can say so. */
            'pulseSyncedAt' => $pulseSyncedAt?->toIso8601String(),
        ]);
    }
}
