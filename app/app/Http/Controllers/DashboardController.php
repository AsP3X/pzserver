<?php

namespace App\Http\Controllers;

use App\Models\AuditLog;
use App\Models\AutoRestartSetting;
use App\Models\Backup;
use App\Models\ScheduledRestartTime;
use App\Models\GameEvent;
use App\Models\PlayerStat;
use App\Models\ServerSetting;
use App\Services\GameStateReader;
use App\Services\PlayerStatsService;
use App\Services\ServerStatusResolver;
use Inertia\Inertia;
use Inertia\Response;

class DashboardController extends Controller
{
    public function __construct(
        private readonly ServerStatusResolver $statusResolver,
        private readonly GameStateReader $gameStateReader,
        private readonly PlayerStatsService $playerStatsService,
    ) {}

    public function __invoke(): Response
    {
        $resolved = $this->statusResolver->resolve();

        // Enrich online players with stats data
        $playerNames = $resolved['players'] ?? [];
        $enrichedPlayers = [];
        if (! empty($playerNames)) {
            $stats = PlayerStat::query()
                ->whereIn('username', $playerNames)
                ->get()
                ->keyBy('username');

            foreach ($playerNames as $name) {
                $stat = $stats->get($name);
                $enrichedPlayers[] = [
                    'username' => $name,
                    'zombie_kills' => $stat?->zombie_kills,
                    'hours_survived' => $stat?->hours_survived,
                    'profession' => $stat?->profession,
                ];
            }
        }

        $server = [
            'online' => $resolved['online'],
            'status' => $resolved['game_status'],
            'container_status' => $resolved['container_status'],
            'player_count' => $resolved['player_count'],
            'players' => $enrichedPlayers,
            'uptime' => $resolved['uptime'],
            'map' => $resolved['map'],
            'max_players' => $resolved['max_players'],
            'game_version' => $resolved['game_version'],
            'steam_branch' => $resolved['steam_branch'],
        ];

        $recentAudit = AuditLog::query()
            ->orderByDesc('created_at')
            ->limit(10)
            ->get()
            ->map(fn (AuditLog $log) => [
                'id' => $log->id,
                'actor' => $log->actor,
                'action' => $log->action,
                'target' => $log->target,
                'details' => $log->details,
                'ip_address' => $log->ip_address,
                'created_at' => $log->created_at?->toIso8601String(),
            ])
            ->all();

        $backupQuery = Backup::query();
        $totalCount = $backupQuery->count();
        $totalSizeBytes = (int) $backupQuery->sum('size_bytes');
        $lastBackup = Backup::query()
            ->orderByDesc('created_at')
            ->first();

        $backupSummary = [
            'total_count' => $totalCount,
            'last_backup' => $lastBackup ? [
                'id' => $lastBackup->id,
                'filename' => $lastBackup->filename,
                'size_bytes' => $lastBackup->size_bytes,
                'size_human' => $this->formatBytes($lastBackup->size_bytes),
                'type' => $lastBackup->type->value,
                'notes' => $lastBackup->notes,
                'created_at' => $lastBackup->created_at?->toIso8601String(),
            ] : null,
            'total_size_human' => $this->formatBytes($totalSizeBytes),
        ];

        $gameState = $resolved['online'] ? $this->gameStateReader->getGameState() : null;

        $autoRestart = AutoRestartSetting::instance();
        $schedule = ScheduledRestartTime::query()
            ->where('enabled', true)
            ->orderBy('time')
            ->pluck('time')
            ->all();

        $autoRestartData = [
            'enabled' => $autoRestart->enabled,
            'next_restart_at' => $autoRestart->getNextRestartTime()?->toIso8601String(),
            'schedule' => $schedule,
            'timezone' => $autoRestart->timezone,
        ];

        return Inertia::render('dashboard', [
            'server' => $server,
            'auto_restart' => $autoRestartData,
            'game_state' => $gameState,
            'recent_audit' => Inertia::defer(fn () => $recentAudit),
            'backup_summary' => Inertia::defer(fn () => $backupSummary),
            'leaderboard' => Inertia::defer(fn () => [
                'kills' => $this->playerStatsService->getLeaderboard('zombie_kills', 5),
                'survival' => $this->playerStatsService->getLeaderboard('hours_survived', 5),
                'deaths' => $this->playerStatsService->getDeathLeaderboard(5),
            ]),
            'game_events' => Inertia::defer(fn () => GameEvent::query()
                ->orderByDesc('created_at')
                ->limit(15)
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
                ->all()),
            'server_totals' => Inertia::defer(fn () => $this->playerStatsService->getServerStats()),
            'connection' => ServerSetting::instance()->only('server_ip', 'server_port'),
        ]);
    }

    private function formatBytes(int $bytes): string
    {
        if ($bytes >= 1073741824) {
            return round($bytes / 1073741824, 2).' GB';
        }

        if ($bytes >= 1048576) {
            return round($bytes / 1048576, 2).' MB';
        }

        if ($bytes >= 1024) {
            return round($bytes / 1024, 2).' KB';
        }

        return $bytes.' B';
    }
}
