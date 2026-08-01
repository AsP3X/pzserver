<?php

use App\Enums\BackupType;
use App\Enums\UserRole;
use App\Jobs\CreateBackupJob;
use App\Jobs\RollbackGameServer;
use App\Models\AuditLog;
use App\Models\Backup;
use App\Models\User;
use App\Services\BackupManager;
use App\Services\DockerManager;
use App\Services\RconClient;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->admin = User::factory()->admin()->create();

    $docker = Mockery::mock(DockerManager::class);
    $docker->shouldReceive('getContainerStatus')->andReturn([
        'exists' => true,
        'running' => true,
        'status' => 'running',
    ])->byDefault();
    $docker->shouldReceive('stopContainer')->andReturn(true)->byDefault();
    $docker->shouldReceive('startContainer')->andReturn(true)->byDefault();
    app()->instance(DockerManager::class, $docker);
});

// ── Create Backup with player notification ───────────────────────────

describe('Create backup player notification', function () {
    it('broadcasts RCON message when notify_players is true', function () {
        Queue::fake();

        $rcon = Mockery::mock(RconClient::class);
        $rcon->shouldReceive('connect')->once();
        $rcon->shouldReceive('command')
            ->with('servermsg "Saving the world, hold tight!"')
            ->once();
        app()->instance(RconClient::class, $rcon);

        $this->actingAs($this->admin)
            ->postJson(route('admin.backups.store'), [
                'notify_players' => true,
                'message' => 'Saving the world, hold tight!',
            ])
            ->assertStatus(202);

        Queue::assertPushed(CreateBackupJob::class);
    });

    it('uses default message when notify_players is true and no custom message', function () {
        Queue::fake();

        $rcon = Mockery::mock(RconClient::class);
        $rcon->shouldReceive('connect')->once();
        $rcon->shouldReceive('command')
            ->with('servermsg "Backup in progress — expect a brief lag"')
            ->once();
        app()->instance(RconClient::class, $rcon);

        $this->actingAs($this->admin)
            ->postJson(route('admin.backups.store'), [
                'notify_players' => true,
            ])
            ->assertStatus(202);

        Queue::assertPushed(CreateBackupJob::class);
    });

    it('does not broadcast when notify_players is false', function () {
        Queue::fake();

        $rcon = Mockery::mock(RconClient::class);
        $rcon->shouldNotReceive('connect');
        app()->instance(RconClient::class, $rcon);

        $this->actingAs($this->admin)
            ->postJson(route('admin.backups.store'), [
                'notes' => 'Quick backup',
            ])
            ->assertStatus(202);

        Queue::assertPushed(CreateBackupJob::class);
    });

    it('proceeds with backup when RCON is offline', function () {
        Queue::fake();

        $rcon = Mockery::mock(RconClient::class);
        $rcon->shouldReceive('connect')->andThrow(new RuntimeException('Connection refused'));
        app()->instance(RconClient::class, $rcon);

        $this->actingAs($this->admin)
            ->postJson(route('admin.backups.store'), [
                'notify_players' => true,
            ])
            ->assertStatus(202);

        Queue::assertPushed(CreateBackupJob::class);
    });
});

// ── Rollback with countdown ──────────────────────────────────────────

describe('Rollback with countdown', function () {
    it('dispatches rollback job when no countdown provided', function () {
        Queue::fake();
        $backup = Backup::factory()->create();

        $backupManager = Mockery::mock(BackupManager::class);
        $backupManager->shouldReceive('validateBackupFile')->once();
        app()->instance(BackupManager::class, $backupManager);

        $this->actingAs($this->admin)
            ->postJson(route('admin.backups.rollback', $backup), [
                'confirm' => true,
            ])
            ->assertOk()
            ->assertJson(['message' => 'Rollback initiated — server will restart shortly']);

        Queue::assertPushed(RollbackGameServer::class);
        expect(AuditLog::where('action', 'backup.rollback.initiated')->exists())->toBeTrue();
    });

    it('schedules rollback with countdown and broadcasts RCON warning', function () {
        Queue::fake();
        $backup = Backup::factory()->create();

        $backupManager = Mockery::mock(BackupManager::class);
        $backupManager->shouldReceive('validateBackupFile')->once();
        app()->instance(BackupManager::class, $backupManager);

        $rcon = Mockery::mock(RconClient::class);
        $rcon->shouldReceive('connect')->once();
        $rcon->shouldReceive('command')
            ->with('servermsg "Rolling back in 60s — save your progress!"')
            ->once();
        app()->instance(RconClient::class, $rcon);

        $this->actingAs($this->admin)
            ->postJson(route('admin.backups.rollback', $backup), [
                'confirm' => true,
                'countdown' => 60,
                'message' => 'Rolling back in 60s — save your progress!',
            ])
            ->assertOk()
            ->assertJson([
                'message' => 'Rollback scheduled in 60 seconds',
            ]);

        Queue::assertPushed(RollbackGameServer::class);
        expect(AuditLog::where('action', 'backup.rollback.scheduled')->exists())->toBeTrue();
    });

    it('uses default warning message when none provided', function () {
        Queue::fake();
        $backup = Backup::factory()->create();

        $backupManager = Mockery::mock(BackupManager::class);
        $backupManager->shouldReceive('validateBackupFile')->once();
        app()->instance(BackupManager::class, $backupManager);

        $rcon = Mockery::mock(RconClient::class);
        $rcon->shouldReceive('connect')->once();
        $rcon->shouldReceive('command')
            ->with('servermsg "Server rolling back in 30 seconds — you will be disconnected"')
            ->once();
        app()->instance(RconClient::class, $rcon);

        $this->actingAs($this->admin)
            ->postJson(route('admin.backups.rollback', $backup), [
                'confirm' => true,
                'countdown' => 30,
            ])
            ->assertOk();

        Queue::assertPushed(RollbackGameServer::class);
    });

    it('schedules rollback even when RCON is offline', function () {
        Queue::fake();
        $backup = Backup::factory()->create();

        $backupManager = Mockery::mock(BackupManager::class);
        $backupManager->shouldReceive('validateBackupFile')->once();
        app()->instance(BackupManager::class, $backupManager);

        $rcon = Mockery::mock(RconClient::class);
        $rcon->shouldReceive('connect')->andThrow(new RuntimeException('Connection refused'));
        app()->instance(RconClient::class, $rcon);

        $this->actingAs($this->admin)
            ->postJson(route('admin.backups.rollback', $backup), [
                'confirm' => true,
                'countdown' => 60,
            ])
            ->assertOk()
            ->assertJson(['message' => 'Rollback scheduled in 60 seconds']);

        Queue::assertPushed(RollbackGameServer::class);
    });

    it('rejects countdown below minimum', function () {
        $backup = Backup::factory()->create();

        $this->actingAs($this->admin)
            ->postJson(route('admin.backups.rollback', $backup), [
                'confirm' => true,
                'countdown' => 5,
            ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('countdown');
    });

    it('rejects countdown above maximum', function () {
        $backup = Backup::factory()->create();

        $this->actingAs($this->admin)
            ->postJson(route('admin.backups.rollback', $backup), [
                'confirm' => true,
                'countdown' => 9999,
            ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('countdown');
    });

    it('requires admin authentication', function () {
        $player = User::factory()->create(['role' => UserRole::Player]);
        $backup = Backup::factory()->create();

        $this->actingAs($player)
            ->postJson(route('admin.backups.rollback', $backup), [
                'confirm' => true,
            ])
            ->assertForbidden();
    });
});

// ── Bulk Delete ──────────────────────────────────────────────────────

describe('Bulk delete backups', function () {
    it('deletes multiple backups at once', function () {
        $backupManager = Mockery::mock(BackupManager::class);
        $backupManager->shouldReceive('deleteBackup')->times(3);
        app()->instance(BackupManager::class, $backupManager);

        $backups = Backup::factory()->count(3)->create();

        $this->actingAs($this->admin)
            ->deleteJson(route('admin.backups.destroy-bulk'), [
                'ids' => $backups->pluck('id')->all(),
            ])
            ->assertOk()
            ->assertJson(['message' => 'Deleted 3 backup(s)']);

        expect(AuditLog::where('action', 'backup.delete.bulk')->exists())->toBeTrue();
    });

    it('rejects empty ids array', function () {
        $this->actingAs($this->admin)
            ->deleteJson(route('admin.backups.destroy-bulk'), [
                'ids' => [],
            ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('ids');
    });

    it('rejects invalid backup ids', function () {
        $this->actingAs($this->admin)
            ->deleteJson(route('admin.backups.destroy-bulk'), [
                'ids' => ['not-a-valid-uuid'],
            ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('ids.0');
    });

    it('requires admin authentication for bulk delete', function () {
        $player = User::factory()->create(['role' => UserRole::Player]);
        $backups = Backup::factory()->count(2)->create();

        $this->actingAs($player)
            ->deleteJson(route('admin.backups.destroy-bulk'), [
                'ids' => $backups->pluck('id')->all(),
            ])
            ->assertForbidden();
    });
});
