<?php

namespace App\Services;

use Carbon\CarbonImmutable;

/**
 * Reads the PZServerPulse mod's heartbeat data from the Lua bridge volume.
 *
 * PZServerPulse is a custom server-side mod that exports live character data
 * (health, skills, moodles, equipment, temperature, protection, encumbrance,
 * wounds, recipes) as per-player JSON heartbeat files into
 * Lua/PZServerPulse/<username>.json on the game server, which the app
 * container mounts at /lua-bridge/PZServerPulse/.
 */
class PzServerPulseService
{
    /**
     * Written to the Lua root by SP_Bridge.probe() on OnServerStarted.
     *
     * It is the only file that proves the mod itself booted: the heartbeat
     * directory is created by configure-server.sh on every start whether or
     * not PZServerPulse is in `Mods=`, so its existence proves nothing.
     */
    private const SELF_TEST_FILE = 'sp_bridge_selftest.txt';

    private string $pulseDir;

    public function __construct(?string $pulseDir = null)
    {
        $this->pulseDir = $pulseDir ?? (string) config('zomboid.lua_bridge.pzserver_pulse_dir');
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
         * SP_Codec encodes an empty Lua table as `[]`, so a heartbeat whose
         * collectors all bailed decodes to a list rather than an object. The
         * page expects a keyed payload or nothing.
         */
        return array_is_list($data) ? null : $data;
    }

    /**
     * Whether the mod is running on the game server at all.
     *
     * A player who has never logged in has no heartbeat of their own, so the
     * boot-time self-test is what separates "you haven't played yet" from
     * "this server does not run PZServerPulse".
     */
    public function isAvailable(): bool
    {
        return is_file($this->luaRoot().'/'.self::SELF_TEST_FILE);
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
     * Checks the PZServerPulse/ subdirectory first, then the flat fallback
     * (pzsp_<username>.json) the mod falls back to when that subdirectory is
     * unwritable — same pattern KnoxRelay uses for inventory snapshots. The
     * fallback is deliberately not gated on the subdirectory existing, since
     * a missing subdirectory is the case it exists to cover.
     */
    private function heartbeatPath(string $username): ?string
    {
        $username = $this->safeUsername($username);

        if ($username === null) {
            return null;
        }

        $candidates = [
            $this->pulseDir.'/'.$username.'.json',
            $this->luaRoot().'/pzsp_'.$username.'.json',
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
        return dirname($this->pulseDir);
    }
}
