<?php

namespace App\Http\Controllers\Api;

use App\Enums\BackupType;
use App\Http\Requests\Api\CreateBackupRequest;
use App\Http\Requests\Api\RollbackRequest;
use App\Http\Requests\Api\UpdateBackupScheduleRequest;
use App\Http\Resources\BackupResource;
use App\Jobs\CreateBackupJob;
use App\Models\Backup;
use App\Services\AuditLogger;
use App\Services\BackupManager;
use Illuminate\Http\JsonResponse;

class BackupController
{
    public function __construct(
        private readonly BackupManager $backupManager,
        private readonly AuditLogger $auditLogger,
    ) {}

    public function index(): JsonResponse
    {
        $query = Backup::query()->orderByDesc('created_at');

        if ($type = request()->query('type')) {
            $query->where('type', $type);
        }

        $perPage = min((int) request()->query('per_page', 15), 100);
        $backups = $query->paginate($perPage);

        return BackupResource::collection($backups)->response();
    }

    public function store(CreateBackupRequest $request): JsonResponse
    {
        CreateBackupJob::dispatch(
            BackupType::Manual,
            $request->validated('notes'),
            'api-key',
            $request->ip(),
        );

        return response()->json([
            'message' => 'Backup started — it will appear in the list shortly',
        ], 202);
    }

    public function destroy(Backup $backup): JsonResponse
    {
        $filename = $backup->filename;

        $this->backupManager->deleteBackup($backup);

        $this->auditLogger->log(
            actor: 'api-key',
            action: 'backup.delete',
            target: $filename,
            ip: request()->ip(),
        );

        return response()->json([
            'message' => 'Backup deleted',
            'filename' => $filename,
        ]);
    }

    public function rollback(Backup $backup, RollbackRequest $request): JsonResponse
    {
        try {
            $result = $this->backupManager->rollback($backup);
        } catch (\RuntimeException $e) {
            return response()->json([
                'error' => $e->getMessage(),
            ], 422);
        }

        $this->auditLogger->log(
            actor: 'api-key',
            action: 'backup.rollback',
            target: $backup->filename,
            details: [
                'restored_from' => $backup->id,
                'pre_rollback_backup' => $result['pre_rollback_backup']->filename,
            ],
            ip: $request->ip(),
        );

        return response()->json([
            'message' => 'Rollback completed',
            'restored_from' => new BackupResource($result['restored_from']),
            'pre_rollback_backup' => new BackupResource($result['pre_rollback_backup']),
        ]);
    }

    public function schedule(): JsonResponse
    {
        $config = config('zomboid.backups');

        return response()->json([
            'hourly_enabled' => cache()->get('backup.schedule.hourly_enabled', true),
            'daily_enabled' => cache()->get('backup.schedule.daily_enabled', true),
            'daily_time' => cache()->get('backup.schedule.daily_time', '04:00'),
            'retention' => $config['retention'],
        ]);
    }

    public function updateSchedule(UpdateBackupScheduleRequest $request): JsonResponse
    {
        $validated = $request->validated();

        if (array_key_exists('hourly_enabled', $validated)) {
            cache()->forever('backup.schedule.hourly_enabled', $validated['hourly_enabled']);
        }

        if (array_key_exists('daily_enabled', $validated)) {
            cache()->forever('backup.schedule.daily_enabled', $validated['daily_enabled']);
        }

        if (array_key_exists('daily_time', $validated)) {
            cache()->forever('backup.schedule.daily_time', $validated['daily_time']);
        }

        // Update retention values in cache (override config)
        foreach (['manual', 'scheduled', 'daily', 'pre_rollback', 'pre_update'] as $type) {
            $key = "retention_{$type}";
            if (array_key_exists($key, $validated)) {
                cache()->forever("backup.retention.{$type}", $validated[$key]);
            }
        }

        $this->auditLogger->log(
            actor: 'api-key',
            action: 'backup.schedule.update',
            details: $validated,
            ip: $request->ip(),
        );

        return response()->json([
            'message' => 'Backup schedule updated',
            'updated' => array_keys($validated),
        ]);
    }
}
