<?php

namespace App\Services;

use App\Models\User;
use App\Models\WhitelistEntry;

/**
 * Resolves a web account to the PZ character it owns.
 *
 * Every player-facing page that reads game data has to answer this question,
 * and it must always be answered from the session — never from request input —
 * or one player could read another's inventory, position or vault.
 */
class PzIdentityResolver
{
    /**
     * The caller's PZ character name, or null when they have no linked account.
     *
     * Prefers the linked whitelist entry, falling back to a match on the
     * account username for players registered before linking existed.
     */
    public function resolve(User $user): ?string
    {
        $entry = WhitelistEntry::query()
            ->where('user_id', $user->id)
            ->where('active', true)
            ->first();

        if ($entry !== null) {
            return $entry->pz_username;
        }

        return WhitelistEntry::query()
            ->where('pz_username', $user->username)
            ->where('active', true)
            ->first()?->pz_username;
    }
}
