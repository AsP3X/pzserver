<?php

use App\Models\GameEvent;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->bridgeDir = sys_get_temp_dir().'/pz_deaths_test_'.getmypid();
    if (! is_dir($this->bridgeDir)) {
        mkdir($this->bridgeDir, 0755, true);
    }

    $this->deathsPath = $this->bridgeDir.'/deaths.json';
    config(['zomboid.lua_bridge.deaths' => $this->deathsPath]);
});

afterEach(function () {
    @unlink($this->deathsPath);
    @rmdir($this->bridgeDir);
});

function writeDeaths(array $deaths): void
{
    file_put_contents(test()->deathsPath, json_encode(['deaths' => $deaths]));
}

function modDeath(array $overrides = []): array
{
    return [
        'username' => 'TestPlayer',
        'cause' => 'infection',
        'killer' => null,
        'weapon' => null,
        'x' => 10750,
        'y' => 9500,
        'z' => 0,
        'hours_survived' => 42.5,
        'zombie_kills' => 137,
        'occurred_at' => now()->timestamp,
        'world_time' => '1993-07-09 14:00',
        ...$overrides,
    ];
}

it('does nothing when the bridge file is absent', function () {
    $this->artisan('zomboid:import-deaths')->assertExitCode(0);

    expect(GameEvent::query()->count())->toBe(0);
});

it('imports a death with its cause and stats', function () {
    writeDeaths([modDeath()]);

    $this->artisan('zomboid:import-deaths')->assertExitCode(0);

    $event = GameEvent::query()->where('event_type', 'death')->sole();

    expect($event->player)->toBe('TestPlayer')
        ->and($event->x)->toBe(10750)
        ->and($event->details['cause'])->toBe('infection')
        ->and($event->details['hours_survived'])->toBe(42.5)
        ->and($event->details['zombie_kills'])->toBe(137)
        ->and($event->details['source'])->toBe('mod');
});

it('names the killer for a PvP death', function () {
    writeDeaths([modDeath(['cause' => 'player', 'killer' => 'Raider', 'weapon' => 'Base.Axe'])]);

    $this->artisan('zomboid:import-deaths');

    $event = GameEvent::query()->where('event_type', 'death')->sole();

    expect($event->target)->toBe('Raider')
        ->and($event->details['killer'])->toBe('Raider')
        ->and($event->details['weapon'])->toBe('Base.Axe');
});

it('enriches the death the server log already recorded instead of duplicating it', function () {
    GameEvent::query()->create([
        'event_type' => 'death',
        'player' => 'TestPlayer',
        'x' => null,
        'y' => null,
        'details' => ['raw' => '"TestPlayer" died'],
        'game_time' => now(),
    ]);

    writeDeaths([modDeath()]);

    $this->artisan('zomboid:import-deaths');

    $events = GameEvent::query()->where('event_type', 'death')->get();

    expect($events)->toHaveCount(1)
        ->and($events[0]->details['cause'])->toBe('infection')
        ->and($events[0]->details['raw'])->toBe('"TestPlayer" died')
        ->and($events[0]->x)->toBe(10750);
});

it('treats a death outside the match window as a separate death', function () {
    GameEvent::query()->create([
        'event_type' => 'death',
        'player' => 'TestPlayer',
        'details' => ['raw' => 'older death'],
        'game_time' => now()->subHour(),
    ]);

    writeDeaths([modDeath()]);

    $this->artisan('zomboid:import-deaths');

    expect(GameEvent::query()->where('event_type', 'death')->count())->toBe(2);
});

it('does not confuse two players who died at the same moment', function () {
    GameEvent::query()->create([
        'event_type' => 'death',
        'player' => 'SomeoneElse',
        'details' => ['raw' => 'other death'],
        'game_time' => now(),
    ]);

    writeDeaths([modDeath()]);

    $this->artisan('zomboid:import-deaths');

    expect(GameEvent::query()->where('event_type', 'death')->count())->toBe(2)
        ->and(GameEvent::query()->where('player', 'TestPlayer')->sole()->details['cause'])->toBe('infection');
});

it('empties the bridge file so deaths are imported once', function () {
    writeDeaths([modDeath()]);

    $this->artisan('zomboid:import-deaths');
    $this->artisan('zomboid:import-deaths');

    expect(GameEvent::query()->where('event_type', 'death')->count())->toBe(1)
        ->and(json_decode(file_get_contents($this->deathsPath), true)['deaths'])->toBe([]);
});

it('survives a corrupt bridge file', function () {
    file_put_contents($this->deathsPath, '{not json');

    $this->artisan('zomboid:import-deaths')->assertExitCode(0);

    expect(GameEvent::query()->count())->toBe(0);
});
