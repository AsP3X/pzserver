<?php

use App\Models\GameEvent;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

test('import-pvp-kills creates game events from JSON file', function () {
    $path = tempnam(sys_get_temp_dir(), 'pvp_kills_');

    $kills = [
        [
            'killer' => 'Alice',
            'victim' => 'Bob',
            'weapon' => 'Base.Axe',
            'killer_x' => 10883,
            'killer_y' => 10085,
            'victim_x' => 10884,
            'victim_y' => 10086,
            'occurred_at' => 1678901234,
        ],
        [
            'killer' => 'Charlie',
            'victim' => 'Dave',
            'weapon' => 'Base.Shotgun',
            'killer_x' => 11000,
            'killer_y' => 11000,
            'victim_x' => 11001,
            'victim_y' => 11001,
            'occurred_at' => 1678901300,
        ],
    ];

    file_put_contents($path, json_encode(['kills' => $kills]));

    config(['zomboid.lua_bridge.pvp_kills' => $path]);

    $this->artisan('zomboid:import-pvp-kills')
        ->assertSuccessful();

    expect(GameEvent::query()->where('event_type', 'pvp_kill')->count())->toBe(2);

    $first = GameEvent::query()->where('event_type', 'pvp_kill')->where('player', 'Alice')->first();
    expect($first->target)->toBe('Bob')
        ->and($first->x)->toBe(10883)
        ->and($first->y)->toBe(10085)
        ->and($first->details['weapon'])->toBe('Base.Axe')
        ->and($first->details['victim_x'])->toBe(10884)
        ->and($first->details['victim_y'])->toBe(10086);

    // File should be cleared after import
    $remaining = json_decode(file_get_contents($path), true);
    expect($remaining['kills'])->toBeEmpty();

    unlink($path);
});

test('import-pvp-kills handles empty file gracefully', function () {
    $path = tempnam(sys_get_temp_dir(), 'pvp_kills_');
    file_put_contents($path, json_encode(['kills' => []]));

    config(['zomboid.lua_bridge.pvp_kills' => $path]);

    $this->artisan('zomboid:import-pvp-kills')
        ->assertSuccessful();

    expect(GameEvent::query()->where('event_type', 'pvp_kill')->count())->toBe(0);

    unlink($path);
});

test('import-pvp-kills handles missing file gracefully', function () {
    config(['zomboid.lua_bridge.pvp_kills' => '/tmp/nonexistent_pvp_kills_test.json']);

    $this->artisan('zomboid:import-pvp-kills')
        ->assertSuccessful();

    expect(GameEvent::query()->where('event_type', 'pvp_kill')->count())->toBe(0);
});
