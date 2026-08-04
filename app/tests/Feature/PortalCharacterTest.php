<?php

use App\Models\PlayerStat;
use App\Models\User;
use App\Models\WhitelistEntry;
use App\Services\OnlinePlayersReader;
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
