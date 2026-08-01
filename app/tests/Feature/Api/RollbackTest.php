<?php

use App\Models\AuditLog;
use App\Models\Backup;
use App\Services\BackupManager;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

function rollbackApiHeaders(): array
{
    return ['X-API-Key' => 'test-key-12345'];
}

beforeEach(function () {
    config(['zomboid.api_key' => 'test-key-12345']);
});

// ── POST /api/backups/{id}/rollback ──────────────────────────────────

it('performs rollback with confirm flag', function () {
    $backup = Backup::factory()->create();
    $preRollbackBackup = Backup::factory()->preRollback()->create();

    $mockManager = Mockery::mock(BackupManager::class);
    $mockManager->shouldReceive('rollback')
        ->once()
        ->with(Mockery::on(fn ($b) => $b->id === $backup->id))
        ->andReturn([
            'pre_rollback_backup' => $preRollbackBackup,
            'restored_from' => $backup,
        ]);

    app()->instance(BackupManager::class, $mockManager);

    $this->postJson("/api/backups/{$backup->id}/rollback", [
        'confirm' => true,
    ], rollbackApiHeaders())
        ->assertOk()
        ->assertJson(['message' => 'Rollback completed']);

    expect(AuditLog::where('action', 'backup.rollback')->exists())->toBeTrue();
});

it('requires confirm flag', function () {
    $backup = Backup::factory()->create();

    $this->postJson("/api/backups/{$backup->id}/rollback", [], rollbackApiHeaders())
        ->assertUnprocessable()
        ->assertJsonValidationErrors('confirm');
});

it('rejects confirm false', function () {
    $backup = Backup::factory()->create();

    $this->postJson("/api/backups/{$backup->id}/rollback", [
        'confirm' => false,
    ], rollbackApiHeaders())
        ->assertUnprocessable()
        ->assertJsonValidationErrors('confirm');
});

it('returns 404 for nonexistent backup', function () {
    $fakeId = '00000000-0000-0000-0000-000000000000';

    $this->postJson("/api/backups/{$fakeId}/rollback", [
        'confirm' => true,
    ], rollbackApiHeaders())
        ->assertNotFound();
});

it('returns 422 when backup file is missing', function () {
    $backup = Backup::factory()->create([
        'path' => '/nonexistent/backup.tar.gz',
    ]);

    $mockManager = Mockery::mock(BackupManager::class);
    $mockManager->shouldReceive('rollback')
        ->once()
        ->andThrow(new RuntimeException('Backup file not found: /nonexistent/backup.tar.gz'));

    app()->instance(BackupManager::class, $mockManager);

    $this->postJson("/api/backups/{$backup->id}/rollback", [
        'confirm' => true,
    ], rollbackApiHeaders())
        ->assertUnprocessable()
        ->assertJson(['error' => 'Backup file not found: /nonexistent/backup.tar.gz']);
});

it('returns 422 when backup file is corrupted', function () {
    $backup = Backup::factory()->create();

    $mockManager = Mockery::mock(BackupManager::class);
    $mockManager->shouldReceive('rollback')
        ->once()
        ->andThrow(new RuntimeException('Backup file is corrupted or not a valid tar.gz: '.$backup->filename));

    app()->instance(BackupManager::class, $mockManager);

    $this->postJson("/api/backups/{$backup->id}/rollback", [
        'confirm' => true,
    ], rollbackApiHeaders())
        ->assertUnprocessable();
});

it('requires auth for rollback', function () {
    config(['zomboid.api_key' => 'real-key-here']);
    $backup = Backup::factory()->create();

    $this->postJson("/api/backups/{$backup->id}/rollback", [
        'confirm' => true,
    ])->assertUnauthorized();
});

// ── BackupManager rollback unit tests ────────────────────────────────

it('validates backup file existence before rollback', function () {
    $backup = Backup::factory()->create([
        'path' => '/nonexistent/file.tar.gz',
    ]);

    $manager = app(BackupManager::class);
    $manager->validateBackupFile($backup);
})->throws(RuntimeException::class, 'Backup file not found');

it('validates backup file integrity', function () {
    $tmpFile = tempnam(sys_get_temp_dir(), 'pz_bad_backup_');
    file_put_contents($tmpFile, 'this is not a valid tar.gz');

    $backup = Backup::factory()->create([
        'path' => $tmpFile,
        'filename' => basename($tmpFile),
    ]);

    try {
        $manager = app(BackupManager::class);
        $manager->validateBackupFile($backup);
        $this->fail('Expected RuntimeException');
    } catch (RuntimeException $e) {
        expect($e->getMessage())->toContain('corrupted');
    } finally {
        @unlink($tmpFile);
    }
});

it('passes validation for valid tar.gz', function () {
    $tmpFile = tempnam(sys_get_temp_dir(), 'pz_good_backup_').'.tar.gz';
    $tmpDir = sys_get_temp_dir().'/pz_tar_test_'.uniqid();
    mkdir($tmpDir, 0755, true);
    file_put_contents($tmpDir.'/test.txt', 'test data');

    exec("tar -czf {$tmpFile} -C {$tmpDir} test.txt");

    $backup = Backup::factory()->create([
        'path' => $tmpFile,
        'filename' => basename($tmpFile),
    ]);

    $manager = app(BackupManager::class);
    $manager->validateBackupFile($backup);

    // No exception = pass
    expect(true)->toBeTrue();

    @unlink($tmpFile);
    exec('rm -rf '.escapeshellarg($tmpDir));
});
