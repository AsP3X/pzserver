<?php

namespace App\Services;

use App\Models\GameEvent;
use App\Models\PlayerStat;
use Illuminate\Support\Facades\DB;

class PlayerStatsService
{
    private string $statsPath;

    public function __construct(?string $statsPath = null)
    {
        $this->statsPath = $statsPath ?? config('zomboid.lua_bridge.player_stats');
    }

    /**
     * Read stats JSON from the Lua bridge and upsert into the database.
     *
     * @return int Number of player records upserted
     */
    public function sync(): int
    {
        $data = $this->readStatsFile();
        if ($data === null || empty($data['players'])) {
            return 0;
        }

        $count = 0;
        foreach ($data['players'] as $playerData) {
            $username = $playerData['username'] ?? null;
            if ($username === null || $username === 'unknown') {
                continue;
            }

            PlayerStat::query()->updateOrCreate(
                ['username' => $username],
                [
                    'zombie_kills' => (int) ($playerData['zombie_kills'] ?? 0),
                    'hours_survived' => (float) ($playerData['hours_survived'] ?? 0),
                    'profession' => $playerData['profession'] ?? null,
                    'skills' => $playerData['skills'] ?? null,
                    'is_dead' => (bool) ($playerData['is_dead'] ?? false),
                ],
            );

            $count++;
        }

        return $count;
    }

    /**
     * Get the top players by a given stat.
     *
     * @return array<int, array{username: string, zombie_kills: int, hours_survived: float, profession: string|null}>
     */
    public function getLeaderboard(string $stat = 'zombie_kills', int $limit = 10): array
    {
        return PlayerStat::query()
            ->orderByDesc($stat)
            ->limit($limit)
            ->get(['username', 'zombie_kills', 'hours_survived', 'profession'])
            ->toArray();
    }

    /**
     * Get aggregated server-wide stats.
     *
     * @return array{total_players: int, total_zombie_kills: int, total_hours_survived: float, total_deaths: int, total_pvp_kills: int, most_popular_profession: string|null}
     */
    public function getServerStats(): array
    {
        $playerAggregates = PlayerStat::query()
            ->selectRaw('COUNT(*) as total_players')
            ->selectRaw('COALESCE(SUM(zombie_kills), 0) as total_zombie_kills')
            ->selectRaw('COALESCE(SUM(hours_survived), 0) as total_hours_survived')
            ->first();

        $totalDeaths = GameEvent::query()
            ->where('event_type', 'death')
            ->count();

        $totalPvpKills = GameEvent::query()
            ->where('event_type', 'pvp_kill')
            ->count();

        $mostPopularProfession = PlayerStat::query()
            ->whereNotNull('profession')
            ->select('profession')
            ->selectRaw('COUNT(*) as cnt')
            ->groupBy('profession')
            ->orderByDesc('cnt')
            ->value('profession');

        return [
            'total_players' => (int) $playerAggregates->total_players,
            'total_zombie_kills' => (int) $playerAggregates->total_zombie_kills,
            'total_hours_survived' => (float) $playerAggregates->total_hours_survived,
            'total_deaths' => $totalDeaths,
            'total_pvp_kills' => $totalPvpKills,
            'most_popular_profession' => $mostPopularProfession,
        ];
    }

    /**
     * Get a full leaderboard with all fields and rank numbers.
     *
     * @return array<int, array{rank: int, username: string, zombie_kills: int, hours_survived: float, profession: string|null, is_dead: bool}>
     */
    public function getFullLeaderboard(string $stat = 'zombie_kills', int $limit = 25): array
    {
        return PlayerStat::query()
            ->orderByDesc($stat)
            ->limit($limit)
            ->get(['username', 'zombie_kills', 'hours_survived', 'profession', 'is_dead'])
            ->values()
            ->map(fn (PlayerStat $player, int $index) => [
                'rank' => $index + 1,
                'username' => $player->username,
                'zombie_kills' => $player->zombie_kills,
                'hours_survived' => $player->hours_survived,
                'profession' => $player->profession,
                'is_dead' => $player->is_dead,
            ])
            ->all();
    }

    /**
     * Get death leaderboard by counting death events per player.
     *
     * @return array<int, array{rank: int, username: string, death_count: int}>
     */
    public function getDeathLeaderboard(int $limit = 25): array
    {
        return GameEvent::query()
            ->where('event_type', 'death')
            ->select('player as username')
            ->selectRaw('COUNT(*) as death_count')
            ->groupBy('player')
            ->orderByDesc('death_count')
            ->limit($limit)
            ->get()
            ->values()
            ->map(fn ($row, int $index) => [
                'rank' => $index + 1,
                'username' => $row->username,
                'death_count' => (int) $row->death_count,
            ])
            ->all();
    }

    /**
     * Get a ratio leaderboard (stat per death).
     *
     * @param  string  $ratioType  One of: kills_per_death, hours_per_death, pvp_per_death
     * @return array<int, array{rank: int, username: string, ratio: float, numerator: int|float, death_count: int}>
     */
    public function getRatioLeaderboard(string $ratioType, int $limit = 25): array
    {
        $deathSubquery = DB::table('game_events')
            ->where('event_type', 'death')
            ->select('player')
            ->selectRaw('COUNT(*) as death_count')
            ->groupBy('player');

        $query = match ($ratioType) {
            'kills_per_death' => DB::table('player_stats')
                ->joinSub($deathSubquery, 'deaths', 'player_stats.username', '=', 'deaths.player')
                ->selectRaw('player_stats.username, player_stats.zombie_kills as numerator, deaths.death_count, 1.0 * player_stats.zombie_kills / deaths.death_count as ratio')
                ->orderByDesc('ratio'),
            'hours_per_death' => DB::table('player_stats')
                ->joinSub($deathSubquery, 'deaths', 'player_stats.username', '=', 'deaths.player')
                ->selectRaw('player_stats.username, player_stats.hours_survived as numerator, deaths.death_count, 1.0 * player_stats.hours_survived / deaths.death_count as ratio')
                ->orderByDesc('ratio'),
            'pvp_per_death' => DB::table('game_events')
                ->where('game_events.event_type', 'pvp_kill')
                ->select('game_events.player as username')
                ->selectRaw('COUNT(*) as numerator')
                ->groupBy('game_events.player')
                ->joinSub($deathSubquery, 'deaths', 'game_events.player', '=', 'deaths.player')
                ->selectRaw('deaths.death_count, 1.0 * COUNT(*) / deaths.death_count as ratio')
                ->groupBy('deaths.death_count')
                ->orderByDesc('ratio'),
            default => throw new \InvalidArgumentException("Unknown ratio type: {$ratioType}"),
        };

        return $query
            ->limit($limit)
            ->get()
            ->values()
            ->map(fn ($row, int $index) => [
                'rank' => $index + 1,
                'username' => $row->username,
                'ratio' => round((float) $row->ratio, 2),
                'numerator' => $ratioType === 'hours_per_death' ? round((float) $row->numerator, 1) : (int) $row->numerator,
                'death_count' => (int) $row->death_count,
            ])
            ->all();
    }

    /**
     * Get a full player profile with stats, skills, ranks, and event counts.
     *
     * @return array{username: string, zombie_kills: int, hours_survived: float, profession: string|null, skills: array<string, int>|null, is_dead: bool, ranks: array{kills: int, survival: int, deaths: int}, event_counts: array{death: int, pvp_hit: int, craft: int, connect: int}, recent_events: array<int, array>}|null
     */
    public function getPlayerProfile(string $username): ?array
    {
        $player = PlayerStat::query()->find($username);

        if (! $player) {
            return null;
        }

        // Calculate rank positions
        $killsRank = PlayerStat::query()
            ->where('zombie_kills', '>', $player->zombie_kills)
            ->count() + 1;

        $survivalRank = PlayerStat::query()
            ->where('hours_survived', '>', $player->hours_survived)
            ->count() + 1;

        $playerDeathCount = GameEvent::query()
            ->where('event_type', 'death')
            ->where('player', $username)
            ->count();

        // Death rank: count players with more deaths (subquery for PostgreSQL compatibility)
        $deathsRank = 0;
        if ($playerDeathCount > 0) {
            $deathsRank = DB::query()
                ->fromSub(
                    DB::table('game_events')
                        ->where('event_type', 'death')
                        ->selectRaw('COUNT(*) as cnt')
                        ->groupBy('player'),
                    'death_counts'
                )
                ->where('cnt', '>', $playerDeathCount)
                ->count() + 1;
        }

        // Event counts by type
        $eventCounts = GameEvent::query()
            ->where('player', $username)
            ->whereIn('event_type', ['death', 'pvp_hit', 'craft', 'connect'])
            ->select('event_type')
            ->selectRaw('COUNT(*) as cnt')
            ->groupBy('event_type')
            ->pluck('cnt', 'event_type')
            ->all();

        // Recent events
        $recentEvents = GameEvent::query()
            ->where('player', $username)
            ->orderByDesc('created_at')
            ->limit(20)
            ->get()
            ->map(fn (GameEvent $event) => [
                'id' => $event->id,
                'event_type' => $event->event_type,
                'player' => $event->player,
                'target' => $event->target,
                'details' => $event->details,
                'game_time' => $event->game_time?->toIso8601String(),
                'created_at' => $event->created_at?->toIso8601String(),
            ])
            ->all();

        return [
            'username' => $player->username,
            'zombie_kills' => $player->zombie_kills,
            'hours_survived' => $player->hours_survived,
            'profession' => $player->profession,
            'skills' => $player->skills,
            'is_dead' => $player->is_dead,
            'ranks' => [
                'kills' => $killsRank,
                'survival' => $survivalRank,
                'deaths' => $deathsRank,
            ],
            'event_counts' => [
                'death' => (int) ($eventCounts['death'] ?? 0),
                'pvp_hit' => (int) ($eventCounts['pvp_hit'] ?? 0),
                'craft' => (int) ($eventCounts['craft'] ?? 0),
                'connect' => (int) ($eventCounts['connect'] ?? 0),
            ],
            'recent_events' => $recentEvents,
        ];
    }

    /**
     * Get wallet leaderboard (by balance or total_spent).
     *
     * @return array<int, array{rank: int, username: string, balance: float, total_spent: float}>
     */
    public function getWalletLeaderboard(string $stat = 'total_spent', int $limit = 25): array
    {
        return DB::table('wallets')
            ->join('users', 'wallets.user_id', '=', 'users.id')
            ->where("wallets.{$stat}", '>', 0)
            ->orderByDesc("wallets.{$stat}")
            ->limit($limit)
            ->select('users.username', 'wallets.balance', 'wallets.total_spent')
            ->get()
            ->values()
            ->map(fn ($row, int $index) => [
                'rank' => $index + 1,
                'username' => $row->username,
                'balance' => round((float) $row->balance, 2),
                'total_spent' => round((float) $row->total_spent, 2),
            ])
            ->all();
    }

    /**
     * Read and parse the stats JSON file.
     *
     * @return array{timestamp: string, player_count: int, players: array<int, array{username: string, zombie_kills: int, hours_survived: float, profession: string|null, skills: array<string, int>, is_dead: bool}>}|null
     */
    private function readStatsFile(): ?array
    {
        if (! file_exists($this->statsPath)) {
            return null;
        }

        $content = file_get_contents($this->statsPath);
        if ($content === false) {
            return null;
        }

        $data = json_decode($content, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            return null;
        }

        return $data;
    }
}
