<?php

use App\Services\InventoryReader;

beforeEach(function () {
    $this->fixtureDir = dirname(__DIR__).'/fixtures/lua-bridge';
    $this->tempDir = sys_get_temp_dir().'/pz_inv_test_'.getmypid();
    mkdir($this->tempDir.'/inventory', 0755, true);

    copy(
        $this->fixtureDir.'/inventory/TestPlayer.json',
        $this->tempDir.'/inventory/TestPlayer.json'
    );

    $this->reader = new InventoryReader($this->tempDir.'/inventory', $this->tempDir.'/export_requests.json');
});

afterEach(function () {
    $files = glob($this->tempDir.'/inventory/*.json');
    if ($files) {
        array_map('unlink', $files);
    }
    @rmdir($this->tempDir.'/inventory');
    @rmdir($this->tempDir);
});

it('reads a valid player inventory', function () {
    $inventory = $this->reader->getPlayerInventory('TestPlayer');

    expect($inventory)->not->toBeNull()
        ->and($inventory['username'])->toBe('TestPlayer')
        ->and($inventory['items'])->toHaveCount(2)
        ->and($inventory['items'][0]['full_type'])->toBe('Base.Axe')
        ->and($inventory['items'][0]['equipped'])->toBeTrue()
        ->and($inventory['items'][1]['full_type'])->toBe('Base.WaterBottleFull')
        ->and($inventory['weight'])->toBe(5.2)
        ->and($inventory['max_weight'])->toBe(15.0);
});

it('returns null for missing player', function () {
    expect($this->reader->getPlayerInventory('NonExistent'))->toBeNull();
});

it('handles corrupt JSON gracefully', function () {
    file_put_contents($this->tempDir.'/inventory/CorruptPlayer.json', '{invalid json!!!');

    expect($this->reader->getPlayerInventory('CorruptPlayer'))->toBeNull();
});

it('lists players with inventory snapshots', function () {
    $players = $this->reader->listPlayers();

    expect($players)->toContain('TestPlayer')
        ->and($players)->toHaveCount(1);
});

it('returns empty array when inventory directory is missing', function () {
    $reader = new InventoryReader('/nonexistent/path', '/tmp/nonexistent_export.json');

    expect($reader->listPlayers())->toBe([]);
});

it('gets all inventories', function () {
    $inventories = $this->reader->getAllInventories();

    expect($inventories)->toHaveCount(1)
        ->and($inventories)->toHaveKey('TestPlayer')
        ->and($inventories['TestPlayer']['username'])->toBe('TestPlayer');
});

it('skips corrupt files in getAllInventories', function () {
    file_put_contents($this->tempDir.'/inventory/BadPlayer.json', 'not json');

    $inventories = $this->reader->getAllInventories();

    expect($inventories)->toHaveCount(1)
        ->and($inventories)->toHaveKey('TestPlayer');
});
