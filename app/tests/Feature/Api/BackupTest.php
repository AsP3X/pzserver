<?php

use App\Enums\BackupType;
use App\Jobs\CreateBackupJob;
use App\Models\AuditLog;
use App\Models\Backup;
use App\Services\BackupManager;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;

uses(RefreshDatabase::class);

function backupApiHeaders(): array
{
    return ['X-API-Key' => 'test-key-12345'];
}

beforeEach(function () {
    config(['zomboid.api_key' => 'test-key-12345']);
});

// ── GET /api/backups ─────────────────────────────────────────────────

it('returns paginated backup list', function () {
    Backup::factory()->count(5)->create();

    $response = $this->getJson('/api/backups', backupApiHeaders())
        ->assertOk();

    $data = $response->json('data');
    expect($data)->toHaveCount(5);
    expect($response->json('meta.total'))->toBe(5);
});

it('filters backups by type', function () {
    Backup::factory()->manual()->count(3)->create();
    Backup::factory()->scheduled()->count(2)->create();
    Backup::factory()->daily()->count(1)->create();

    $response = $this->getJson('/api/backups?type=manual', backupApiHeaders())
        ->assertOk();

    expect($response->json('data'))->toHaveCount(3);

    $response = $this->getJson('/api/backups?type=scheduled', backupApiHeaders())
        ->assertOk();

    expect($response->json('data'))->toHaveCount(2);
});

it('paginates with per_page parameter', function () {
    Backup::factory()->count(10)->create();

    $response = $this->getJson('/api/backups?per_page=3', backupApiHeaders())
        ->assertOk();

    expect($response->json('data'))->toHaveCount(3)
        ->and($response->json('meta.total'))->toBe(10)
        ->and($response->json('meta.last_page'))->toBe(4);
});

it('returns backups sorted by created_at desc', function () {
    Backup::factory()->create(['created_at' => now()->subDays(2)]);
    Backup::factory()->create(['created_at' => now()->subDay()]);
    Backup::factory()->create(['created_at' => now()]);

    $response = $this->getJson('/api/backups', backupApiHeaders())
        ->assertOk();

    $dates = collect($response->json('data'))->pluck('created_at');
    expect($dates[0] > $dates[1])->toBeTrue()
        ->and($dates[1] > $dates[2])->toBeTrue();
});

it('returns empty list when no backups', function () {
    $this->getJson('/api/backups', backupApiHeaders())
        ->assertOk()
        ->assertJson(['data' => []]);
});

// ── POST /api/backups ────────────────────────────────────────────────

it('dispatches backup job to queue', function () {
    Queue::fake();

    $this->postJson('/api/backups', [
        'notes' => 'Test backup notes',
    ], backupApiHeaders())
        ->assertStatus(202)
        ->assertJsonPath('message', 'Backup started — it will appear in the list shortly');

    Queue::assertPushed(CreateBackupJob::class);
});

it('dispatches backup job without notes', function () {
    Queue::fake();

    $this->postJson('/api/backups', [], backupApiHeaders())
        ->assertStatus(202);

    Queue::assertPushed(CreateBackupJob::class);
});

it('validates notes max length', function () {
    $this->postJson('/api/backups', [
        'notes' => str_repeat('a', 501),
    ], backupApiHeaders())
        ->assertUnprocessable()
        ->assertJsonValidationErrors('notes');
});

// ── DELETE /api/backups/{id} ─────────────────────────────────────────

it('deletes a backup', function () {
    $mockManager = Mockery::mock(BackupManager::class);
    $backup = Backup::factory()->create();

    $mockManager->shouldReceive('deleteBackup')
        ->once()
        ->andReturn(true);

    app()->instance(BackupManager::class, $mockManager);

    $this->deleteJson("/api/backups/{$backup->id}", [], backupApiHeaders())
        ->assertOk()
        ->assertJson(['message' => 'Backup deleted']);

    expect(AuditLog::where('action', 'backup.delete')->exists())->toBeTrue();
});

it('returns 404 for nonexistent backup', function () {
    $fakeId = '00000000-0000-0000-0000-000000000000';

    $this->deleteJson("/api/backups/{$fakeId}", [], backupApiHeaders())
        ->assertNotFound();
});

// ── GET /api/backups/schedule ────────────────────────────────────────

it('returns current schedule config', function () {
    $this->getJson('/api/backups/schedule', backupApiHeaders())
        ->assertOk()
        ->assertJsonStructure([
            'hourly_enabled',
            'daily_enabled',
            'daily_time',
            'retention',
        ]);
});

// ── PUT /api/backups/schedule ────────────────────────────────────────

it('updates schedule settings', function () {
    $this->putJson('/api/backups/schedule', [
        'hourly_enabled' => false,
        'daily_time' => '06:00',
    ], backupApiHeaders())
        ->assertOk()
        ->assertJson([
            'message' => 'Backup schedule updated',
        ]);

    expect(AuditLog::where('action', 'backup.schedule.update')->exists())->toBeTrue();
});

it('validates daily_time format', function () {
    $this->putJson('/api/backups/schedule', [
        'daily_time' => 'not-a-time',
    ], backupApiHeaders())
        ->assertUnprocessable()
        ->assertJsonValidationErrors('daily_time');
});

it('validates retention values', function () {
    $this->putJson('/api/backups/schedule', [
        'retention_manual' => 0,
    ], backupApiHeaders())
        ->assertUnprocessable()
        ->assertJsonValidationErrors('retention_manual');

    $this->putJson('/api/backups/schedule', [
        'retention_manual' => 101,
    ], backupApiHeaders())
        ->assertUnprocessable()
        ->assertJsonValidationErrors('retention_manual');
});

// ── Auth ─────────────────────────────────────────────────────────────

it('requires auth for backup endpoints', function () {
    config(['zomboid.api_key' => 'real-key-here']);

    $backup = Backup::factory()->create();

    $this->getJson('/api/backups')->assertUnauthorized();
    $this->postJson('/api/backups')->assertUnauthorized();
    $this->deleteJson("/api/backups/{$backup->id}")->assertUnauthorized();
    $this->getJson('/api/backups/schedule')->assertUnauthorized();
    $this->putJson('/api/backups/schedule')->assertUnauthorized();
});

// ── Backup Resource Format ──────────────────────────────────────────

it('returns backup with correct resource format', function () {
    Backup::factory()->create([
        'filename' => 'test_backup.tar.gz',
        'size_bytes' => 1048576,
        'type' => BackupType::Manual,
        'notes' => 'Test note',
    ]);

    $response = $this->getJson('/api/backups', backupApiHeaders())
        ->assertOk();

    $backup = $response->json('data.0');

    expect($backup)->toHaveKeys(['id', 'filename', 'size_bytes', 'size_human', 'type', 'notes', 'created_at'])
        ->and($backup['size_human'])->toBe('1 MB')
        ->and($backup['type'])->toBe('manual');
});
