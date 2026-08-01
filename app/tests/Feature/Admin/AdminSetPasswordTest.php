<?php

use App\Enums\UserRole;
use App\Models\AuditLog;
use App\Models\User;
use App\Services\PzPasswordSyncService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->admin = User::factory()->admin()->create();
    $this->player = User::factory()->create(['username' => 'testplayer']);

    // Mock PzPasswordSyncService to avoid SQLite dependency in tests
    $this->pzSync = Mockery::mock(PzPasswordSyncService::class);
    app()->instance(PzPasswordSyncService::class, $this->pzSync);
});

it('admin can set a player password', function () {
    $this->pzSync->shouldReceive('sync')
        ->once()
        ->with('testplayer', 'newpassword123');

    $this->actingAs($this->admin)
        ->postJson(route('admin.players.password', 'testplayer'), [
            'password' => 'newpassword123',
            'password_confirmation' => 'newpassword123',
        ])
        ->assertOk()
        ->assertJson(['message' => 'Password set for testplayer']);

    $this->player->refresh();
    expect(Hash::check('newpassword123', $this->player->password))->toBeTrue();

    expect(AuditLog::where('action', 'player.setpassword')->where('target', 'testplayer')->exists())->toBeTrue();
});

it('syncs password to PZ via service', function () {
    $this->pzSync->shouldReceive('sync')
        ->once()
        ->with('testplayer', 'syncpass456');

    $this->actingAs($this->admin)
        ->postJson(route('admin.players.password', 'testplayer'), [
            'password' => 'syncpass456',
            'password_confirmation' => 'syncpass456',
        ])
        ->assertOk();
});

it('rejects mismatched password confirmation', function () {
    $this->pzSync->shouldNotReceive('sync');

    $this->actingAs($this->admin)
        ->postJson(route('admin.players.password', 'testplayer'), [
            'password' => 'newpassword123',
            'password_confirmation' => 'different',
        ])
        ->assertUnprocessable()
        ->assertJsonValidationErrors('password');
});

it('rejects password that is too short', function () {
    $this->pzSync->shouldNotReceive('sync');

    $this->actingAs($this->admin)
        ->postJson(route('admin.players.password', 'testplayer'), [
            'password' => 'short',
            'password_confirmation' => 'short',
        ])
        ->assertUnprocessable()
        ->assertJsonValidationErrors('password');
});

it('rejects missing password', function () {
    $this->pzSync->shouldNotReceive('sync');

    $this->actingAs($this->admin)
        ->postJson(route('admin.players.password', 'testplayer'), [])
        ->assertUnprocessable()
        ->assertJsonValidationErrors('password');
});

it('returns 404 for unregistered username', function () {
    $this->pzSync->shouldNotReceive('sync');

    $this->actingAs($this->admin)
        ->postJson(route('admin.players.password', 'nonexistent'), [
            'password' => 'newpassword123',
            'password_confirmation' => 'newpassword123',
        ])
        ->assertNotFound()
        ->assertJson(['error' => 'User nonexistent not found']);
});

it('denies non-admin users', function () {
    $player = User::factory()->create(['role' => UserRole::Player]);

    $this->actingAs($player)
        ->postJson(route('admin.players.password', 'testplayer'), [
            'password' => 'newpassword123',
            'password_confirmation' => 'newpassword123',
        ])
        ->assertForbidden();
});
