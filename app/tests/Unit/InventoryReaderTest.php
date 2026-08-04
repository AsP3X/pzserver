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
    @unlink($this->tempDir.'/export_requests.json');
    @rmdir($this->tempDir.'/inventory');
    @rmdir($this->tempDir);
});

it('requestExport writes world-writable export_requests.json', function () {
    expect($this->reader->requestExport('AsP3X'))->toBeTrue();

    $path = $this->tempDir.'/export_requests.json';
    expect(file_exists($path))->toBeTrue();

    $data = json_decode(file_get_contents($path), true);
    expect($data['usernames'])->toContain('AsP3X');

    if (PHP_OS_FAMILY !== 'Windows') {
        expect(fileperms($path) & 0002)->not->toBe(0);
    }
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

it('reports an absent condition as null rather than dropping the key', function () {
    file_put_contents(
        $this->tempDir.'/inventory/NoWear.json',
        json_encode([
            'username' => 'NoWear',
            'timestamp' => '2026-01-15T14:30:00',
            'items' => [
                ['full_type' => 'Base.TinnedBeans', 'name' => 'Tinned Beans', 'category' => 'Food', 'count' => 1, 'equipped' => false, 'container' => 'inventory'],
                ['full_type' => 'Base.Axe', 'name' => 'Axe', 'category' => 'Weapon', 'count' => 1, 'condition' => 0.6, 'equipped' => false, 'container' => 'inventory'],
            ],
            'weight' => 3.0,
            'max_weight' => 15.0,
        ])
    );

    $items = $this->reader->getPlayerInventory('NoWear')['items'];

    expect($items[0])->toHaveKey('condition')
        ->and($items[0]['condition'])->toBeNull()
        ->and($items[1]['condition'])->toBe(0.6);
});

it('coerces a non-numeric condition to null and an integer one to a float', function () {
    file_put_contents(
        $this->tempDir.'/inventory/OddWear.json',
        json_encode([
            'username' => 'OddWear',
            'timestamp' => '2026-01-15T14:30:00',
            'items' => [
                ['full_type' => 'Base.Axe', 'name' => 'Axe', 'category' => 'Weapon', 'count' => 1, 'condition' => null, 'equipped' => false, 'container' => 'inventory'],
                ['full_type' => 'Base.Bag', 'name' => 'Bag', 'category' => 'Bag', 'count' => 1, 'condition' => 1, 'equipped' => false, 'container' => 'inventory'],
            ],
            'weight' => 3.0,
            'max_weight' => 15.0,
        ])
    );

    $items = $this->reader->getPlayerInventory('OddWear')['items'];

    expect($items[0]['condition'])->toBeNull()
        ->and($items[1]['condition'])->toBe(1.0);
});
