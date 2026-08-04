<?php

namespace App\Services;

use App\Models\PlayerStat;

/**
 * Badges derived from stats the server already collects.
 *
 * Nothing is stored: a badge is a statement about the numbers as they are now,
 * so it is computed on read. That keeps them honest when a character dies and
 * the numbers reset, and means adding a badge needs no backfill.
 */
class AchievementService
{
    /**
     * Tiered badges: the highest threshold a player has passed wins, so a
     * veteran shows one strong badge rather than a row of every step to it.
     *
     * @var array<string, array{stat: string, tiers: array<string, int|float>}>
     */
    private const TIERED = [
        'slayer' => [
            'stat' => 'zombie_kills',
            'tiers' => ['bronze' => 100, 'silver' => 1000, 'gold' => 5000],
        ],
        'survivor' => [
            'stat' => 'hours_survived',
            /** One in-game day, one week, one month. */
            'tiers' => ['bronze' => 24, 'silver' => 168, 'gold' => 720],
        ],
    ];

    /** A perk at this level is mastery. */
    private const MASTERY_LEVEL = 10;

    /** How many perks at this level make someone a generalist. */
    private const GENERALIST_LEVEL = 5;

    private const GENERALIST_COUNT = 5;

    /**
     * Every badge a player currently holds.
     *
     * @return array<int, array{id: string, tier: string|null, value: int|float|null}>
     */
    public function forPlayer(PlayerStat $player): array
    {
        $badges = [];

        foreach (self::TIERED as $id => $definition) {
            $value = $player->{$definition['stat']} ?? 0;
            $tier = $this->highestTier($value, $definition['tiers']);

            if ($tier !== null) {
                $badges[] = ['id' => $id, 'tier' => $tier, 'value' => $value];
            }
        }

        $skills = $player->skills ?? [];

        $mastered = array_keys(array_filter($skills, fn ($level) => $level >= self::MASTERY_LEVEL));

        if ($mastered !== []) {
            $badges[] = ['id' => 'master', 'tier' => null, 'value' => count($mastered)];
        }

        $competent = array_filter($skills, fn ($level) => $level >= self::GENERALIST_LEVEL);

        if (count($competent) >= self::GENERALIST_COUNT) {
            $badges[] = ['id' => 'generalist', 'tier' => null, 'value' => count($competent)];
        }

        if ($player->profession !== null && $player->profession !== '') {
            $badges[] = ['id' => 'professional', 'tier' => null, 'value' => null];
        }

        return $badges;
    }

    /**
     * The strongest tier `$value` has reached, or null for none.
     *
     * @param  array<string, int|float>  $tiers
     */
    private function highestTier(int|float $value, array $tiers): ?string
    {
        $earned = null;

        foreach ($tiers as $tier => $threshold) {
            if ($value >= $threshold) {
                $earned = $tier;
            }
        }

        return $earned;
    }
}
