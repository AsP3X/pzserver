<?php

use App\Models\GameEvent;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->withoutVite();
});

function deathEvent(array $details, string $player = 'TestPlayer', ?string $at = null): GameEvent
{
    return GameEvent::query()->create([
        'event_type' => 'death',
        'player' => $player,
        'target' => $details['killer'] ?? null,
        'x' => 100,
        'y' => 200,
        'details' => $details,
        'game_time' => $at ? now()->parse($at) : now(),
    ]);
}

it('is public', function () {
    $this->get('/obituary')->assertOk();
});

it('lists recent deaths with their cause', function () {
    deathEvent(['cause' => 'infection', 'hours_survived' => 12.5, 'zombie_kills' => 40]);

    $this->get('/obituary')
        ->assertInertia(fn ($page) => $page
            ->component('obituary')
            ->has('deaths', 1)
            ->where('deaths.0.player', 'TestPlayer')
            ->where('deaths.0.cause', 'infection')
            ->where('deaths.0.hours_survived', 12.5)
        );
});

it('falls back to an unknown cause for a log-only death', function () {
    deathEvent(['raw' => '"TestPlayer" died']);

    $this->get('/obituary')
        ->assertInertia(fn ($page) => $page->where('deaths.0.cause', 'unknown'));
});

it('counts the toll by cause', function () {
    deathEvent(['cause' => 'infection']);
    deathEvent(['cause' => 'infection'], 'Other');
    deathEvent(['cause' => 'player', 'killer' => 'Raider'], 'Third');

    $this->get('/obituary')
        ->assertInertia(fn ($page) => $page
            ->where('toll.total', 3)
            ->where('toll.last_seven_days', 3)
            ->where('toll.by_cause.infection', 2)
            ->where('toll.by_cause.player', 1)
        );
});

it('ignores events that are not deaths', function () {
    GameEvent::query()->create([
        'event_type' => 'connect',
        'player' => 'TestPlayer',
        'game_time' => now(),
    ]);

    $this->get('/obituary')
        ->assertInertia(fn ($page) => $page->has('deaths', 0)->where('toll.total', 0));
});

it('shows the newest death first', function () {
    deathEvent(['cause' => 'fire'], 'Older', now()->subDay()->toDateTimeString());
    deathEvent(['cause' => 'player'], 'Newer');

    $this->get('/obituary')
        ->assertInertia(fn ($page) => $page->where('deaths.0.player', 'Newer'));
});
