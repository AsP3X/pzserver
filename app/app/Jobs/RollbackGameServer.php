<?php

namespace App\Jobs;

use App\Models\Backup;
use App\Services\AuditLogger;
use App\Services\BackupManager;
use App\Services\GameServerUpdater;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

class RollbackGameServer implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public function __construct(
        private readonly string $backupId,
        private readonly string $ip,
        private readonly ?string $switchBranch = null,
    ) {}

    public function handle(BackupManager $backupManager, GameServerUpdater $updater): void
    {
        Cache::forget('server.pending_action:rollback');

        $backup = Backup::findOrFail($this->backupId);

        $result = $backupManager->rollback($backup);

        $details = [
            'source' => 'scheduled_job',
            'pre_rollback_backup' => $result['pre_rollback_backup']->filename,
        ];

        // If branch switch requested, set override and trigger update after rollback
        if ($this->switchBranch !== null) {
            $updater->setBranch($this->switchBranch);
            $updater->triggerForceUpdate();
            $details['switch_branch'] = $this->switchBranch;

            Log::info('Rollback: branch switch requested, dispatching update', [
                'branch' => $this->switchBranch,
            ]);
        }

        AuditLogger::record(
            actor: 'system',
            action: 'backup.rollback.executed',
            target: $backup->filename,
            details: $details,
            ip: $this->ip,
        );

        WaitForServerReady::dispatch(
            'backup.rollback.completed',
            'system',
            $this->ip,
        );
    }
}
