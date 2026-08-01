<?php

namespace App\Jobs;

use App\Enums\BackupType;
use App\Services\AuditLogger;
use App\Services\BackupManager;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;

class CreateBackupJob implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public int $timeout = 300;

    public function __construct(
        private readonly BackupType $type,
        private readonly ?string $notes = null,
        private readonly ?string $actor = null,
        private readonly ?string $ip = null,
    ) {}

    public function handle(BackupManager $backupManager): void
    {
        $result = $backupManager->createBackup($this->type, $this->notes);

        $backup = $result['backup'];

        AuditLogger::record(
            actor: $this->actor ?? 'system',
            action: 'backup.created',
            target: $backup->filename,
            details: [
                'type' => $this->type->value,
                'size_bytes' => $backup->size_bytes,
                'cleanup_count' => $result['cleanup_count'],
                'source' => $this->actor ? 'manual' : 'scheduled_job',
            ],
            ip: $this->ip,
        );

        Log::info('Backup completed', [
            'filename' => $backup->filename,
            'type' => $this->type->value,
            'size_bytes' => $backup->size_bytes,
            'actor' => $this->actor ?? 'system',
        ]);
    }
}
