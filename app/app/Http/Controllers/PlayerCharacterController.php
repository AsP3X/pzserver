<?php

namespace App\Http\Controllers;

use App\Models\PlayerStat;
use App\Services\GameTimeService;
use App\Services\OnlinePlayersReader;
use App\Services\PzIdentityResolver;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

/**
 * The player's own character sheet.
 *
 * The public profile at /rankings/{username} already covers what everyone is
 * allowed to see. This page adds what only the owner should: the traits they
 * picked and the state their body is in.
 */
class PlayerCharacterController extends Controller
{
    public function __construct(
        private readonly PzIdentityResolver $identity,
        private readonly OnlinePlayersReader $onlinePlayersReader,
        private readonly GameTimeService $gameTime,
    ) {}

    public function __invoke(Request $request): Response
    {
        $pzUsername = $this->identity->resolve($request->user());
        $stats = $pzUsername === null ? null : PlayerStat::query()->find($pzUsername);

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
            'day_length_minutes' => $this->gameTime->realMinutesPerInGameDay(),
        ]);
    }
}
