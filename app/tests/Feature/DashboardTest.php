<?php

use App\Models\AuditLog;
use App\Models\Backup;
use App\Models\User;
use App\Services\GameStateReader;
use App\Services\ServerStatusResolver;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

function mockDashboardResolver(array $overrides = []): void
{
    $resolver = Mockery::mock(ServerStatusResolver::class);

    $defaults = [
        'container_status' => 'running',
        'game_status' => 'online',
        'online' => true,
        'player_count' => 0,
        'players' => [],
        'uptime' => '2 hours',
        'map' => 'Muldraugh, KY',
        'max_players' => 32,
        'game_version' => null,
        'steam_branch' => 'public',
        'data_source' => 'rcon',
    ];

    $resolver->shouldReceive('resolve')
        ->andReturn(array_merge($defaults, $overrides))
        ->byDefault();

    app()->instance(ServerStatusResolver::class, $resolver);
}

it('redirects guests to login', function () {
    $response = $this->get(route('dashboard'));
    $response->assertRedirect(route('login'));
});

it('renders the dashboard for authenticated users', function () {
    mockDashboardResolver();

    $user = User::factory()->admin()->create();

    $response = $this->actingAs($user)->get(route('dashboard'));

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('dashboard')
        ->has('server')
        ->has('game_state')
    );
});

it('shows server status on the dashboard', function () {
    mockDashboardResolver([
        'player_count' => 3,
        'players' => ['Alice', 'Bob', 'Charlie'],
    ]);

    $user = User::factory()->admin()->create();

    $response = $this->actingAs($user)->get(route('dashboard'));

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('dashboard')
        ->where('server.online', true)
        ->where('server.player_count', 3)
        ->has('server.players', 3)
        ->where('server.players.0.username', 'Alice')
        ->where('server.players.1.username', 'Bob')
        ->where('server.players.2.username', 'Charlie')
    );
});

it('includes container_status in dashboard server data', function () {
    mockDashboardResolver([
        'container_status' => 'running',
        'game_status' => 'starting',
        'online' => false,
        'data_source' => 'none',
    ]);

    $user = User::factory()->admin()->create();

    $response = $this->actingAs($user)->get(route('dashboard'));

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('dashboard')
        ->where('server.container_status', 'running')
        ->where('server.status', 'starting')
        ->where('server.online', false)
    );
});

it('loads dashboard with audit log data present', function () {
    mockDashboardResolver(['online' => false, 'game_status' => 'offline', 'container_status' => 'exited']);

    AuditLog::create([
        'actor' => 'api-key',
        'action' => 'server.restart',
        'target' => 'game-server',
        'created_at' => now(),
    ]);

    $user = User::factory()->admin()->create();

    $response = $this->actingAs($user)->get(route('dashboard'));

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('dashboard')
        ->where('server.online', false)
    );

    // Verify audit log exists in DB (deferred prop loads async)
    expect(AuditLog::count())->toBe(1);
});

it('loads dashboard with backup data present', function () {
    mockDashboardResolver(['online' => false, 'game_status' => 'offline', 'container_status' => 'exited']);

    Backup::create([
        'filename' => 'backup-2026-02-26-001.tar.gz',
        'path' => '/backups/backup-2026-02-26-001.tar.gz',
        'size_bytes' => 1048576,
        'type' => 'manual',
        'created_at' => now(),
    ]);

    $user = User::factory()->admin()->create();

    $response = $this->actingAs($user)->get(route('dashboard'));

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('dashboard')
        ->where('server.online', false)
    );

    // Verify backup exists in DB (deferred prop loads async)
    expect(Backup::count())->toBe(1);
});

it('handles offline server gracefully on dashboard', function () {
    mockDashboardResolver([
        'container_status' => 'exited',
        'game_status' => 'offline',
        'online' => false,
        'uptime' => null,
        'map' => null,
        'max_players' => null,
        'data_source' => 'none',
    ]);

    $user = User::factory()->admin()->create();

    $response = $this->actingAs($user)->get(route('dashboard'));

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('dashboard')
        ->where('server.online', false)
        ->where('server.status', 'offline')
        ->where('game_state', null)
    );
});

it('shows server as starting when health check is not yet healthy', function () {
    mockDashboardResolver([
        'container_status' => 'running',
        'game_status' => 'starting',
        'online' => false,
        'data_source' => 'none',
    ]);

    $user = User::factory()->admin()->create();

    $response = $this->actingAs($user)->get(route('dashboard'));

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('dashboard')
        ->where('server.online', false)
        ->where('server.status', 'starting')
        ->has('server.uptime')
    );
});

it('includes game state when server is online and data exists', function () {
    mockDashboardResolver();

    $gameState = [
        'time' => [
            'year' => 1993,
            'month' => 7,
            'day' => 9,
            'hour' => 14,
            'minute' => 30,
            'day_of_year' => 190,
            'is_night' => false,
            'formatted' => '14:30',
            'date' => '1993-07-09',
        ],
        'season' => 'summer',
        'weather' => [
            'temperature' => 28.5,
            'condition' => 'clear',
            'rain_intensity' => 0.0,
            'fog_intensity' => 0.0,
            'wind_intensity' => 0.15,
            'snow_intensity' => 0.0,
            'is_raining' => false,
            'is_foggy' => false,
            'is_snowing' => false,
        ],
        'exported_at' => '2026-02-27T14:30:00Z',
    ];

    $reader = Mockery::mock(GameStateReader::class);
    $reader->shouldReceive('getGameState')->andReturn($gameState);
    app()->instance(GameStateReader::class, $reader);

    $user = User::factory()->admin()->create();

    $response = $this->actingAs($user)->get(route('dashboard'));

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('dashboard')
        ->has('game_state')
        ->where('game_state.season', 'summer')
        ->where('game_state.time.hour', 14)
        ->where('game_state.weather.temperature', 28.5)
    );
});

it('returns null game state when server is online but file missing', function () {
    mockDashboardResolver();

    $reader = Mockery::mock(GameStateReader::class);
    $reader->shouldReceive('getGameState')->andReturn(null);
    app()->instance(GameStateReader::class, $reader);

    $user = User::factory()->admin()->create();

    $response = $this->actingAs($user)->get(route('dashboard'));

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('dashboard')
        ->where('game_state', null)
    );
});
