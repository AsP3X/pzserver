<?php

use App\Models\User;
use App\Models\VaultSetting;
use App\Models\WhitelistEntry;
use App\Services\DeliveryQueueManager;
use App\Services\ItemIconResolver;
use App\Services\OnlinePlayersReader;
use App\Services\VaultService;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->withoutVite();

    $players = Mockery::mock(OnlinePlayersReader::class);
    $players->shouldReceive('getOnlineUsernames')->andReturn(['Player1'])->byDefault();
    app()->instance(OnlinePlayersReader::class, $players);

    $queue = Mockery::mock(DeliveryQueueManager::class);
    $queue->shouldReceive('removeItemVerified')
        ->andReturn(['id' => 'd-1', 'action' => 'remove_verified', 'username' => 'Player1',
            'item_type' => 'Base.Axe', 'count' => 1, 'status' => 'pending', 'created_at' => date('c')])
        ->byDefault();
    $queue->shouldReceive('giveItemWithCondition')
        ->andReturn(['id' => 'd-2', 'action' => 'give_with_condition', 'username' => 'Player1',
            'item_type' => 'Base.Axe', 'count' => 1, 'condition' => 1.0, 'status' => 'pending', 'created_at' => date('c')])
        ->byDefault();
    $queue->shouldReceive('readResults')
        ->andReturn(['version' => 1, 'updated_at' => '', 'results' => []])
        ->byDefault();
    app()->instance(DeliveryQueueManager::class, $queue);

    $icons = Mockery::mock(ItemIconResolver::class);
    $icons->shouldReceive('resolve')->andReturn('/images/items/placeholder.svg')->byDefault();
    app()->instance(ItemIconResolver::class, $icons);
});

function vaultPlayer(string $username = 'Player1'): User
{
    $user = User::factory()->create(['username' => $username]);
    WhitelistEntry::factory()->create([
        'user_id' => $user->id, 'pz_username' => $username, 'active' => true,
    ]);

    return $user;
}

it('redirects guests to login', function () {
    $this->get('/portal/vault')->assertRedirect('/login');
});

it('renders the vault page with capacity, fees and contents', function () {
    $response = $this->actingAs(vaultPlayer())->get('/portal/vault');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('portal/vault')
        ->has('items')
        ->has('capacity')
        ->has('fees')
        ->has('transactions')
        ->where('hasPzAccount', true)
        ->where('username', 'Player1')
    );
});

it('shows stored items with resolved icons', function () {
    $user = vaultPlayer();
    $vault = app(VaultService::class)->getOrCreateVault($user);
    app(VaultService::class)->addItem($vault, 'Base.Axe', 'Axe', 'Weapon', 0.5, 2);

    $response = $this->actingAs($user)->get('/portal/vault');

    $response->assertInertia(fn ($page) => $page
        ->has('items', 1)
        ->where('items.0.name', 'Axe')
        ->where('items.0.count', 2)
        ->where('items.0.icon', '/images/items/placeholder.svg')
    );
});

it('reports no linked account when the player has no whitelist entry', function () {
    $user = User::factory()->create(['username' => 'Unlinked']);

    $this->actingAs($user)->get('/portal/vault')->assertInertia(fn ($page) => $page
        ->where('hasPzAccount', false)
        ->where('username', null)
    );
});

it('rejects a withdrawal of an item the player does not have', function () {
    $response = $this->actingAs(vaultPlayer())->postJson('/portal/vault/withdraw', [
        'full_type' => 'Base.Axe', 'condition' => 1.0, 'count' => 1,
    ]);

    $response->assertStatus(422);
});

it('accepts a deposit request and returns the transaction id', function () {
    $response = $this->actingAs(vaultPlayer())->postJson('/portal/vault/deposit', [
        'full_type' => 'Base.Axe', 'name' => 'Axe', 'category' => 'Weapon', 'count' => 1,
    ]);

    $response->assertStatus(201)->assertJsonStructure(['transaction_id']);
});

it('validates the deposit payload', function () {
    $this->actingAs(vaultPlayer())
        ->postJson('/portal/vault/deposit', ['full_type' => '', 'count' => 0])
        ->assertStatus(422);
});

it('rejects an upgrade the player cannot afford', function () {
    VaultSetting::query()->create([
        'default_slots' => 10, 'max_slots' => 100, 'slot_upgrade_increment' => 10,
        'slot_upgrade_cost' => 500, 'withdraw_fee_flat' => 0,
        'withdraw_fee_per_item' => 0, 'enabled' => true,
    ]);

    $this->actingAs(vaultPlayer())
        ->postJson('/portal/vault/upgrade', [])
        ->assertStatus(422);
});

it('never exposes another player vault', function () {
    $other = vaultPlayer('Other');
    $otherVault = app(VaultService::class)->getOrCreateVault($other);
    app(VaultService::class)->addItem($otherVault, 'Base.Rope', 'Rope', 'Material', 1.0, 5);

    $me = vaultPlayer('Player1');

    $this->actingAs($me)->get('/portal/vault')->assertInertia(fn ($page) => $page
        ->has('items', 0)
        ->where('username', 'Player1')
    );
});
