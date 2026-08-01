<?php

use App\Models\AuditLog;
use App\Models\User;
use App\Services\DeliveryQueueManager;
use App\Services\InventoryReader;
use App\Services\ItemCatalogReader;
use App\Services\ItemIconResolver;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->withoutVite();
});

function inventoryAdminUser(): User
{
    return User::factory()->admin()->create();
}

function mockInventoryReader(?array $inventory = null): void
{
    $reader = Mockery::mock(InventoryReader::class);
    $reader->shouldReceive('getPlayerInventory')
        ->andReturn($inventory)
        ->byDefault();
    $reader->shouldReceive('requestExport')
        ->andReturn(true)
        ->byDefault();

    app()->instance(InventoryReader::class, $reader);
}

function mockItemCatalogReader(array $items = []): void
{
    $reader = Mockery::mock(ItemCatalogReader::class);
    $reader->shouldReceive('getAll')->andReturn($items)->byDefault();
    $reader->shouldReceive('search')->andReturn($items)->byDefault();

    app()->instance(ItemCatalogReader::class, $reader);
}

function mockItemIconResolver(): void
{
    $resolver = Mockery::mock(ItemIconResolver::class);
    $resolver->shouldReceive('resolve')
        ->andReturnUsing(fn (string $type) => '/images/items/placeholder.svg')
        ->byDefault();

    app()->instance(ItemIconResolver::class, $resolver);
}

function mockDeliveryQueue(): DeliveryQueueManager
{
    $queue = Mockery::mock(DeliveryQueueManager::class);
    $queue->shouldReceive('giveItem')
        ->andReturnUsing(fn (string $user, string $type, int $count) => [
            'id' => 'test-uuid',
            'action' => 'give',
            'username' => $user,
            'item_type' => $type,
            'count' => $count,
            'status' => 'delivered',
            'created_at' => date('c'),
        ])
        ->byDefault();
    $queue->shouldReceive('removeItem')
        ->andReturnUsing(fn (string $user, string $type, int $count) => [
            'id' => 'test-uuid',
            'action' => 'remove',
            'username' => $user,
            'item_type' => $type,
            'count' => $count,
            'status' => 'delivered',
            'created_at' => date('c'),
        ])
        ->byDefault();
    $queue->shouldReceive('readQueue')
        ->andReturn(['version' => 1, 'updated_at' => '', 'entries' => []])
        ->byDefault();
    $queue->shouldReceive('readResults')
        ->andReturn(['version' => 1, 'updated_at' => '', 'results' => []])
        ->byDefault();

    app()->instance(DeliveryQueueManager::class, $queue);

    return $queue;
}

function setupInventoryMocks(?array $inventory = null): void
{
    mockInventoryReader($inventory);
    mockItemCatalogReader([
        ['full_type' => 'Base.Axe', 'name' => 'Axe', 'category' => 'Weapon', 'icon_name' => 'Item_Axe'],
    ]);
    mockItemIconResolver();
    mockDeliveryQueue();
}

// --- View Inventory ---

it('renders the inventory page for a player with snapshot', function () {
    setupInventoryMocks([
        'username' => 'TestPlayer',
        'timestamp' => '2026-01-15T14:30:00',
        'items' => [
            [
                'full_type' => 'Base.Axe',
                'name' => 'Axe',
                'category' => 'Weapon',
                'count' => 1,
                'condition' => 0.85,
                'equipped' => true,
                'container' => 'inventory',
            ],
        ],
        'weight' => 5.2,
        'max_weight' => 15.0,
    ]);

    $response = $this->actingAs(inventoryAdminUser())
        ->get('/admin/players/TestPlayer/inventory');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('admin/player-inventory')
        ->where('username', 'TestPlayer')
        ->has('inventory')
        ->has('inventory.items', 1)
        ->has('catalog')
        ->has('deliveries')
    );
});

it('renders the inventory page with null inventory for unknown player', function () {
    setupInventoryMocks(null);

    $response = $this->actingAs(inventoryAdminUser())
        ->get('/admin/players/UnknownPlayer/inventory');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('admin/player-inventory')
        ->where('username', 'UnknownPlayer')
        ->where('inventory', null)
    );
});

it('requires authentication to view inventory', function () {
    $response = $this->get('/admin/players/TestPlayer/inventory');

    $response->assertRedirect('/login');
});

// --- Give Item ---

it('gives an item to a player', function () {
    setupInventoryMocks();

    $response = $this->actingAs(inventoryAdminUser())
        ->postJson('/admin/players/TestPlayer/inventory/give', [
            'item_type' => 'Base.Axe',
            'count' => 1,
        ]);

    $response->assertCreated();
    $response->assertJsonFragment([
        'action' => 'give',
        'username' => 'TestPlayer',
        'item_type' => 'Base.Axe',
        'count' => 1,
    ]);
    // Status can be 'delivered' (RCON) or 'pending' (queue fallback)
    expect($response->json('status'))->toBeIn(['delivered', 'pending']);
});

it('gives multiple items to a player', function () {
    setupInventoryMocks();

    $response = $this->actingAs(inventoryAdminUser())
        ->postJson('/admin/players/TestPlayer/inventory/give', [
            'item_type' => 'Base.Bandage',
            'count' => 5,
        ]);

    $response->assertCreated();
    $response->assertJsonFragment(['count' => 5]);
});

it('audit logs give item action', function () {
    setupInventoryMocks();

    $this->actingAs(inventoryAdminUser())
        ->postJson('/admin/players/TestPlayer/inventory/give', [
            'item_type' => 'Base.Axe',
            'count' => 1,
        ]);

    expect(AuditLog::where('action', 'inventory.give')->count())->toBe(1);
    $log = AuditLog::where('action', 'inventory.give')->first();
    expect($log->target)->toBe('TestPlayer')
        ->and($log->details['item_type'])->toBe('Base.Axe')
        ->and($log->details['count'])->toBe(1);
});

it('validates item_type is required for give', function () {
    setupInventoryMocks();

    $response = $this->actingAs(inventoryAdminUser())
        ->postJson('/admin/players/TestPlayer/inventory/give', [
            'count' => 1,
        ]);

    $response->assertUnprocessable();
    $response->assertJsonValidationErrors(['item_type']);
});

it('validates count is required for give', function () {
    setupInventoryMocks();

    $response = $this->actingAs(inventoryAdminUser())
        ->postJson('/admin/players/TestPlayer/inventory/give', [
            'item_type' => 'Base.Axe',
        ]);

    $response->assertUnprocessable();
    $response->assertJsonValidationErrors(['count']);
});

it('validates count must be positive for give', function () {
    setupInventoryMocks();

    $response = $this->actingAs(inventoryAdminUser())
        ->postJson('/admin/players/TestPlayer/inventory/give', [
            'item_type' => 'Base.Axe',
            'count' => 0,
        ]);

    $response->assertUnprocessable();
    $response->assertJsonValidationErrors(['count']);
});

it('validates count max is 100 for give', function () {
    setupInventoryMocks();

    $response = $this->actingAs(inventoryAdminUser())
        ->postJson('/admin/players/TestPlayer/inventory/give', [
            'item_type' => 'Base.Axe',
            'count' => 101,
        ]);

    $response->assertUnprocessable();
    $response->assertJsonValidationErrors(['count']);
});

// --- Remove Item ---

it('removes an item from a player', function () {
    setupInventoryMocks();

    $response = $this->actingAs(inventoryAdminUser())
        ->postJson('/admin/players/TestPlayer/inventory/remove', [
            'item_type' => 'Base.Axe',
            'count' => 1,
        ]);

    $response->assertCreated();
    $response->assertJsonFragment([
        'action' => 'remove',
        'username' => 'TestPlayer',
        'item_type' => 'Base.Axe',
    ]);
});

it('audit logs remove item action', function () {
    setupInventoryMocks();

    $this->actingAs(inventoryAdminUser())
        ->postJson('/admin/players/TestPlayer/inventory/remove', [
            'item_type' => 'Base.Axe',
            'count' => 1,
        ]);

    expect(AuditLog::where('action', 'inventory.remove')->count())->toBe(1);
    $log = AuditLog::where('action', 'inventory.remove')->first();
    expect($log->target)->toBe('TestPlayer');
});

it('validates item_type is required for remove', function () {
    setupInventoryMocks();

    $response = $this->actingAs(inventoryAdminUser())
        ->postJson('/admin/players/TestPlayer/inventory/remove', [
            'count' => 1,
        ]);

    $response->assertUnprocessable();
    $response->assertJsonValidationErrors(['item_type']);
});

// --- Delivery Status ---

it('returns delivery status for a player', function () {
    mockInventoryReader();
    mockItemCatalogReader();
    mockItemIconResolver();

    $queue = Mockery::mock(DeliveryQueueManager::class);
    $queue->shouldReceive('readQueue')->andReturn([
        'version' => 1,
        'updated_at' => date('c'),
        'entries' => [
            [
                'id' => 'uuid-1',
                'action' => 'give',
                'username' => 'TestPlayer',
                'item_type' => 'Base.Axe',
                'count' => 1,
                'status' => 'pending',
                'created_at' => date('c'),
            ],
            [
                'id' => 'uuid-2',
                'action' => 'give',
                'username' => 'OtherPlayer',
                'item_type' => 'Base.Pistol',
                'count' => 1,
                'status' => 'pending',
                'created_at' => date('c'),
            ],
        ],
    ]);
    $queue->shouldReceive('readResults')->andReturn([
        'version' => 1,
        'updated_at' => date('c'),
        'results' => [
            [
                'id' => 'uuid-1',
                'status' => 'delivered',
                'processed_at' => date('c'),
                'message' => null,
            ],
        ],
    ]);
    app()->instance(DeliveryQueueManager::class, $queue);

    $response = $this->actingAs(inventoryAdminUser())
        ->getJson('/admin/players/TestPlayer/inventory/status');

    $response->assertOk();
    $response->assertJsonCount(1, 'pending');
    $response->assertJsonCount(1, 'results');
    $response->assertJsonFragment(['username' => 'TestPlayer']);
    // Should NOT contain OtherPlayer entries
    $response->assertJsonMissing(['username' => 'OtherPlayer']);
});

it('returns empty delivery status when no entries exist', function () {
    setupInventoryMocks();

    $response = $this->actingAs(inventoryAdminUser())
        ->getJson('/admin/players/TestPlayer/inventory/status');

    $response->assertOk();
    $response->assertJsonCount(0, 'pending');
    $response->assertJsonCount(0, 'results');
});

// --- Auth ---

it('requires authentication for give', function () {
    $response = $this->postJson('/admin/players/TestPlayer/inventory/give', [
        'item_type' => 'Base.Axe',
        'count' => 1,
    ]);

    $response->assertUnauthorized();
});

it('requires authentication for remove', function () {
    $response = $this->postJson('/admin/players/TestPlayer/inventory/remove', [
        'item_type' => 'Base.Axe',
        'count' => 1,
    ]);

    $response->assertUnauthorized();
});

// --- Username Validation (path traversal prevention) ---

it('rejects path traversal in inventory view', function () {
    setupInventoryMocks();

    $response = $this->actingAs(inventoryAdminUser())
        ->get('/admin/players/../etc/passwd/inventory');

    $response->assertNotFound();
});

it('rejects path traversal in give', function () {
    setupInventoryMocks();

    $response = $this->actingAs(inventoryAdminUser())
        ->postJson('/admin/players/../../etc/inventory/give', [
            'item_type' => 'Base.Axe',
            'count' => 1,
        ]);

    $response->assertNotFound();
});
