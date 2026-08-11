<?php

namespace App\Services;

use Carbon\CarbonImmutable;

/**
 * Reads Knox Relay's live character vitals from the Lua bridge volume.
 *
 * KR_Vitals writes a per-player heartbeat every ten real seconds — health and
 * wounds per body part, skills with XP, moodles, equipped weapon, worn
 * clothing, body temperature, encumbrance and recently learned recipes — into
 * Lua/vitals/<username>.json on the game server, which the app container mounts
 * at /lua-bridge/vitals/.
 */
class CharacterVitalsReader
{
    /**
     * The bridge version that first exported character vitals correctly.
     *
     * Servers on an older Knox Relay write no heartbeats at all, and the page
     * needs to tell that apart from a player who simply has not logged in yet.
     *
     * 1.9 rather than 1.7 or 1.8, both of which did write heartbeats. Each
     * called Build 41 accessors that Build 42 had moved, and because every
     * collector swallows its own errors the files were full of defaults — body
     * parts at 100% with no wounds, a flat 37°C, no profession, no skill
     * progress. Showing that is worse than showing nothing, so neither counts
     * as having the feature.
     */
    private const MINIMUM_MOD_VERSION = '1.9';

    private string $vitalsDir;

    public function __construct(
        private readonly GameStateReader $gameState,
        ?string $vitalsDir = null,
    ) {
        $this->vitalsDir = $vitalsDir ?? (string) config('zomboid.lua_bridge.vitals_dir');
    }

    /**
     * Read the latest heartbeat for a player.
     *
     * @return array<string, mixed>|null
     */
    public function heartbeatFor(string $username): ?array
    {
        $path = $this->heartbeatPath($username);

        if ($path === null) {
            return null;
        }

        $content = @file_get_contents($path);

        if ($content === false || $content === '') {
            return null;
        }

        $data = json_decode($content, true);

        if (json_last_error() !== JSON_ERROR_NONE || ! is_array($data)) {
            return null;
        }

        /**
         * KR_Codec encodes an empty Lua table as `[]`, so a heartbeat whose
         * collectors all bailed decodes to a list rather than an object. The
         * page expects a keyed payload or nothing.
         */
        return array_is_list($data) ? null : $data;
    }

    /**
     * Whether the server runs a Knox Relay new enough to export vitals.
     *
     * Read from the bridge version in game_state.json rather than from a
     * boot-time marker file: the world export runs on a real-time hook every
     * ten seconds, whereas OnServerStarted has never been observed to fire on
     * this server, so anything hanging off it would report a false negative
     * forever.
     */
    public function isAvailable(): bool
    {
        $version = $this->gameState->getGameState()['mod_version'] ?? null;

        return is_string($version)
            && version_compare($version, self::MINIMUM_MOD_VERSION, '>=');
    }

    /**
     * When the player's heartbeat was last written, or null if never.
     */
    public function lastSyncedAt(string $username): ?CarbonImmutable
    {
        $path = $this->heartbeatPath($username);

        if ($path === null) {
            return null;
        }

        $modifiedAt = @filemtime($path);

        return $modifiedAt === false ? null : CarbonImmutable::createFromTimestamp($modifiedAt);
    }

    /**
     * Resolve the on-disk path to a player's heartbeat file.
     *
     * Checks the vitals/ subdirectory first, then the flat fallback
     * (vitals_<username>.json) the mod falls back to when that subdirectory is
     * unwritable — the same pattern KR_Snapshot uses for inventory. The
     * fallback is deliberately not gated on the subdirectory existing, since a
     * missing subdirectory is the case it exists to cover.
     */
    private function heartbeatPath(string $username): ?string
    {
        $username = $this->safeUsername($username);

        if ($username === null) {
            return null;
        }

        $candidates = [
            $this->vitalsDir.'/'.$username.'.json',
            $this->luaRoot().'/vitals_'.$username.'.json',
        ];

        foreach ($candidates as $candidate) {
            if (is_file($candidate) && is_readable($candidate)) {
                return $candidate;
            }
        }

        return null;
    }

    /**
     * Reject anything that would resolve outside the bridge directory.
     *
     * The username reaches here from the player's linked PZ account rather
     * than from a route parameter, so it has not been through the
     * `[a-zA-Z0-9_]` route pattern that constrains the public profile URLs.
     */
    private function safeUsername(string $username): ?string
    {
        if ($username === '' || $username === '.' || $username === '..') {
            return null;
        }

        return strpbrk($username, "/\\\0") === false ? $username : null;
    }

    /**
     * The mounted Lua/ directory that holds the bridge files.
     */
    private function luaRoot(): string
    {
        return dirname($this->vitalsDir);
    }
}
