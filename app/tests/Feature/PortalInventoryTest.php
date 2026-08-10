<?php

use App\Models\User;
use App\Models\WhitelistEntry;
use App\Services\InventoryReader;
use App\Services\ItemIconResolver;
use App\Services\OnlinePlayersReader;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->withoutVite();
});

function portalSnapshot(string $username = 'TestPlayer'): array
{
    return [
        'username' => $username,
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
            [
                'full_type' => 'Base.Bandage',
                'name' => 'Bandage',
                'category' => 'Medical',
                'count' => 3,
                'condition' => null,
                'equipped' => false,
                'container' => 'backpack',
                'container_id' => 'bag:i1',
                'contains' => null,
            ],
        ],
        'containers' => [
            ['id' => 'inventory', 'parent' => null, 'name' => 'inventory', 'depth' => 0],
            ['id' => 'bag:i1', 'parent' => 'inventory', 'name' => 'backpack', 'depth' => 1],
        ],
        'weight' => 5.2,
        'max_weight' => 15.0,
    ];
}

function mockPortalInventoryReader(?array $inventory): void
{
    $reader = Mockery::mock(InventoryReader::class);
    $reader->shouldReceive('getPlayerInventory')->andReturn($inventory)->byDefault();
    $reader->shouldReceive('requestExport')->andReturn(true)->byDefault();

    app()->instance(InventoryReader::class, $reader);
}

function mockPortalOnlinePlayers(array $usernames): void
{
    $reader = Mockery::mock(OnlinePlayersReader::class);
    $reader->shouldReceive('getOnlineUsernames')->andReturn($usernames)->byDefault();

    app()->instance(OnlinePlayersReader::class, $reader);
}

function mockPortalIconResolver(): void
{
    $resolver = Mockery::mock(ItemIconResolver::class);
    $resolver->shouldReceive('resolve')
        ->andReturn('/images/items/placeholder.svg')
        ->byDefault();

    app()->instance(ItemIconResolver::class, $resolver);
}

function portalPlayer(string $username = 'TestPlayer'): User
{
    $user = User::factory()->create(['username' => $username]);

    WhitelistEntry::factory()->create([
        'user_id' => $user->id,
        'pz_username' => $username,
        'active' => true,
    ]);

    return $user;
}

it('redirects guests to login', function () {
    $this->get('/portal/inventory')->assertRedirect('/login');
});

it('renders the signed-in player their own inventory', function () {
    mockPortalInventoryReader(portalSnapshot());
    mockPortalOnlinePlayers(['TestPlayer']);
    mockPortalIconResolver();

    $response = $this->actingAs(portalPlayer())->get('/portal/inventory');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('portal/inventory')
        ->where('username', 'TestPlayer')
        ->where('hasPzAccount', true)
        ->where('isOnline', true)
        ->where('inventory.weight', 5.2)
        ->has('inventory.items', 2)
        ->has('inventory.containers', 2)
        ->where('inventory.containers.1.name', 'backpack')
        ->where('inventory.items.0.icon', '/images/items/placeholder.svg')
    );
});

it('requests a fresh export for the caller and nobody else', function () {
    $reader = Mockery::mock(InventoryReader::class);
    $reader->shouldReceive('requestExport')->with('TestPlayer')->once()->andReturn(true);
    $reader->shouldReceive('getPlayerInventory')->with('TestPlayer')->andReturn(portalSnapshot());
    app()->instance(InventoryReader::class, $reader);

    mockPortalOnlinePlayers([]);
    mockPortalIconResolver();

    $this->actingAs(portalPlayer())->get('/portal/inventory')->assertOk();
});

it('ignores a username supplied in the query string', function () {
    /** Strict `with()` — reading any other player's inventory fails the test. */
    $reader = Mockery::mock(InventoryReader::class);
    $reader->shouldReceive('requestExport')->with('TestPlayer')->andReturn(true);
    $reader->shouldReceive('getPlayerInventory')->with('TestPlayer')->andReturn(portalSnapshot());
    app()->instance(InventoryReader::class, $reader);

    mockPortalOnlinePlayers([]);
    mockPortalIconResolver();

    portalPlayer('OtherPlayer');

    $response = $this->actingAs(portalPlayer())
        ->get('/portal/inventory?username=OtherPlayer');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page->where('username', 'TestPlayer'));
});

it('reports the player as offline when they are not connected', function () {
    mockPortalInventoryReader(portalSnapshot());
    mockPortalOnlinePlayers(['SomeoneElse']);
    mockPortalIconResolver();

    $response = $this->actingAs(portalPlayer())->get('/portal/inventory');

    $response->assertInertia(fn ($page) => $page
        ->where('isOnline', false)
        ->has('inventory')
    );
});

it('renders with a null inventory when no snapshot exists yet', function () {
    mockPortalInventoryReader(null);
    mockPortalOnlinePlayers([]);
    mockPortalIconResolver();

    $response = $this->actingAs(portalPlayer())->get('/portal/inventory');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->where('hasPzAccount', true)
        ->where('inventory', null)
    );
});

it('reports no linked account when the player has no active whitelist entry', function () {
    mockPortalInventoryReader(portalSnapshot());
    mockPortalOnlinePlayers([]);
    mockPortalIconResolver();

    $user = User::factory()->create(['username' => 'Unlinked']);

    $response = $this->actingAs($user)->get('/portal/inventory');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->where('hasPzAccount', false)
        ->where('username', null)
        ->where('inventory', null)
    );
});

it('falls back to the account username when the whitelist entry is not user-linked', function () {
    mockPortalInventoryReader(portalSnapshot('Legacy'));
    mockPortalOnlinePlayers([]);
    mockPortalIconResolver();

    $user = User::factory()->create(['username' => 'Legacy']);
    WhitelistEntry::factory()->create([
        'user_id' => null,
        'pz_username' => 'Legacy',
        'active' => true,
    ]);

    $response = $this->actingAs($user)->get('/portal/inventory');

    $response->assertInertia(fn ($page) => $page
        ->where('username', 'Legacy')
        ->where('hasPzAccount', true)
    );
});
