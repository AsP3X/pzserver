<?php

namespace App\Services;

use App\Models\Backup;
use App\Models\MoneyDeposit;

/**
 * Post-deploy / ops checklist for the admin dashboard.
 */
class DeployChecklistService
{
    public function __construct(
        private readonly ServerStatusResolver $statusResolver,
        private readonly LuaBridgeHealthService $bridgeHealth,
        private readonly DockerManager $docker,
        private readonly RconClient $rcon,
    ) {}

    /**
     * @return array{
     *     overall_ok: bool,
     *     items: list<array{id: string, label: string, ok: bool, detail: string, severity: string}>,
     *     backup: array{last_at: ?string, age_hours: ?float, stale: bool},
     *     resources: array{memory_usage: ?string, memory_limit: ?string, cpu_percent: ?float}|null,
     *     pending_deposits: int
     * }
     */
    public function checklist(): array
    {
        $items = [];
        $resolved = $this->statusResolver->resolve();

        $items[] = [
            'id' => 'container',
            'label' => 'Game container running',
            'ok' => (bool) ($resolved['container_status'] === 'running' || $resolved['online']),
            'detail' => 'status='.($resolved['container_status'] ?? 'unknown').', game='.($resolved['game_status'] ?? 'unknown'),
            'severity' => 'critical',
        ];

        $items[] = [
            'id' => 'game_online',
            'label' => 'Game server online (RCON/players)',
            'ok' => (bool) $resolved['online'],
            'detail' => 'players='.($resolved['player_count'] ?? 0),
            'severity' => 'critical',
        ];

        $rconOk = false;
        $rconDetail = 'not tested';
        try {
            $rconOk = $this->rcon->isConnected() || $this->tryRconPing();
            $rconDetail = $rconOk ? 'RCON responsive' : 'RCON not responding';
        } catch (\Throwable $e) {
            $rconDetail = $e->getMessage();
        }
        $items[] = [
            'id' => 'rcon',
            'label' => 'RCON reachable',
            'ok' => $rconOk,
            'detail' => $rconDetail,
            'severity' => 'critical',
        ];

        $bridge = $this->bridgeHealth->status();
        $items[] = [
            'id' => 'lua_bridge',
            'label' => 'Lua bridge writable',
            'ok' => $bridge['healthy'],
            'detail' => $bridge['healthy']
                ? 'path OK'
                : implode('; ', array_slice($bridge['issues'], 0, 3)),
            'severity' => 'critical',
        ];

        $lastBackup = Backup::query()->orderByDesc('created_at')->first();
        $ageHours = $lastBackup?->created_at
            ? round(now()->diffInMinutes($lastBackup->created_at) / 60, 1)
            : null;
        $stale = $lastBackup === null || ($ageHours !== null && $ageHours > 48);
        $items[] = [
            'id' => 'backup',
            'label' => 'Recent backup (< 48h)',
            'ok' => ! $stale,
            'detail' => $lastBackup
                ? "last={$lastBackup->created_at?->toIso8601String()} ({$ageHours}h ago)"
                : 'no backups found',
            'severity' => 'warning',
        ];

        $pending = 0;
        try {
            $pending = MoneyDeposit::query()->where('status', 'pending')->count();
        } catch (\Throwable) {
        }
        $items[] = [
            'id' => 'pending_deposits',
            'label' => 'No stuck deposit requests',
            'ok' => $pending === 0,
            'detail' => "pending={$pending}",
            'severity' => 'warning',
        ];

        $resources = $this->safeContainerStats();

        $overall = true;
        foreach ($items as $item) {
            if (! $item['ok'] && $item['severity'] === 'critical') {
                $overall = false;
                break;
            }
        }

        return [
            'overall_ok' => $overall,
            'items' => $items,
            'backup' => [
                'last_at' => $lastBackup?->created_at?->toIso8601String(),
                'age_hours' => $ageHours,
                'stale' => $stale,
            ],
            'resources' => $resources,
            'pending_deposits' => $pending,
        ];
    }

    private function tryRconPing(): bool
    {
        try {
            // Some implementations use command(); fall back gracefully
            if (method_exists($this->rcon, 'command')) {
                $this->rcon->command('help');

                return true;
            }
        } catch (\Throwable) {
            return false;
        }

        return false;
    }

    /**
     * @return array{memory_usage: ?string, memory_limit: ?string, cpu_percent: ?float}|null
     */
    private function safeContainerStats(): ?array
    {
        try {
            return $this->docker->getContainerStats();
        } catch (\Throwable) {
            return null;
        }
    }
}
