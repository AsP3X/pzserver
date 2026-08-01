<?php

use App\Services\PlayerPositionReader;

beforeEach(function () {
    $this->fixtureDir = dirname(__DIR__).'/fixtures/lua-bridge';
    $this->tempDir = sys_get_temp_dir().'/pz_pos_test_'.getmypid();
    mkdir($this->tempDir, 0755, true);

    $this->positionsPath = $this->tempDir.'/players_live.json';
    copy($this->fixtureDir.'/players_live.json', $this->positionsPath);

    $this->reader = new PlayerPositionReader($this->positionsPath);
});

afterEach(function () {
    @unlink($this->positionsPath);
    @rmdir($this->tempDir);
});

it('reads live player positions', function () {
    $data = $this->reader->getLivePositions();

    expect($data)->not->toBeNull()
        ->and($data['timestamp'])->toBe('2026-01-15T14:30:00')
        ->and($data['players'])->toHaveCount(2)
        ->and($data['players'][0]['username'])->toBe('TestPlayer')
        ->and($data['players'][0]['x'])->toBe(10542.5)
        ->and($data['players'][0]['y'])->toBe(9876.3)
        ->and($data['players'][0]['z'])->toBe(0)
        ->and($data['players'][0]['is_dead'])->toBeFalse();
});

it('finds a specific player position', function () {
    $player = $this->reader->getPlayerPosition('AnotherPlayer');

    expect($player)->not->toBeNull()
        ->and($player['username'])->toBe('AnotherPlayer')
        ->and($player['x'])->toBe(10800.0)
        ->and($player['z'])->toBe(1);
});

it('returns null for unknown player', function () {
    expect($this->reader->getPlayerPosition('Ghost'))->toBeNull();
});

it('returns null when file is missing', function () {
    $reader = new PlayerPositionReader('/nonexistent/path.json');

    expect($reader->getLivePositions())->toBeNull();
});

it('handles corrupt JSON gracefully', function () {
    file_put_contents($this->positionsPath, '{broken');

    expect($this->reader->getLivePositions())->toBeNull();
});

it('detects stale data', function () {
    // Fixture has timestamp "2026-01-15T14:30:00" which is in the past
    expect($this->reader->isStale(120))->toBeTrue();
});

it('detects fresh data', function () {
    $data = [
        'timestamp' => date('Y-m-d\TH:i:s'),
        'players' => [],
    ];
    file_put_contents($this->positionsPath, json_encode($data));

    $reader = new PlayerPositionReader($this->positionsPath);
    expect($reader->isStale(120))->toBeFalse();
});

it('treats missing file as stale', function () {
    $reader = new PlayerPositionReader('/nonexistent/path.json');

    expect($reader->isStale())->toBeTrue();
});
