<?php

namespace App\Jobs;

use App\Enums\BackupType;
use App\Services\AuditLogger;
use App\Services\BackupManager;
use App\Services\DockerManager;
use App\Services\RconClient;
use App\Services\WorldWipeService;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

class WipeGameServer implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public int $timeout = 600;

    public function __construct(
        private readonly string $ip,
    ) {}

    public function handle(
        RconClient $rcon,
        DockerManager $docker,
        BackupManager $backupManager,
        WorldWipeService $wipeService,
    ): void {
        Cache::forget('server.pending_action:wipe');

        // 1. Create pre-wipe backup (includes world + config so restore is possible)
        try {
            $result = $backupManager->createBackup(BackupType::PreRollback, 'Pre-wipe safety backup');

            Log::info('Pre-wipe backup created', [
                'filename' => $result['backup']->filename,
            ]);
        } catch (\Throwable $e) {
            Log::warning('Pre-wipe backup failed, proceeding with wipe', [
                'error' => $e->getMessage(),
            ]);
        }

        // 2. Graceful shutdown via RCON, fallback to Docker stop
        try {
            $rcon->connect();
            $rcon->command('save');
            sleep(5);
            $rcon->command('quit');
            // Give PZ a moment to flush before we force-stop
            sleep(3);
        } catch (\Throwable $e) {
            Log::warning('RCON unavailable during scheduled wipe, proceeding with Docker stop', [
                'error' => $e->getMessage(),
            ]);
        }

        try {
            $docker->stopContainer(timeout: 60);
        } catch (\Throwable $e) {
            Log::error('Docker stop failed during wipe', ['error' => $e->getMessage()]);
        }

        // 3. Wipe world saves + every website account; keep SandboxVars/spawns and site config
        $wipe = $wipeService->wipeAll();
        $fs = $wipe['filesystem'];
        $web = $wipe['website'];

        AuditLogger::record(
            actor: 'system',
            action: 'server.wipe.executed',
            target: config('zomboid.docker.container_name'),
            details: [
                'source' => 'scheduled_job',
                'ok' => $wipe['ok'],
                'server_name' => $fs['server_name'] ?? null,
                'filesystem_deleted' => count($fs['deleted'] ?? []),
                'preserved' => array_map('basename', $fs['preserved'] ?? []),
                'filesystem_errors' => $fs['errors'] ?? [],
                'players_deleted' => $web['players_deleted'] ?? 0,
                'website_counts' => $web['counts'] ?? [],
                'website_errors' => $web['errors'] ?? [],
            ],
            ip: $this->ip,
        );

        if (! $wipe['ok']) {
            Log::error('World wipe completed with errors', [
                'filesystem' => $fs,
                'website' => $web,
            ]);
        } else {
            Log::info('World wipe successful', [
                'filesystem_deleted' => count($fs['deleted'] ?? []),
                'players_deleted' => $web['players_deleted'] ?? 0,
                'preserved' => $fs['preserved'] ?? [],
            ]);
        }

        // 4. Start server (fresh world; sandbox/spawn config still on disk)
        try {
            $docker->startContainer();
        } catch (\Throwable $e) {
            Log::error('Docker start failed after wipe', ['error' => $e->getMessage()]);

            return;
        }

        // 5. Wait for server ready
        WaitForServerReady::dispatch(
            'server.wipe.completed',
            'system',
            $this->ip,
        );
    }
}
