<?php

use App\Http\Middleware\HandleInertiaRequests;
use App\Models\PlayerStat;
use App\Models\User;
use App\Models\WhitelistEntry;
use App\Services\OnlinePlayersReader;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->withoutVite();

    $reader = Mockery::mock(OnlinePlayersReader::class);
    $reader->shouldReceive('getOnlineUsernames')->andReturn([])->byDefault();
    app()->instance(OnlinePlayersReader::class, $reader);
});

function characterPlayer(string $username = 'TestPlayer'): User
{
    $user = User::factory()->create(['username' => $username]);

    WhitelistEntry::factory()->create([
        'user_id' => $user->id,
        'pz_username' => $username,
        'active' => true,
    ]);

    return $user;
}

function characterStats(string $username = 'TestPlayer', array $overrides = []): PlayerStat
{
    return PlayerStat::query()->create([
        'username' => $username,
        'zombie_kills' => 42,
        'hours_survived' => 12.5,
        'profession' => 'Lumberjack',
        'skills' => ['Axe' => 4, 'Carpentry' => 2],
        'traits' => [['id' => 'Thickskinned', 'label' => 'Thick Skinned']],
        'vitals' => ['health' => 88.5, 'bleeding_parts' => 1, 'infected' => false, 'has_cold' => true],
        'is_dead' => false,
        ...$overrides,
    ]);
}

it('redirects guests to login', function () {
    $this->get('/portal/character')->assertRedirect('/login');
});

it('renders the signed-in player their own character sheet', function () {
    characterStats();

    $this->actingAs(characterPlayer())->get('/portal/character')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->component('portal/character')
            ->where('username', 'TestPlayer')
            ->where('hasPzAccount', true)
            ->where('character.zombie_kills', 42)
            ->where('character.profession', 'Lumberjack')
            ->where('character.traits.0.label', 'Thick Skinned')
            ->where('character.vitals.health', 88.5)
            ->where('character.vitals.has_cold', true)
            ->has('character.skills', 2)
        );
});

it('resolves the character from the session, not the query string', function () {
    characterStats('TestPlayer');
    characterStats('OtherPlayer', ['zombie_kills' => 9999]);
    characterPlayer('OtherPlayer');

    $this->actingAs(characterPlayer())->get('/portal/character?username=OtherPlayer')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->where('username', 'TestPlayer')
            ->where('character.zombie_kills', 42)
        );
});

it('reports null traits and vitals when the mod is too old to export them', function () {
    characterStats('TestPlayer', ['traits' => null, 'vitals' => null]);

    $this->actingAs(characterPlayer())->get('/portal/character')
        ->assertInertia(fn ($page) => $page
            ->where('character.traits', null)
            ->where('character.vitals', null)
        );
});

it('distinguishes a character with no traits from one the mod cannot report', function () {
    characterStats('TestPlayer', ['traits' => []]);

    $this->actingAs(characterPlayer())->get('/portal/character')
        ->assertInertia(fn ($page) => $page->has('character.traits', 0));
});

it('tells an unlinked account it has no character', function () {
    $user = User::factory()->create(['username' => 'Stranger']);

    $this->actingAs($user)->get('/portal/character')
        ->assertInertia(fn ($page) => $page
            ->where('hasPzAccount', false)
            ->where('character', null)
        );
});

it('renders a linked player with no stats row yet', function () {
    $this->actingAs(characterPlayer())->get('/portal/character')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->where('hasPzAccount', true)
            ->where('character', null)
        );
});

it('marks the player online when the roster lists them', function () {
    $reader = Mockery::mock(OnlinePlayersReader::class);
    $reader->shouldReceive('getOnlineUsernames')->andReturn(['TestPlayer']);
    app()->instance(OnlinePlayersReader::class, $reader);

    characterStats();

    $this->actingAs(characterPlayer())->get('/portal/character')
        ->assertInertia(fn ($page) => $page->where('isOnline', true));
});

// ── Live refresh ────────────────────────────────────────────────────

/**
 * Point the stats service at a bridge export naming one player, with an
 * explicit mtime so the page's freshness prop is predictable.
 */
function characterExport(string $username, int $kills, int $mtime): string
{
    $path = sys_get_temp_dir().'/portal_character_stats_'.uniqid().'.json';

    file_put_contents($path, json_encode([
        'timestamp' => '2026-08-08T14:30:00',
        'player_count' => 1,
        'players' => [
            ['username' => $username, 'zombie_kills' => $kills, 'hours_survived' => 3.0, 'skills' => [], 'is_dead' => false],
        ],
    ]));

    touch($path, $mtime);
    clearstatcache(true, $path);

    config(['zomboid.lua_bridge.player_stats' => $path]);

    return $path;
}

it('imports a newer export on page load rather than waiting for the scheduler', function () {
    characterStats('TestPlayer', ['zombie_kills' => 42]);
    $path = characterExport('TestPlayer', 137, 1_760_000_000);

    $this->actingAs(characterPlayer())->get('/portal/character')
        ->assertOk()
        ->assertInertia(fn ($page) => $page->where('character.zombie_kills', 137));

    unlink($path);
});

it('reports when the mod last handed over player data', function () {
    characterStats();
    $path = characterExport('TestPlayer', 42, 1_760_000_000);

    $this->actingAs(characterPlayer())->get('/portal/character')
        ->assertInertia(fn ($page) => $page->where(
            'snapshotAt',
            CarbonImmutable::createFromTimestamp(1_760_000_000)->toIso8601String(),
        ));

    unlink($path);
});

it('reports a null snapshot time when the mod has never exported', function () {
    characterStats();
    config(['zomboid.lua_bridge.player_stats' => sys_get_temp_dir().'/definitely-not-here.json']);

    $this->actingAs(characterPlayer())->get('/portal/character')
        ->assertInertia(fn ($page) => $page->where('snapshotAt', null));
});

/**
 * A bridge volume that has only ever been scaffolded looks exactly like this.
 * It must not read as a mod that just reported in.
 */
it('does not treat an empty bridge placeholder as a fresh export', function () {
    characterStats();

    $path = sys_get_temp_dir().'/portal_character_stub_'.uniqid().'.json';
    file_put_contents($path, '');
    config(['zomboid.lua_bridge.player_stats' => $path]);

    $this->actingAs(characterPlayer())->get('/portal/character')
        ->assertOk()
        ->assertInertia(fn ($page) => $page->where('snapshotAt', null));

    unlink($path);
});

it('serves the props the page polls for on a partial reload', function () {
    characterStats();
    $path = characterExport('TestPlayer', 42, 1_760_000_000);

    $this->actingAs(characterPlayer())
        ->get('/portal/character', [
            'X-Inertia' => 'true',
            'X-Inertia-Version' => app(HandleInertiaRequests::class)->version(request()) ?? '',
            'X-Inertia-Partial-Component' => 'portal/character',
            'X-Inertia-Partial-Data' => 'character,isOnline,snapshotAt',
        ])
        ->assertOk()
        ->assertHeader('X-Inertia', 'true')
        ->assertJsonPath('component', 'portal/character')
        ->assertJsonPath('props.character.username', 'TestPlayer')
        ->assertJsonPath('props.isOnline', false)
        ->assertJsonPath(
            'props.snapshotAt',
            CarbonImmutable::createFromTimestamp(1_760_000_000)->toIso8601String(),
        )
        /** Anything the poll did not ask for stays off the wire. */
        ->assertJsonMissingPath('props.day_length_minutes');

    unlink($path);
});
