<?php

namespace App\Services;

use App\Models\GameEvent;
use Illuminate\Support\Facades\Cache;

/**
 * Spots players standing inside a safehouse they are not a member of.
 *
 * Detection is done here rather than in Lua on purpose: both halves — live
 * positions and the claim list — are already exported, so this needs no extra
 * mod work, and the awkward parts (boundaries, membership, not crying wolf)
 * become ordinary testable PHP.
 */
class RaidDetector
{
    /**
     * How long the same intruder in the same claim stays one incident.
     *
     * A raid is minutes of someone walking around a base. Without this, a
     * thirty-second position export would raise a hundred alerts for it.
     */
    public const COOLDOWN_MINUTES = 30;

    public function __construct(
        private readonly PlayerPositionReader $positions,
        private readonly HoldingsReader $holdings,
        private readonly AuditLogger $auditLogger,
    ) {}

    /**
     * Check everyone currently on the map. Returns the alerts raised.
     *
     * @return array<int, GameEvent>
     */
    public function scan(): array
    {
        $live = $this->positions->getLivePositions();

        if ($live === null || empty($live['players'])) {
            return [];
        }

        $claims = $this->holdings->read()['safehouses'];

        if ($claims === []) {
            return [];
        }

        $raised = [];

        foreach ($live['players'] as $player) {
            $username = $player['username'] ?? null;

            if ($username === null || $username === 'unknown') {
                continue;
            }

            /** A dead body lying in someone's base is not a raid in progress. */
            if ($player['is_dead'] ?? false) {
                continue;
            }

            $claim = $this->claimContaining($claims, (float) $player['x'], (float) $player['y']);

            if ($claim === null || $this->isEntitled($claim, $username)) {
                continue;
            }

            $alert = $this->raise($claim, $username, (float) $player['x'], (float) $player['y']);

            if ($alert !== null) {
                $raised[] = $alert;
            }
        }

        return $raised;
    }

    /**
     * @param  array<int, array<string, mixed>>  $claims
     * @return array<string, mixed>|null
     */
    private function claimContaining(array $claims, float $x, float $y): ?array
    {
        foreach ($claims as $claim) {
            if ($x >= $claim['x'] && $x < $claim['x2'] && $y >= $claim['y'] && $y < $claim['y2']) {
                return $claim;
            }
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $claim
     */
    private function isEntitled(array $claim, string $username): bool
    {
        return in_array($username, $this->holdings->membersOf($claim), true);
    }

    /**
     * Record one incident, unless the same pair is already inside its cooldown.
     *
     * @param  array<string, mixed>  $claim
     */
    private function raise(array $claim, string $username, float $x, float $y): ?GameEvent
    {
        $key = 'raid.seen:'.md5($username.'|'.$claim['title'].'|'.$claim['x'].','.$claim['y']);

        if (Cache::has($key)) {
            return null;
        }

        Cache::put($key, true, now()->addMinutes(self::COOLDOWN_MINUTES));

        $event = GameEvent::query()->create([
            'event_type' => 'raid_alert',
            'player' => $username,
            'target' => $claim['owner'],
            'details' => [
                'safehouse' => $claim['title'],
                'owner' => $claim['owner'],
                'members' => $claim['members'],
            ],
            'x' => (int) $x,
            'y' => (int) $y,
            'game_time' => now(),
        ]);

        $this->announce($claim, $username, (int) $x, (int) $y);

        return $event;
    }

    /**
     * @param  array<string, mixed>  $claim
     */
    private function announce(array $claim, string $username, int $x, int $y): void
    {
        /**
         * Routed through the audit log rather than the webhook service: the
         * AuditLog observer is what fans notifications out to Discord, and a
         * raid belongs in the audit trail regardless of whether anyone is
         * listening on Discord.
         */
        $this->auditLogger->log(
            actor: 'system',
            action: 'raid.alert.detected',
            target: $claim['title'],
            details: [
                'intruder' => $username,
                'owner' => $claim['owner'],
                'x' => $x,
                'y' => $y,
            ],
        );
    }
}
