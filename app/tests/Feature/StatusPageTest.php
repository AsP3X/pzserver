<?php

use App\Services\ModManager;
use App\Services\ServerStatusResolver;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

function mockStatusResolver(array $overrides = []): void
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
        'data_source' => 'rcon',
    ];

    $resolver->shouldReceive('resolve')
        ->andReturn(array_merge($defaults, $overrides))
        ->byDefault();

    app()->instance(ServerStatusResolver::class, $resolver);
}

function mockModManager(array $mods = []): void
{
    $modManager = Mockery::mock(ModManager::class);
    $modManager->shouldReceive('list')->andReturn($mods)->byDefault();

    app()->instance(ModManager::class, $modManager);
}

it('renders the status page without auth', function () {
    mockStatusResolver();
    mockModManager();

    $response = $this->get('/status');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('status')
        ->has('server')
        ->has('mods')
        ->has('server_name')
    );
});

it('shows server as online with player data', function () {
    mockStatusResolver([
        'player_count' => 2,
        'players' => ['PlayerOne', 'PlayerTwo'],
    ]);
    mockModManager([
        ['workshop_id' => '123', 'mod_id' => 'TestMod', 'position' => 0],
    ]);

    $response = $this->get('/status');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('status')
        ->where('server.online', true)
        ->where('server.player_count', 2)
        ->where('server.players', ['PlayerOne', 'PlayerTwo'])
        ->has('mods', 1)
    );
});

it('shows server as offline when container is not running', function () {
    mockStatusResolver([
        'container_status' => 'exited',
        'game_status' => 'offline',
        'online' => false,
        'uptime' => null,
        'map' => null,
        'max_players' => null,
        'data_source' => 'none',
    ]);
    mockModManager();

    $response = $this->get('/status');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('status')
        ->where('server.online', false)
        ->where('server.status', 'offline')
        ->where('server.player_count', 0)
        ->where('server.players', [])
    );
});

it('shows server as starting when container running but game not ready', function () {
    mockStatusResolver([
        'container_status' => 'running',
        'game_status' => 'starting',
        'online' => false,
        'data_source' => 'none',
    ]);
    mockModManager();

    $response = $this->get('/status');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('status')
        ->where('server.online', false)
        ->where('server.status', 'starting')
        ->has('server.uptime')
    );
});

it('shows server as online when RCON responds even without healthy health check', function () {
    mockStatusResolver([
        'container_status' => 'running',
        'game_status' => 'online',
        'online' => true,
        'data_source' => 'rcon',
    ]);
    mockModManager();

    $response = $this->get('/status');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('status')
        ->where('server.online', true)
        ->where('server.status', 'online')
    );
});
