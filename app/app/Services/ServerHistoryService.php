<?php

namespace App\Services;

use App\Models\ServerStatusSample;
use Illuminate\Support\Carbon;

/**
 * Uptime and population, read back out of the status samples.
 *
 * Uptime here is the share of *samples* that found the server up, not wall
 * clock — if the sampler itself was down, those minutes are unmeasured rather
 * than counted as an outage, which is the honest reading of the data.
 */
class ServerHistoryService
{
    /** How long a sample stays interesting. */
    public const RETENTION_DAYS = 90;

    /**
     * @return array{
     *     uptime: array{day: float|null, week: float|null, month: float|null},
     *     peak_players: int,
     *     average_players: float,
     *     sample_count: int,
     *     population: array<int, array{at: string, players: int, online: bool}>
     * }
     */
    public function summary(): array
    {
        return [
            'uptime' => [
                'day' => $this->uptimeSince(now()->subDay()),
                'week' => $this->uptimeSince(now()->subWeek()),
                'month' => $this->uptimeSince(now()->subMonth()),
            ],
            'peak_players' => $this->peakPlayersSince(now()->subWeek()),
            'average_players' => $this->averagePlayersSince(now()->subWeek()),
            'sample_count' => ServerStatusSample::query()->where('sampled_at', '>=', now()->subMonth())->count(),
            'population' => $this->population(now()->subDay()),
        ];
    }

    /**
     * Percentage of samples in the window that found the server online, or
     * null when nothing was sampled — an empty window is unknown, not zero.
     */
    public function uptimeSince(Carbon $since): ?float
    {
        $total = ServerStatusSample::query()->where('sampled_at', '>=', $since)->count();

        if ($total === 0) {
            return null;
        }

        $up = ServerStatusSample::query()
            ->where('sampled_at', '>=', $since)
            ->where('online', true)
            ->count();

        return round($up / $total * 100, 2);
    }

    public function peakPlayersSince(Carbon $since): int
    {
        return (int) ServerStatusSample::query()
            ->where('sampled_at', '>=', $since)
            ->max('player_count');
    }

    public function averagePlayersSince(Carbon $since): float
    {
        $average = ServerStatusSample::query()
            ->where('sampled_at', '>=', $since)
            ->where('online', true)
            ->avg('player_count');

        return round((float) $average, 1);
    }

    /**
     * Player counts over time, for the chart on the status page.
     *
     * @return array<int, array{at: string, players: int, online: bool}>
     */
    public function population(Carbon $since, int $limit = 288): array
    {
        return ServerStatusSample::query()
            ->where('sampled_at', '>=', $since)
            ->orderBy('sampled_at')
            ->limit($limit)
            ->get(['sampled_at', 'player_count', 'online'])
            ->map(fn (ServerStatusSample $sample) => [
                'at' => $sample->sampled_at->toIso8601String(),
                'players' => $sample->player_count,
                'online' => $sample->online,
            ])
            ->all();
    }

    /**
     * Drop samples past the retention window. Returns how many went.
     */
    public function prune(): int
    {
        return ServerStatusSample::query()
            ->where('sampled_at', '<', now()->subDays(self::RETENTION_DAYS))
            ->delete();
    }
}
