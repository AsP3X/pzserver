<?php

use App\Services\DeliveryQueueManager;
use App\Services\InventoryReader;
use App\Services\OnlinePlayersReader;
use App\Services\RconClient;

beforeEach(function () {
    $this->fixtureDir = dirname(__DIR__).'/fixtures/lua-bridge';
    $this->tempDir = sys_get_temp_dir().'/pz_delivery_test_'.getmypid();
    mkdir($this->tempDir, 0755, true);

    $this->queuePath = $this->tempDir.'/delivery_queue.json';
    $this->resultsPath = $this->tempDir.'/delivery_results.json';

    // Mock RCON and OnlinePlayers so RCON path is skipped (player not online)
    $rcon = Mockery::mock(RconClient::class);
    $onlinePlayers = Mockery::mock(OnlinePlayersReader::class);
    $onlinePlayers->shouldReceive('getOnlineUsernames')->andReturn([]);
    $inventoryReader = Mockery::mock(InventoryReader::class);

    $this->manager = new DeliveryQueueManager(
        rcon: $rcon,
        onlinePlayers: $onlinePlayers,
        inventoryReader: $inventoryReader,
        queuePath: $this->queuePath,
        resultsPath: $this->resultsPath,
    );
});

afterEach(function () {
    $files = glob($this->tempDir.'/*') ?: [];
    array_map(fn ($f) => is_file($f) && unlink($f), $files);
    if (is_dir($this->tempDir)) {
        rmdir($this->tempDir);
    }
});

it('gives an item by adding to queue', function () {
    $entry = $this->manager->giveItem('TestPlayer', 'Base.Axe', 2);

    expect($entry['action'])->toBe('give')
        ->and($entry['username'])->toBe('TestPlayer')
        ->and($entry['item_type'])->toBe('Base.Axe')
        ->and($entry['count'])->toBe(2)
        ->and($entry['status'])->toBe('pending')
        ->and($entry['id'])->toMatch('/^[0-9a-f-]{36}$/');
});

it('gives a verified item by adding to queue', function () {
    $entry = $this->manager->giveItemVerified('TestPlayer', 'Base.Axe', 3);

    expect($entry['action'])->toBe('give_verified')
        ->and($entry['username'])->toBe('TestPlayer')
        ->and($entry['item_type'])->toBe('Base.Axe')
        ->and($entry['count'])->toBe(3)
        ->and($entry['status'])->toBe('pending')
        ->and($entry['id'])->toMatch('/^[0-9a-f-]{36}$/');
});

it('removes an item by adding to queue', function () {
    $entry = $this->manager->removeItem('TestPlayer', 'Base.WaterBottleFull');

    expect($entry['action'])->toBe('remove')
        ->and($entry['username'])->toBe('TestPlayer')
        ->and($entry['item_type'])->toBe('Base.WaterBottleFull')
        ->and($entry['count'])->toBe(1);
});

it('reads queue from file', function () {
    copy($this->fixtureDir.'/delivery_queue.json', $this->queuePath);

    $queue = $this->manager->readQueue();

    expect($queue['version'])->toBe(1)
        ->and($queue['entries'])->toHaveCount(1)
        ->and($queue['entries'][0]['id'])->toBe('550e8400-e29b-41d4-a716-446655440000')
        ->and($queue['entries'][0]['action'])->toBe('give');
});

it('returns empty queue when file is missing', function () {
    $queue = $this->manager->readQueue();

    expect($queue['version'])->toBe(1)
        ->and($queue['entries'])->toBe([]);
});

it('reads results from file', function () {
    copy($this->fixtureDir.'/delivery_results.json', $this->resultsPath);

    $results = $this->manager->readResults();

    expect($results['version'])->toBe(1)
        ->and($results['results'])->toHaveCount(1)
        ->and($results['results'][0]['status'])->toBe('delivered');
});

it('returns empty results when file is missing', function () {
    $results = $this->manager->readResults();

    expect($results['version'])->toBe(1)
        ->and($results['results'])->toBe([]);
});

it('cleans up the queue', function () {
    $this->manager->giveItem('TestPlayer', 'Base.Axe');
    expect($this->manager->readQueue()['entries'])->toHaveCount(1);

    $this->manager->cleanupQueue();
    expect($this->manager->readQueue()['entries'])->toBe([]);
});

it('cleans up the results', function () {
    copy($this->fixtureDir.'/delivery_results.json', $this->resultsPath);
    expect($this->manager->readResults()['results'])->toHaveCount(1);

    $this->manager->cleanupResults();
    expect($this->manager->readResults()['results'])->toBe([]);
});

it('appends multiple entries with unique UUIDs', function () {
    $entry1 = $this->manager->giveItem('Player1', 'Base.Axe');
    $entry2 = $this->manager->giveItem('Player2', 'Base.Hammer');
    $entry3 = $this->manager->removeItem('Player1', 'Base.WaterBottleFull');

    $queue = $this->manager->readQueue();

    expect($queue['entries'])->toHaveCount(3)
        ->and($entry1['id'])->not->toBe($entry2['id'])
        ->and($entry2['id'])->not->toBe($entry3['id']);
});

it('writes queue atomically (file exists after write)', function () {
    $this->manager->giveItem('TestPlayer', 'Base.Axe');

    expect(file_exists($this->queuePath))->toBeTrue();

    $content = json_decode(file_get_contents($this->queuePath), true);
    expect($content['entries'])->toHaveCount(1);
});
