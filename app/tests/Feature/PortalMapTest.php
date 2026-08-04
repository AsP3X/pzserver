<?php

use App\Models\User;
use App\Models\WhitelistEntry;
use App\Services\OnlinePlayersReader;
use App\Services\PlayerPositionReader;
use App\Services\PlayersDbReader;
use App\Services\SafeZoneManager;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->withoutVite();
});

function mockMapPositions(?array $live, ?array $saved): void
{
    $positions = Mockery::mock(PlayerPositionReader::class);
    $positions->shouldReceive('getPlayerPosition')->andReturn($live)->byDefault();
    app()->instance(PlayerPositionReader::class, $positions);

    $db = Mockery::mock(PlayersDbReader::class);
    $db->shouldReceive('getPlayerPosition')->andReturn($saved)->byDefault();
    app()->instance(PlayersDbReader::class, $db);
}

function mockMapOnlinePlayers(array $usernames): void
{
    $reader = Mockery::mock(OnlinePlayersReader::class);
    $reader->shouldReceive('getOnlineUsernames')->andReturn($usernames)->byDefault();
    app()->instance(OnlinePlayersReader::class, $reader);
}

function mockMapSafeZones(array $config = ['enabled' => false, 'zones' => []]): void
{
    $manager = Mockery::mock(SafeZoneManager::class);
    $manager->shouldReceive('getConfig')->andReturn($config)->byDefault();
    app()->instance(SafeZoneManager::class, $manager);
}

function mapPlayer(string $username = 'TestPlayer'): User
{
    $user = User::factory()->create(['username' => $username]);

    WhitelistEntry::factory()->create([
        'user_id' => $user->id,
        'pz_username' => $username,
        'active' => true,
    ]);

    return $user;
}

it('redirects guests to login', function () {
    $this->get('/portal/map')->assertRedirect('/login');
});

it('shows the live position while the player is connected', function () {
    mockMapPositions(
        live: ['username' => 'TestPlayer', 'x' => 10750.5, 'y' => 9500.25, 'z' => 0, 'is_dead' => false],
        saved: ['username' => 'TestPlayer', 'name' => 'Bob', 'x' => 1.0, 'y' => 2.0, 'z' => 0, 'is_dead' => false],
    );
    mockMapOnlinePlayers(['TestPlayer']);
    mockMapSafeZones();

    $response = $this->actingAs(mapPlayer())->get('/portal/map');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('portal/map')
        ->where('username', 'TestPlayer')
        ->where('hasPzAccount', true)
        ->where('marker.x', 10750.5)
        ->where('marker.y', 9500.25)
        ->where('marker.status', 'online')
        ->where('marker.is_online', true)
        ->where('marker.source', 'live')
    );
});

it('falls back to the save position when the player is offline', function () {
    mockMapPositions(
        live: ['username' => 'TestPlayer', 'x' => 999.0, 'y' => 999.0, 'z' => 0, 'is_dead' => false],
        saved: ['username' => 'TestPlayer', 'name' => 'Bob', 'x' => 4200.0, 'y' => 8100.0, 'z' => 1, 'is_dead' => false],
    );
    mockMapOnlinePlayers([]);
    mockMapSafeZones();

    $response = $this->actingAs(mapPlayer())->get('/portal/map');

    $response->assertInertia(fn ($page) => $page
        ->where('marker.x', 4200.0)
        ->where('marker.z', 1)
        ->where('marker.status', 'offline')
        ->where('marker.source', 'save')
        ->where('marker.name', 'Bob')
    );
});

it('marks a dead character as dead', function () {
    mockMapPositions(
        live: null,
        saved: ['username' => 'TestPlayer', 'name' => 'Bob', 'x' => 1.0, 'y' => 2.0, 'z' => 0, 'is_dead' => true],
    );
    mockMapOnlinePlayers([]);
    mockMapSafeZones();

    $this->actingAs(mapPlayer())->get('/portal/map')
        ->assertInertia(fn ($page) => $page->where('marker.status', 'dead'));
});

it('resolves the character from the session, not the query string', function () {
    /** Strict `with()`: reading anyone else's position fails the test. */
    $positions = Mockery::mock(PlayerPositionReader::class);
    $positions->shouldReceive('getPlayerPosition')->with('TestPlayer')
        ->andReturn(['username' => 'TestPlayer', 'x' => 1.0, 'y' => 2.0, 'z' => 0, 'is_dead' => false]);
    app()->instance(PlayerPositionReader::class, $positions);

    $db = Mockery::mock(PlayersDbReader::class);
    $db->shouldReceive('getPlayerPosition')->with('TestPlayer')->andReturn(null);
    app()->instance(PlayersDbReader::class, $db);

    mockMapOnlinePlayers(['TestPlayer', 'OtherPlayer']);
    mockMapSafeZones();
    mapPlayer('OtherPlayer');

    $this->actingAs(mapPlayer())->get('/portal/map?username=OtherPlayer')
        ->assertOk()
        ->assertInertia(fn ($page) => $page->where('username', 'TestPlayer'));
});

it('tells an unlinked account it has no character', function () {
    mockMapPositions(null, null);
    mockMapOnlinePlayers([]);
    mockMapSafeZones();

    $user = User::factory()->create(['username' => 'Stranger']);

    $this->actingAs($user)->get('/portal/map')
        ->assertInertia(fn ($page) => $page
            ->where('hasPzAccount', false)
            ->where('marker', null)
        );
});

it('passes safe zones through only while they are enabled', function () {
    $zones = [['id' => 'z1', 'name' => 'Spawn', 'x1' => 0, 'y1' => 0, 'x2' => 10, 'y2' => 10]];

    mockMapPositions(['username' => 'TestPlayer', 'x' => 1.0, 'y' => 2.0, 'z' => 0, 'is_dead' => false], null);
    mockMapOnlinePlayers(['TestPlayer']);
    mockMapSafeZones(['enabled' => true, 'zones' => $zones]);

    $this->actingAs(mapPlayer())->get('/portal/map')
        ->assertInertia(fn ($page) => $page->has('safeZones', 1));

    mockMapSafeZones(['enabled' => false, 'zones' => $zones]);

    $this->actingAs(mapPlayer())->get('/portal/map')
        ->assertInertia(fn ($page) => $page->has('safeZones', 0));
});

it('serves basemap tiles to a player who is not an admin', function () {
    $this->actingAs(mapPlayer())->get('/map-tiles/0/1_2')
        ->assertOk()
        ->assertHeader('Content-Type', 'image/png');
});

it('does not serve basemap tiles to guests', function () {
    $this->get('/map-tiles/0/1_2')->assertRedirect('/login');
});
