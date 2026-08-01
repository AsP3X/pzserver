<?php

use App\Jobs\RestartGameServer;
use App\Models\AuditLog;
use App\Services\DockerManager;
use App\Services\RconClient;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;

uses(RefreshDatabase::class);

function mockDocker(array $statusOverrides = [], array $methodReturns = []): void
{
    $docker = Mockery::mock(DockerManager::class);

    $defaultStatus = [
        'exists' => true,
        'running' => true,
        'status' => 'running',
        'health_status' => 'healthy',
        'started_at' => now()->subHours(2)->toIso8601String(),
        'finished_at' => null,
        'restart_count' => 0,
    ];

    $docker->shouldReceive('getContainerStatus')
        ->andReturn(array_merge($defaultStatus, $statusOverrides))
        ->byDefault();

    $docker->shouldReceive('startContainer')->andReturn($methodReturns['start'] ?? true)->byDefault();
    $docker->shouldReceive('stopContainer')->andReturn($methodReturns['stop'] ?? true)->byDefault();
    $docker->shouldReceive('restartContainer')->andReturn($methodReturns['restart'] ?? true)->byDefault();
    $docker->shouldReceive('getContainerLogs')->andReturn($methodReturns['logs'] ?? ['log line 1', 'log line 2'])->byDefault();

    app()->instance(DockerManager::class, $docker);
}

function mockRcon(array $commands = []): void
{
    $rcon = Mockery::mock(RconClient::class);
    $rcon->shouldReceive('connect')->byDefault();

    // Default catch-all first so specific expectations take precedence
    $rcon->shouldReceive('command')->andReturn('')->byDefault();

    foreach ($commands as $command => $response) {
        $rcon->shouldReceive('command')
            ->with($command)
            ->andReturn($response);
    }

    app()->instance(RconClient::class, $rcon);
}

function mockRconOffline(): void
{
    $rcon = Mockery::mock(RconClient::class);
    $rcon->shouldReceive('connect')->andThrow(new RuntimeException('Connection refused'));
    app()->instance(RconClient::class, $rcon);

    $onlinePlayers = Mockery::mock(\App\Services\OnlinePlayersReader::class);
    $onlinePlayers->shouldReceive('getOnlineUsernames')->andReturn([]);
    $onlinePlayers->shouldReceive('getOnlinePlayers')->andReturn(['usernames' => [], 'source' => 'none']);
    app()->instance(\App\Services\OnlinePlayersReader::class, $onlinePlayers);
}

function apiHeaders(): array
{
    return ['X-API-Key' => 'test-key-12345'];
}

// ── GET /api/server/status (Public) ──────────────────────────────────

it('returns server status when online', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    mockDocker();
    mockRcon(['players' => "Players connected (2):\n-Player1\n-Player2\n"]);

    $response = $this->getJson('/api/server/status')
        ->assertOk()
        ->assertJsonStructure([
            'online', 'player_count', 'players', 'uptime', 'map', 'max_players',
        ]);

    expect($response->json('online'))->toBeTrue()
        ->and($response->json('player_count'))->toBe(2)
        ->and($response->json('players'))->toBe(['Player1', 'Player2'])
        ->and($response->json('uptime'))->not->toBeNull();
});

it('returns offline status when server is down', function () {
    mockDocker(['running' => false, 'status' => 'exited']);
    mockRconOffline();

    $response = $this->getJson('/api/server/status')
        ->assertOk();

    expect($response->json('online'))->toBeFalse()
        ->and($response->json('player_count'))->toBe(0)
        ->and($response->json('players'))->toBe([]);
});

it('does not require auth for status endpoint', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    mockDocker(['running' => false, 'status' => 'exited']);
    mockRconOffline();

    $this->getJson('/api/server/status')
        ->assertOk();
});

it('handles rcon failure gracefully in status', function () {
    mockDocker();
    mockRconOffline();

    $response = $this->getJson('/api/server/status')
        ->assertOk();

    expect($response->json('online'))->toBeTrue()
        ->and($response->json('player_count'))->toBe(0);
});

// ── POST /api/server/start ───────────────────────────────────────────

it('starts a stopped server', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    mockDocker(['running' => false, 'status' => 'exited']);

    $this->postJson('/api/server/start', [], apiHeaders())
        ->assertOk()
        ->assertJson(['message' => 'Server starting']);

    $this->assertDatabaseHas('audit_logs', [
        'action' => 'post:api/server/start',
    ]);
});

it('returns 409 when starting already running server', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    mockDocker(['running' => true]);

    $this->postJson('/api/server/start', [], apiHeaders())
        ->assertStatus(409)
        ->assertJson(['error' => 'Server is already running']);
});

it('requires auth to start server', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    $this->postJson('/api/server/start')
        ->assertUnauthorized();
});

// ── POST /api/server/stop ────────────────────────────────────────────

it('stops the server gracefully', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    $rcon = Mockery::mock(RconClient::class);
    $rcon->shouldReceive('connect')->once();
    $rcon->shouldReceive('command')->with('save')->once();
    $rcon->shouldReceive('command')->with('quit')->once();
    app()->instance(RconClient::class, $rcon);

    mockDocker();

    $this->postJson('/api/server/stop', [], apiHeaders())
        ->assertOk()
        ->assertJson(['message' => 'Server stopped']);

    $this->assertDatabaseHas('audit_logs', [
        'action' => 'post:api/server/stop',
    ]);
});

it('stops via docker when rcon is unavailable', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    mockRconOffline();
    mockDocker();

    $this->postJson('/api/server/stop', [], apiHeaders())
        ->assertOk()
        ->assertJson(['message' => 'Server stopped']);
});

// ── POST /api/server/restart ─────────────────────────────────────────

it('restarts immediately without countdown', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    mockRcon();
    mockDocker();

    $this->postJson('/api/server/restart', [], apiHeaders())
        ->assertOk()
        ->assertJson(['message' => 'Server restarting']);
});

it('schedules restart with countdown', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    Queue::fake();
    mockRcon();
    mockDocker();

    $this->postJson('/api/server/restart', [
        'countdown' => 60,
        'message' => 'Server restarting for updates',
    ], apiHeaders())
        ->assertOk()
        ->assertJson([
            'message' => 'Server restart scheduled in 60 seconds',
            'countdown' => 60,
        ]);

    Queue::assertPushed(RestartGameServer::class);
});

it('broadcasts warning before scheduled restart', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    Queue::fake();

    $rcon = Mockery::mock(RconClient::class);
    $rcon->shouldReceive('connect')->once();
    $rcon->shouldReceive('command')
        ->with('servermsg "Rebooting in 30s"')
        ->once();
    app()->instance(RconClient::class, $rcon);

    mockDocker();

    $this->postJson('/api/server/restart', [
        'countdown' => 30,
        'message' => 'Rebooting in 30s',
    ], apiHeaders())
        ->assertOk();
});

it('validates restart countdown range', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    $this->postJson('/api/server/restart', ['countdown' => 5], apiHeaders())
        ->assertUnprocessable()
        ->assertJsonValidationErrors('countdown');

    $this->postJson('/api/server/restart', ['countdown' => 9999], apiHeaders())
        ->assertUnprocessable()
        ->assertJsonValidationErrors('countdown');
});

// ── POST /api/server/save ────────────────────────────────────────────

it('saves the world', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    mockRcon(['save' => '']);

    $this->postJson('/api/server/save', [], apiHeaders())
        ->assertOk()
        ->assertJson(['message' => 'World saved']);

    $this->assertDatabaseHas('audit_logs', [
        'action' => 'post:api/server/save',
    ]);
});

it('returns 503 when save fails due to offline server', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    mockRconOffline();

    $this->postJson('/api/server/save', [], apiHeaders())
        ->assertStatus(503)
        ->assertJsonStructure(['error', 'detail']);
});

// ── POST /api/server/broadcast ───────────────────────────────────────

it('broadcasts a message', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    $rcon = Mockery::mock(RconClient::class);
    $rcon->shouldReceive('connect')->once();
    $rcon->shouldReceive('command')
        ->with('servermsg "Hello survivors!"')
        ->once()
        ->andReturn('');
    app()->instance(RconClient::class, $rcon);

    $this->postJson('/api/server/broadcast', [
        'message' => 'Hello survivors!',
    ], apiHeaders())
        ->assertOk()
        ->assertJson(['message' => 'Broadcast sent']);
});

it('returns 503 when broadcast fails', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    mockRconOffline();

    $this->postJson('/api/server/broadcast', [
        'message' => 'test',
    ], apiHeaders())
        ->assertStatus(503);
});

it('validates broadcast message is required', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    $this->postJson('/api/server/broadcast', [], apiHeaders())
        ->assertUnprocessable()
        ->assertJsonValidationErrors('message');
});

// ── GET /api/server/logs ─────────────────────────────────────────────

it('returns server logs', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    mockDocker([], ['logs' => ['line 1', 'line 2', 'line 3']]);

    $response = $this->getJson('/api/server/logs', apiHeaders())
        ->assertOk()
        ->assertJsonStructure(['lines', 'count']);

    expect($response->json('count'))->toBe(3)
        ->and($response->json('lines'))->toBe(['line 1', 'line 2', 'line 3']);
});

it('validates logs tail parameter', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    $this->getJson('/api/server/logs?tail=0', apiHeaders())
        ->assertUnprocessable()
        ->assertJsonValidationErrors('tail');

    $this->getJson('/api/server/logs?tail=9999', apiHeaders())
        ->assertUnprocessable()
        ->assertJsonValidationErrors('tail');
});

it('requires auth for logs endpoint', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    $this->getJson('/api/server/logs')
        ->assertUnauthorized();
});

// ── Audit logging for all admin endpoints ────────────────────────────

it('creates audit entries for all admin server endpoints', function () {
    config(['zomboid.api_key' => 'test-key-12345']);

    mockRcon();
    mockDocker(['running' => false, 'status' => 'exited']);

    // start
    $this->postJson('/api/server/start', [], apiHeaders())->assertOk();
    // save (will fail with 503 since rcon mock won't throw for this test setup)
    mockRcon(['save' => '']);
    $this->postJson('/api/server/save', [], apiHeaders())->assertOk();
    // broadcast
    $this->postJson('/api/server/broadcast', ['message' => 'test'], apiHeaders())->assertOk();

    expect(AuditLog::count())->toBeGreaterThanOrEqual(3);
});
