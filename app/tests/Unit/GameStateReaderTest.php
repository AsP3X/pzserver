<?php

use App\Services\GameStateReader;

beforeEach(function () {
    $this->tempDir = sys_get_temp_dir().'/game_state_test_'.uniqid();
    mkdir($this->tempDir, 0755, true);
    $this->filePath = $this->tempDir.'/game_state.json';
});

afterEach(function () {
    if (file_exists($this->filePath)) {
        unlink($this->filePath);
    }
    if (is_dir($this->tempDir)) {
        rmdir($this->tempDir);
    }
});

test('returns null when file does not exist', function () {
    $reader = new GameStateReader($this->filePath);

    expect($reader->getGameState())->toBeNull();
});

test('parses valid game state JSON', function () {
    $data = [
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
            'rain_intensity' => 0.0,
            'fog_intensity' => 0.0,
            'wind_intensity' => 0.15,
            'snow_intensity' => 0.0,
            'is_raining' => false,
            'is_foggy' => false,
            'is_snowing' => false,
            'condition' => 'clear',
        ],
        'exported_at' => '2026-02-27T14:30:00Z',
    ];

    file_put_contents($this->filePath, json_encode($data));

    $reader = new GameStateReader($this->filePath);
    $result = $reader->getGameState();

    expect($result)->not->toBeNull()
        ->and($result['time']['hour'])->toBe(14)
        ->and($result['time']['formatted'])->toBe('14:30')
        ->and($result['season'])->toBe('summer')
        ->and($result['weather']['temperature'])->toBe(28.5)
        ->and($result['weather']['condition'])->toBe('clear');
});

test('exposes world_day so the dashboard can show days survived rather than the calendar day', function () {
    $data = [
        'time' => [
            'year' => 1993, 'month' => 7, 'day' => 9, 'hour' => 9, 'minute' => 0,
            'day_of_year' => 190, 'world_day' => 1, 'is_night' => false,
            'formatted' => '09:00', 'date' => '1993-07-09',
        ],
        'season' => 'summer',
        'exported_at' => '2026-02-27T09:00:00Z',
    ];

    file_put_contents($this->filePath, json_encode($data));

    $result = (new GameStateReader($this->filePath))->getGameState();

    // A freshly wiped world is day 1, even though the calendar still reads 190.
    expect($result['time']['world_day'])->toBe(1)
        ->and($result['time']['day_of_year'])->toBe(190);
});

test('reads state from a KnoxRelay older than 1.4 that exports no world_day', function () {
    $data = [
        'time' => [
            'year' => 1993, 'month' => 7, 'day' => 9, 'hour' => 14, 'minute' => 30,
            'day_of_year' => 190, 'is_night' => false,
            'formatted' => '14:30', 'date' => '1993-07-09',
        ],
        'season' => 'summer',
        'exported_at' => '2026-02-27T14:30:00Z',
    ];

    file_put_contents($this->filePath, json_encode($data));

    $result = (new GameStateReader($this->filePath))->getGameState();

    expect($result)->not->toBeNull()
        ->and($result['time'])->not->toHaveKey('world_day');
});

test('returns null for malformed JSON', function () {
    file_put_contents($this->filePath, 'not valid json {{{');

    $reader = new GameStateReader($this->filePath);

    expect($reader->getGameState())->toBeNull();
});

test('isStale returns true when file does not exist', function () {
    $reader = new GameStateReader($this->filePath);

    expect($reader->isStale())->toBeTrue();
});

test('isStale returns false for recent data', function () {
    $data = [
        'time' => ['year' => 1993, 'month' => 7, 'day' => 9, 'hour' => 14, 'minute' => 30, 'day_of_year' => 190, 'is_night' => false, 'formatted' => '14:30', 'date' => '1993-07-09'],
        'season' => 'summer',
        'weather' => null,
        'exported_at' => gmdate('Y-m-d\TH:i:s\Z'),
    ];

    file_put_contents($this->filePath, json_encode($data));

    $reader = new GameStateReader($this->filePath);

    expect($reader->isStale())->toBeFalse();
});

test('isStale returns true for old data', function () {
    $data = [
        'time' => ['year' => 1993, 'month' => 7, 'day' => 9, 'hour' => 14, 'minute' => 30, 'day_of_year' => 190, 'is_night' => false, 'formatted' => '14:30', 'date' => '1993-07-09'],
        'season' => 'summer',
        'weather' => null,
        'exported_at' => gmdate('Y-m-d\TH:i:s\Z', time() - 300),
    ];

    file_put_contents($this->filePath, json_encode($data));

    $reader = new GameStateReader($this->filePath);

    expect($reader->isStale(120))->toBeTrue();
});

it('passes world events through to the dashboard', function () {
    file_put_contents($this->filePath, json_encode([
        'time' => ['year' => 1993, 'month' => 7, 'day' => 9, 'hour' => 12, 'minute' => 0,
            'day_of_year' => 190, 'is_night' => false, 'formatted' => '12:00', 'date' => '1993-07-09'],
        'season' => 'summer',
        'events' => [
            'day' => 12.5,
            'electricity' => ['status' => 'on', 'days_remaining' => 17.5, 'shutoff_day' => 30],
            'water' => ['status' => 'off', 'days_remaining' => 0, 'shutoff_day' => 10],
            'helicopter' => ['day' => 14, 'days_away' => 2, 'today' => false],
        ],
        'exported_at' => gmdate('Y-m-d\TH:i:s\Z'),
    ]));

    $state = (new GameStateReader($this->filePath))->getGameState();

    expect($state['events']['electricity']['status'])->toBe('on')
        ->and($state['events']['water']['status'])->toBe('off')
        ->and($state['events']['helicopter']['days_away'])->toBe(2);
});

it('reads a state export from a mod too old to carry events', function () {
    file_put_contents($this->filePath, json_encode([
        'time' => ['year' => 1993, 'month' => 7, 'day' => 9, 'hour' => 12, 'minute' => 0,
            'day_of_year' => 190, 'is_night' => false, 'formatted' => '12:00', 'date' => '1993-07-09'],
        'season' => 'summer',
        'exported_at' => gmdate('Y-m-d\TH:i:s\Z'),
    ]));

    $state = (new GameStateReader($this->filePath))->getGameState();

    expect($state)->not->toBeNull()
        ->and($state['events'] ?? null)->toBeNull();
});
