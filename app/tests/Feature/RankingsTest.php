<?php

use App\Models\GameEvent;
use App\Models\PlayerStat;
use App\Models\User;
use App\Models\Wallet;
use App\Services\PlayerStatsService;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

// --- PlayerStatsService extended tests ---

test('getServerStats returns correct aggregations', function () {
    PlayerStat::query()->create(['username' => 'Alice', 'zombie_kills' => 50, 'hours_survived' => 10.0, 'profession' => 'Lumberjack']);
    PlayerStat::query()->create(['username' => 'Bob', 'zombie_kills' => 100, 'hours_survived' => 20.5, 'profession' => 'FireOfficer']);
    PlayerStat::query()->create(['username' => 'Charlie', 'zombie_kills' => 75, 'hours_survived' => 15.0, 'profession' => 'Lumberjack']);

    GameEvent::query()->create(['event_type' => 'death', 'player' => 'Alice']);
    GameEvent::query()->create(['event_type' => 'death', 'player' => 'Bob']);
    GameEvent::query()->create(['event_type' => 'death', 'player' => 'Alice']);
    GameEvent::query()->create(['event_type' => 'pvp_kill', 'player' => 'Bob', 'target' => 'Alice']);
    GameEvent::query()->create(['event_type' => 'pvp_hit', 'player' => 'Bob', 'target' => 'Alice']); // hits don't count

    $service = new PlayerStatsService('/nonexistent');
    $stats = $service->getServerStats();

    expect($stats['total_players'])->toBe(3)
        ->and($stats['total_zombie_kills'])->toBe(225)
        ->and($stats['total_hours_survived'])->toBe(45.5)
        ->and($stats['total_deaths'])->toBe(3)
        ->and($stats['total_pvp_kills'])->toBe(1)
        ->and($stats['most_popular_profession'])->toBe('Lumberjack');
});

test('getFullLeaderboard orders and includes rank numbers', function () {
    PlayerStat::query()->create(['username' => 'Alice', 'zombie_kills' => 50, 'hours_survived' => 10]);
    PlayerStat::query()->create(['username' => 'Bob', 'zombie_kills' => 100, 'hours_survived' => 20]);
    PlayerStat::query()->create(['username' => 'Charlie', 'zombie_kills' => 75, 'hours_survived' => 15, 'is_dead' => true]);

    $service = new PlayerStatsService('/nonexistent');
    $leaderboard = $service->getFullLeaderboard('zombie_kills', 25);

    expect($leaderboard)->toHaveCount(3)
        ->and($leaderboard[0]['rank'])->toBe(1)
        ->and($leaderboard[0]['username'])->toBe('Bob')
        ->and($leaderboard[0]['zombie_kills'])->toBe(100)
        ->and($leaderboard[1]['rank'])->toBe(2)
        ->and($leaderboard[1]['username'])->toBe('Charlie')
        ->and($leaderboard[2]['rank'])->toBe(3)
        ->and($leaderboard[2]['username'])->toBe('Alice')
        ->and($leaderboard[0])->toHaveKeys(['rank', 'username', 'zombie_kills', 'hours_survived', 'profession', 'is_dead']);
});

test('getDeathLeaderboard counts correctly', function () {
    GameEvent::query()->create(['event_type' => 'death', 'player' => 'Alice']);
    GameEvent::query()->create(['event_type' => 'death', 'player' => 'Alice']);
    GameEvent::query()->create(['event_type' => 'death', 'player' => 'Alice']);
    GameEvent::query()->create(['event_type' => 'death', 'player' => 'Bob']);
    GameEvent::query()->create(['event_type' => 'pvp_hit', 'player' => 'Alice', 'target' => 'Bob']); // not a death

    $service = new PlayerStatsService('/nonexistent');
    $leaderboard = $service->getDeathLeaderboard(25);

    expect($leaderboard)->toHaveCount(2)
        ->and($leaderboard[0]['rank'])->toBe(1)
        ->and($leaderboard[0]['username'])->toBe('Alice')
        ->and($leaderboard[0]['death_count'])->toBe(3)
        ->and($leaderboard[1]['rank'])->toBe(2)
        ->and($leaderboard[1]['username'])->toBe('Bob')
        ->and($leaderboard[1]['death_count'])->toBe(1);
});

test('getRatioLeaderboard kills_per_death computes correctly', function () {
    PlayerStat::query()->create(['username' => 'Alice', 'zombie_kills' => 100, 'hours_survived' => 20]);
    PlayerStat::query()->create(['username' => 'Bob', 'zombie_kills' => 50, 'hours_survived' => 10]);
    PlayerStat::query()->create(['username' => 'Charlie', 'zombie_kills' => 200, 'hours_survived' => 30]);

    // Alice: 2 deaths → 50 k/d, Bob: 1 death → 50 k/d, Charlie: 0 deaths → excluded
    GameEvent::query()->create(['event_type' => 'death', 'player' => 'Alice']);
    GameEvent::query()->create(['event_type' => 'death', 'player' => 'Alice']);
    GameEvent::query()->create(['event_type' => 'death', 'player' => 'Bob']);

    $service = new PlayerStatsService('/nonexistent');
    $leaderboard = $service->getRatioLeaderboard('kills_per_death', 25);

    expect($leaderboard)->toHaveCount(2)
        ->and($leaderboard[0]['username'])->toBe('Alice')
        ->and($leaderboard[0]['ratio'])->toBe(50.0)
        ->and($leaderboard[0]['numerator'])->toBe(100)
        ->and($leaderboard[0]['death_count'])->toBe(2)
        ->and($leaderboard[1]['username'])->toBe('Bob')
        ->and($leaderboard[1]['ratio'])->toBe(50.0)
        ->and($leaderboard[1]['numerator'])->toBe(50)
        ->and($leaderboard[1]['death_count'])->toBe(1);
});

test('getRatioLeaderboard excludes players with 0 deaths', function () {
    PlayerStat::query()->create(['username' => 'Alice', 'zombie_kills' => 100, 'hours_survived' => 20]);
    // No deaths for Alice

    $service = new PlayerStatsService('/nonexistent');
    $leaderboard = $service->getRatioLeaderboard('kills_per_death', 25);

    expect($leaderboard)->toHaveCount(0);
});

test('getRatioLeaderboard pvp_per_death computes correctly', function () {
    PlayerStat::query()->create(['username' => 'Alice', 'zombie_kills' => 0, 'hours_survived' => 5]);
    PlayerStat::query()->create(['username' => 'Bob', 'zombie_kills' => 0, 'hours_survived' => 5]);

    // Alice: 3 pvp kills, 1 death → ratio 3.0
    GameEvent::query()->create(['event_type' => 'pvp_kill', 'player' => 'Alice', 'target' => 'Bob']);
    GameEvent::query()->create(['event_type' => 'pvp_kill', 'player' => 'Alice', 'target' => 'Bob']);
    GameEvent::query()->create(['event_type' => 'pvp_kill', 'player' => 'Alice', 'target' => 'Bob']);
    GameEvent::query()->create(['event_type' => 'death', 'player' => 'Alice']);

    // Bob: 1 pvp kill, 2 deaths → ratio 0.5
    GameEvent::query()->create(['event_type' => 'pvp_kill', 'player' => 'Bob', 'target' => 'Alice']);
    GameEvent::query()->create(['event_type' => 'death', 'player' => 'Bob']);
    GameEvent::query()->create(['event_type' => 'death', 'player' => 'Bob']);

    $service = new PlayerStatsService('/nonexistent');
    $leaderboard = $service->getRatioLeaderboard('pvp_per_death', 25);

    expect($leaderboard)->toHaveCount(2)
        ->and($leaderboard[0]['username'])->toBe('Alice')
        ->and($leaderboard[0]['ratio'])->toBe(3.0)
        ->and($leaderboard[0]['numerator'])->toBe(3)
        ->and($leaderboard[0]['death_count'])->toBe(1)
        ->and($leaderboard[1]['username'])->toBe('Bob')
        ->and($leaderboard[1]['ratio'])->toBe(0.5)
        ->and($leaderboard[1]['numerator'])->toBe(1)
        ->and($leaderboard[1]['death_count'])->toBe(2);
});

test('getPlayerProfile returns null for non-existent user', function () {
    $service = new PlayerStatsService('/nonexistent');

    expect($service->getPlayerProfile('NonExistent'))->toBeNull();
});

test('getPlayerProfile returns correct data for existing player', function () {
    PlayerStat::query()->create([
        'username' => 'Alice',
        'zombie_kills' => 50,
        'hours_survived' => 10.0,
        'profession' => 'Lumberjack',
        'skills' => ['Axe' => 3, 'Carpentry' => 2],
        'is_dead' => false,
    ]);
    PlayerStat::query()->create(['username' => 'Bob', 'zombie_kills' => 100, 'hours_survived' => 20.0]);

    GameEvent::query()->create(['event_type' => 'death', 'player' => 'Alice']);
    GameEvent::query()->create(['event_type' => 'death', 'player' => 'Alice']);
    GameEvent::query()->create(['event_type' => 'craft', 'player' => 'Alice', 'details' => ['item' => 'Base.Axe']]);
    GameEvent::query()->create(['event_type' => 'connect', 'player' => 'Alice']);

    $service = new PlayerStatsService('/nonexistent');
    $profile = $service->getPlayerProfile('Alice');

    expect($profile)->not->toBeNull()
        ->and($profile['username'])->toBe('Alice')
        ->and($profile['zombie_kills'])->toBe(50)
        ->and($profile['profession'])->toBe('Lumberjack')
        ->and($profile['skills'])->toBe(['Axe' => 3, 'Carpentry' => 2])
        ->and($profile['is_dead'])->toBeFalse()
        ->and($profile['ranks']['kills'])->toBe(2) // Bob has more kills
        ->and($profile['ranks']['survival'])->toBe(2) // Bob has more hours
        ->and($profile['event_counts']['death'])->toBe(2)
        ->and($profile['event_counts']['craft'])->toBe(1)
        ->and($profile['event_counts']['connect'])->toBe(1)
        ->and($profile['event_counts']['pvp_hit'])->toBe(0)
        ->and($profile['recent_events'])->toHaveCount(4);
});

// --- Controller feature tests ---

it('rankings page is publicly accessible', function () {
    $response = $this->get('/rankings');
    $response->assertOk();
});

it('rankings page renders correct Inertia component', function () {
    PlayerStat::query()->create(['username' => 'Alice', 'zombie_kills' => 50, 'hours_survived' => 10]);

    $user = User::factory()->create();

    $response = $this->actingAs($user)->get('/rankings');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('rankings')
        ->has('server_stats')
        ->where('server_stats.total_players', 1)
    );
});

it('rankings page is accessible by regular players', function () {
    $user = User::factory()->create(); // non-admin

    $response = $this->actingAs($user)->get('/rankings');

    $response->assertOk();
});

it('player profile returns 404 for unknown username', function () {
    $user = User::factory()->create();

    $response = $this->actingAs($user)->get('/rankings/NonExistentPlayer');

    $response->assertNotFound();
});

it('player profile renders correct data for existing player', function () {
    PlayerStat::query()->create([
        'username' => 'TestPlayer',
        'zombie_kills' => 42,
        'hours_survived' => 8.5,
        'profession' => 'Doctor',
    ]);

    $user = User::factory()->create();

    $response = $this->actingAs($user)->get('/rankings/TestPlayer');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('player-profile')
        ->has('player')
        ->where('player.username', 'TestPlayer')
        ->where('player.zombie_kills', 42)
        ->where('player.profession', 'Doctor')
    );
});

it('player profile hides recent events from regular players', function () {
    PlayerStat::query()->create(['username' => 'TestPlayer', 'zombie_kills' => 10, 'hours_survived' => 5]);
    GameEvent::query()->create(['event_type' => 'connect', 'player' => 'TestPlayer']);

    $user = User::factory()->create(['role' => \App\Enums\UserRole::Player]);

    $response = $this->actingAs($user)->get('/rankings/TestPlayer');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('player-profile')
        ->where('is_admin', false)
        ->missing('recent_events')
    );
});

it('player profile shows recent events to admin users', function () {
    PlayerStat::query()->create(['username' => 'TestPlayer', 'zombie_kills' => 10, 'hours_survived' => 5]);
    GameEvent::query()->create(['event_type' => 'connect', 'player' => 'TestPlayer']);

    $admin = User::factory()->create(['role' => \App\Enums\UserRole::Admin]);

    $response = $this->actingAs($admin)->get('/rankings/TestPlayer');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('player-profile')
        ->where('is_admin', true)
    );
});

it('player profile is accessible by regular players', function () {
    PlayerStat::query()->create(['username' => 'TestPlayer', 'zombie_kills' => 10, 'hours_survived' => 5]);

    $user = User::factory()->create(); // non-admin

    $response = $this->actingAs($user)->get('/rankings/TestPlayer');

    $response->assertOk();
});

// --- Wallet Leaderboard tests ---

test('getWalletLeaderboard ranks by total_spent correctly', function () {
    $alice = User::factory()->create(['username' => 'Alice']);
    $bob = User::factory()->create(['username' => 'Bob']);
    $charlie = User::factory()->create(['username' => 'Charlie']);

    Wallet::query()->create(['user_id' => $alice->id, 'balance' => 10, 'total_earned' => 100, 'total_spent' => 90]);
    Wallet::query()->create(['user_id' => $bob->id, 'balance' => 50, 'total_earned' => 200, 'total_spent' => 150]);
    Wallet::query()->create(['user_id' => $charlie->id, 'balance' => 0, 'total_earned' => 0, 'total_spent' => 0]);

    $service = new PlayerStatsService('/nonexistent');
    $leaderboard = $service->getWalletLeaderboard('total_spent', 25);

    expect($leaderboard)->toHaveCount(2) // Charlie excluded (0 spent)
        ->and($leaderboard[0]['rank'])->toBe(1)
        ->and($leaderboard[0]['username'])->toBe('Bob')
        ->and($leaderboard[0]['total_spent'])->toBe(150.0)
        ->and($leaderboard[1]['rank'])->toBe(2)
        ->and($leaderboard[1]['username'])->toBe('Alice')
        ->and($leaderboard[1]['total_spent'])->toBe(90.0);
});

test('getWalletLeaderboard ranks by balance correctly', function () {
    $alice = User::factory()->create(['username' => 'Alice']);
    $bob = User::factory()->create(['username' => 'Bob']);

    Wallet::query()->create(['user_id' => $alice->id, 'balance' => 500, 'total_earned' => 500, 'total_spent' => 0]);
    Wallet::query()->create(['user_id' => $bob->id, 'balance' => 200, 'total_earned' => 300, 'total_spent' => 100]);

    $service = new PlayerStatsService('/nonexistent');
    $leaderboard = $service->getWalletLeaderboard('balance', 25);

    expect($leaderboard)->toHaveCount(2)
        ->and($leaderboard[0]['rank'])->toBe(1)
        ->and($leaderboard[0]['username'])->toBe('Alice')
        ->and($leaderboard[0]['balance'])->toBe(500.0)
        ->and($leaderboard[1]['rank'])->toBe(2)
        ->and($leaderboard[1]['username'])->toBe('Bob')
        ->and($leaderboard[1]['balance'])->toBe(200.0);
});
