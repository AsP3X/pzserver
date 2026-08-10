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
    if (file_exists($this->tempDir.'/export_requests.json')) {
        unlink($this->tempDir.'/export_requests.json');
    }
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

/**
 * Write a snapshot for `$username` and hand back what the reader makes of it.
 *
 * @param  array<int, array<string, mixed>>  $items
 * @param  array<int, array<string, mixed>>|null  $containers
 * @return array<string, mixed>
 */
function readSnapshot(string $dir, string $username, array $items, ?array $containers = null): array
{
    $payload = [
        'username' => $username,
        'timestamp' => '2026-01-15T14:30:00',
        'items' => $items,
        'weight' => 3.0,
        'max_weight' => 15.0,
    ];

    if ($containers !== null) {
        $payload['containers'] = $containers;
    }

    file_put_contents($dir.'/inventory/'.$username.'.json', json_encode($payload));

    return test()->reader->getPlayerInventory($username);
}

/**
 * @return array<string, mixed>
 */
function item(string $name, string $containerId, string $container, ?string $contains = null): array
{
    return [
        'full_type' => 'Base.'.str_replace(' ', '', $name),
        'name' => $name,
        'category' => 'Item',
        'count' => 1,
        'condition' => null,
        'equipped' => false,
        'container' => $container,
        'container_id' => $containerId,
        'contains' => $contains,
    ];
}

it('keeps two bags of the same name apart', function () {
    $inventory = readSnapshot($this->tempDir, 'TwoWallets', [
        item('Duffel Bag', 'inventory', 'inventory', 'bag:i100'),
        item('Wallet', 'bag:i100', 'Duffel Bag', 'bag:i101'),
        item('ID Card', 'bag:i101', 'Wallet'),
        item('Wallet', 'bag:i100', 'Duffel Bag', 'bag:i102'),
        item('Credit Card', 'bag:i102', 'Wallet'),
    ], [
        ['id' => 'inventory', 'parent' => null, 'name' => 'inventory'],
        ['id' => 'bag:i100', 'parent' => 'inventory', 'name' => 'Duffel Bag'],
        ['id' => 'bag:i101', 'parent' => 'bag:i100', 'name' => 'Wallet'],
        ['id' => 'bag:i102', 'parent' => 'bag:i100', 'name' => 'Wallet'],
    ]);

    expect(array_column($inventory['containers'], 'id'))
        ->toBe(['inventory', 'bag:i100', 'bag:i101', 'bag:i102'])
        ->and(array_column($inventory['containers'], 'depth'))->toBe([0, 1, 2, 2]);

    $inWallets = array_filter(
        $inventory['items'],
        fn (array $item): bool => in_array($item['container_id'], ['bag:i101', 'bag:i102'], true)
    );

    expect(array_column($inWallets, 'name'))->toBe(['ID Card', 'Credit Card']);
});

it('orders the container tree depth first with the pockets leading', function () {
    $inventory = readSnapshot($this->tempDir, 'Nested', [
        item('Tin Opener', 'inventory', 'inventory'),
    ], [
        ['id' => 'bag:i2', 'parent' => 'bag:i1', 'name' => 'Pouch'],
        ['id' => 'bag:i1', 'parent' => 'inventory', 'name' => 'Backpack'],
        ['id' => 'inventory', 'parent' => null, 'name' => 'inventory'],
        ['id' => 'bag:i3', 'parent' => 'inventory', 'name' => 'Holster'],
    ]);

    expect(array_column($inventory['containers'], 'id'))
        ->toBe(['inventory', 'bag:i1', 'bag:i2', 'bag:i3'])
        ->and(array_column($inventory['containers'], 'depth'))->toBe([0, 1, 2, 1]);
});

it('rebuilds the tree by name for a snapshot written before container ids', function () {
    $inventory = $this->reader->getPlayerInventory('TestPlayer');

    expect($inventory['containers'])->toHaveCount(2)
        ->and($inventory['containers'][0]['id'])->toBe('inventory')
        ->and($inventory['containers'][0]['depth'])->toBe(0)
        ->and($inventory['containers'][1]['id'])->toBe('Big Hiking Bag')
        ->and($inventory['containers'][1]['parent'])->toBe('inventory')
        ->and($inventory['items'][1]['container_id'])->toBe('Big Hiking Bag')
        ->and($inventory['items'][1]['contains'])->toBeNull();
});

it('nests a legacy container under the item carrying it', function () {
    $inventory = readSnapshot($this->tempDir, 'Legacy', [
        ['full_type' => 'Base.Bag_Big', 'name' => 'Big Hiking Bag', 'category' => 'Bag', 'count' => 1, 'equipped' => false, 'container' => 'inventory'],
        ['full_type' => 'Base.Purse', 'name' => 'Purse', 'category' => 'Bag', 'count' => 1, 'equipped' => false, 'container' => 'Big Hiking Bag'],
        ['full_type' => 'Base.Money', 'name' => 'Money', 'category' => 'Item', 'count' => 1, 'equipped' => false, 'container' => 'Purse'],
    ]);

    expect(array_column($inventory['containers'], 'id'))->toBe(['inventory', 'Big Hiking Bag', 'Purse'])
        ->and(array_column($inventory['containers'], 'depth'))->toBe([0, 1, 2]);
});

it('pulls a container with a missing parent up to the top level', function () {
    $inventory = readSnapshot($this->tempDir, 'Orphan', [
        item('Screwdriver', 'bag:gone', 'Toolbox'),
    ], [
        ['id' => 'inventory', 'parent' => null, 'name' => 'inventory'],
        ['id' => 'bag:gone', 'parent' => 'bag:never-sent', 'name' => 'Toolbox'],
    ]);

    expect(array_column($inventory['containers'], 'id'))->toBe(['inventory', 'bag:gone'])
        ->and($inventory['containers'][1]['depth'])->toBe(0);
});

it('keeps every container when the bridge reports a cycle', function () {
    $inventory = readSnapshot($this->tempDir, 'Cycle', [
        item('Rope', 'bag:a', 'Bag A'),
        item('Hook', 'bag:b', 'Bag B'),
    ], [
        ['id' => 'inventory', 'parent' => null, 'name' => 'inventory'],
        ['id' => 'bag:a', 'parent' => 'bag:b', 'name' => 'Bag A'],
        ['id' => 'bag:b', 'parent' => 'bag:a', 'name' => 'Bag B'],
    ]);

    expect(array_column($inventory['containers'], 'id'))->toContain('bag:a', 'bag:b')
        ->and($inventory['containers'])->toHaveCount(3);
});

it('invents a container for an item the bridge left unaccounted for', function () {
    $inventory = readSnapshot($this->tempDir, 'Unlisted', [
        item('Torch', 'bag:i9', 'Mystery Bag'),
    ], [
        ['id' => 'inventory', 'parent' => null, 'name' => 'inventory'],
    ]);

    expect(array_column($inventory['containers'], 'id'))->toBe(['inventory', 'bag:i9'])
        ->and($inventory['containers'][1]['name'])->toBe('Mystery Bag')
        ->and($inventory['containers'][1]['parent'])->toBe('inventory');
});

it('always reports the pockets, even for an empty inventory', function () {
    $inventory = readSnapshot($this->tempDir, 'Naked', []);

    expect($inventory['containers'])->toBe([
        ['id' => 'inventory', 'parent' => null, 'name' => 'inventory', 'depth' => 0],
    ]);
});
