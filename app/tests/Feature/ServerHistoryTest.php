<?php

use App\Models\ServerStatusSample;
use App\Services\ServerHistoryService;
use App\Services\ServerStatusResolver;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->withoutVite();
    $this->history = new ServerHistoryService;
});

function mockStatusResolver(bool $online, int $players = 0): void
{
    $resolver = Mockery::mock(ServerStatusResolver::class);
    $resolver->shouldReceive('resolve')->andReturn([
        'container_status' => $online ? 'running' : 'stopped',
        'game_status' => $online ? 'online' : 'offline',
        'online' => $online,
        'player_count' => $players,
        'players' => [],
        'uptime' => null,
        'map' => null,
        'max_players' => null,
        'game_version' => null,
        'steam_branch' => null,
        'data_source' => 'test',
    ]);

    app()->instance(ServerStatusResolver::class, $resolver);
}

it('records one sample per run', function () {
    mockStatusResolver(online: true, players: 7);

    $this->artisan('zomboid:sample-status')->assertSuccessful();

    $sample = ServerStatusSample::query()->sole();

    expect($sample->online)->toBeTrue()
        ->and($sample->player_count)->toBe(7)
        ->and($sample->game_status)->toBe('online');
});

it('records an offline server as a sample rather than skipping it', function () {
    mockStatusResolver(online: false);

    $this->artisan('zomboid:sample-status')->assertSuccessful();

    expect(ServerStatusSample::query()->sole()->online)->toBeFalse();
});

it('reports uptime as the share of samples that found the server up', function () {
    ServerStatusSample::factory()->count(3)->create(['sampled_at' => now()->subHours(2)]);
    ServerStatusSample::factory()->offline()->create(['sampled_at' => now()->subHours(2)]);

    expect($this->history->uptimeSince(now()->subDay()))->toBe(75.0);
});

it('returns null uptime when nothing was sampled in the window', function () {
    expect($this->history->uptimeSince(now()->subDay()))->toBeNull();
});

it('ignores samples outside the window', function () {
    ServerStatusSample::factory()->create(['sampled_at' => now()->subHour()]);
    ServerStatusSample::factory()->offline()->create(['sampled_at' => now()->subWeek()]);

    expect($this->history->uptimeSince(now()->subDay()))->toBe(100.0);
});

it('reports peak and average population', function () {
    ServerStatusSample::factory()->create(['player_count' => 4, 'sampled_at' => now()->subHour()]);
    ServerStatusSample::factory()->create(['player_count' => 12, 'sampled_at' => now()->subHour()]);
    /** Offline samples must not drag the average down; nobody can be online. */
    ServerStatusSample::factory()->offline()->create(['sampled_at' => now()->subHour()]);

    expect($this->history->peakPlayersSince(now()->subDay()))->toBe(12)
        ->and($this->history->averagePlayersSince(now()->subDay()))->toBe(8.0);
});

it('returns population points in chronological order', function () {
    ServerStatusSample::factory()->create(['player_count' => 2, 'sampled_at' => now()->subHours(3)]);
    ServerStatusSample::factory()->create(['player_count' => 9, 'sampled_at' => now()->subHour()]);

    $population = $this->history->population(now()->subDay());

    expect($population)->toHaveCount(2)
        ->and($population[0]['players'])->toBe(2)
        ->and($population[1]['players'])->toBe(9);
});

it('prunes samples past retention', function () {
    ServerStatusSample::factory()->create(['sampled_at' => now()->subDays(91)]);
    ServerStatusSample::factory()->create(['sampled_at' => now()->subDay()]);

    expect($this->history->prune())->toBe(1)
        ->and(ServerStatusSample::query()->count())->toBe(1);
});

it('exposes the history to the public status page', function () {
    ServerStatusSample::factory()->count(2)->create(['sampled_at' => now()->subHour()]);

    $this->get('/status')
        ->assertOk()
        ->assertInertia(fn ($page) => $page->component('status'));
});
