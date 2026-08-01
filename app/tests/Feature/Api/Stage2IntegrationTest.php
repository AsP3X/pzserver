<?php

use App\Models\AuditLog;
use App\Models\Backup;
use App\Models\WhitelistEntry;
use App\Services\BackupManager;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;

uses(RefreshDatabase::class);

function stage2Headers(): array
{
    return ['X-API-Key' => 'test-key-12345'];
}

beforeEach(function () {
    config(['zomboid.api_key' => 'test-key-12345']);
    config(['queue.default' => 'sync']);
    cache()->forget('backup.schedule.hourly_enabled');
    cache()->forget('backup.schedule.daily_enabled');
    cache()->forget('backup.schedule.daily_time');
});

// ── Backup → Rollback cycle ──────────────────────────────────────────

it('completes full backup → list → rollback cycle', function () {
    // 1. Create a backup
    $backup = Backup::factory()->manual()->create([
        'filename' => 'cycle_test.tar.gz',
        'size_bytes' => 2048,
    ]);

    // 2. List backups — verify it appears
    $response = $this->getJson('/api/backups', stage2Headers())
        ->assertOk();

    expect($response->json('data'))->toHaveCount(1)
        ->and($response->json('data.0.filename'))->toBe('cycle_test.tar.gz');

    // 3. Rollback to backup (mocked)
    $preRollback = Backup::factory()->preRollback()->create();

    $mockManager = Mockery::mock(BackupManager::class);
    $mockManager->shouldReceive('rollback')
        ->once()
        ->andReturn([
            'pre_rollback_backup' => $preRollback,
            'restored_from' => $backup,
        ]);
    app()->instance(BackupManager::class, $mockManager);

    $this->postJson("/api/backups/{$backup->id}/rollback", [
        'confirm' => true,
    ], stage2Headers())
        ->assertOk()
        ->assertJson(['message' => 'Rollback completed']);

    // 4. Verify audit trail exists for rollback
    expect(AuditLog::where('action', 'backup.rollback')->exists())->toBeTrue();
});

it('completes backup create → delete cycle', function () {
    $mockManager = Mockery::mock(BackupManager::class);
    $backup = Backup::factory()->manual()->create();

    $mockManager->shouldReceive('createBackup')
        ->once()
        ->andReturn(['backup' => $backup, 'cleanup_count' => 0]);
    $mockManager->shouldReceive('deleteBackup')
        ->once()
        ->andReturn(true);

    app()->instance(BackupManager::class, $mockManager);

    // Create (202 Accepted — job dispatched to queue)
    $this->postJson('/api/backups', [], stage2Headers())
        ->assertStatus(202);

    // Delete
    $this->deleteJson("/api/backups/{$backup->id}", [], stage2Headers())
        ->assertOk()
        ->assertJson(['message' => 'Backup deleted']);

    expect(AuditLog::where('action', 'backup.created')->exists())->toBeTrue()
        ->and(AuditLog::where('action', 'backup.delete')->exists())->toBeTrue();
});

// ── Whitelist add → check → remove cycle ─────────────────────────────

it('completes full whitelist add → status → remove cycle', function () {
    // Setup SQLite
    $dbPath = sys_get_temp_dir().'/pz_test_cycle_'.uniqid().'.db';
    touch($dbPath);
    config(['database.connections.pz_sqlite.database' => $dbPath]);
    DB::purge('pz_sqlite');
    DB::connection('pz_sqlite')->statement('
        CREATE TABLE IF NOT EXISTS whitelist (
            username TEXT PRIMARY KEY,
            password TEXT,
            world TEXT DEFAULT NULL,
            role INTEGER DEFAULT 2,
            authType INTEGER DEFAULT 1
        )
    ');

    try {
        // 1. Add user
        $this->postJson('/api/whitelist', [
            'username' => 'cycletest',
            'password' => 'testpass123',
        ], stage2Headers())
            ->assertCreated()
            ->assertJson(['username' => 'cycletest']);

        // 2. Check status — should be whitelisted
        $this->getJson('/api/whitelist/cycletest/status', stage2Headers())
            ->assertOk()
            ->assertJson(['whitelisted' => true]);

        // 3. List — should include user
        $response = $this->getJson('/api/whitelist', stage2Headers())
            ->assertOk();
        expect($response->json('count'))->toBe(1);

        // 4. Remove user
        $this->deleteJson('/api/whitelist/cycletest', [], stage2Headers())
            ->assertOk()
            ->assertJson(['username' => 'cycletest']);

        // 5. Check status — should not be whitelisted
        $this->getJson('/api/whitelist/cycletest/status', stage2Headers())
            ->assertOk()
            ->assertJson(['whitelisted' => false]);

        // 6. Verify PG record is inactive
        expect(WhitelistEntry::where('pz_username', 'cycletest')->where('active', false)->exists())->toBeTrue();

        // 7. Verify audit trail
        expect(AuditLog::where('action', 'whitelist.add')->exists())->toBeTrue()
            ->and(AuditLog::where('action', 'whitelist.remove')->exists())->toBeTrue();
    } finally {
        DB::connection('pz_sqlite')->disconnect();
        @unlink($dbPath);
    }
});

// ── Schedule management ──────────────────────────────────────────────

it('reads and updates backup schedule', function () {
    // 1. Read default schedule
    $response = $this->getJson('/api/backups/schedule', stage2Headers())
        ->assertOk();

    expect($response->json('hourly_enabled'))->toBeTrue()
        ->and($response->json('daily_enabled'))->toBeTrue();

    // 2. Update schedule
    $this->putJson('/api/backups/schedule', [
        'hourly_enabled' => false,
        'daily_time' => '05:30',
        'retention_manual' => 20,
    ], stage2Headers())
        ->assertOk();

    // 3. Verify audit log
    expect(AuditLog::where('action', 'backup.schedule.update')->exists())->toBeTrue();
});

// ── Cross-feature audit trail ────────────────────────────────────────

it('maintains complete audit trail across all stage 2 features', function () {
    // Setup SQLite for whitelist
    $dbPath = sys_get_temp_dir().'/pz_test_audit_'.uniqid().'.db';
    touch($dbPath);
    config(['database.connections.pz_sqlite.database' => $dbPath]);
    DB::purge('pz_sqlite');
    DB::connection('pz_sqlite')->statement('
        CREATE TABLE IF NOT EXISTS whitelist (username TEXT PRIMARY KEY, password TEXT, world TEXT DEFAULT NULL, role INTEGER DEFAULT 2, authType INTEGER DEFAULT 1)
    ');

    $mockManager = Mockery::mock(BackupManager::class);
    $backup = Backup::factory()->manual()->create();
    $mockManager->shouldReceive('createBackup')
        ->andReturn(['backup' => $backup, 'cleanup_count' => 0]);
    $mockManager->shouldReceive('deleteBackup')->andReturn(true);
    app()->instance(BackupManager::class, $mockManager);

    try {
        // Backup create (202 Accepted — job dispatched to queue)
        $this->postJson('/api/backups', [], stage2Headers())->assertStatus(202);

        // Backup delete
        $this->deleteJson("/api/backups/{$backup->id}", [], stage2Headers())->assertOk();

        // Schedule update
        $this->putJson('/api/backups/schedule', ['hourly_enabled' => false], stage2Headers())->assertOk();

        // Whitelist add
        $this->postJson('/api/whitelist', ['username' => 'audituser', 'password' => 'pass1234'], stage2Headers())->assertCreated();

        // Whitelist remove
        $this->deleteJson('/api/whitelist/audituser', [], stage2Headers())->assertOk();

        // Verify all audit actions exist
        $actions = AuditLog::pluck('action')->unique()->sort()->values()->all();
        expect($actions)->toContain('backup.created')
            ->toContain('backup.delete')
            ->toContain('backup.schedule.update')
            ->toContain('whitelist.add')
            ->toContain('whitelist.remove');

        expect(AuditLog::count())->toBeGreaterThanOrEqual(5);
    } finally {
        DB::connection('pz_sqlite')->disconnect();
        @unlink($dbPath);
    }
});
