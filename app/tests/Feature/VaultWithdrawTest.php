<?php

use App\Enums\TransactionSource;
use App\Enums\VaultTransactionStatus;
use App\Models\User;
use App\Models\VaultSetting;
use App\Services\DeliveryQueueManager;
use App\Services\OnlinePlayersReader;
use App\Services\VaultService;
use App\Services\VaultWithdrawService;
use App\Services\WalletService;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

function mockWithdrawDeps(array $online, array $results = []): void
{
    $queue = Mockery::mock(DeliveryQueueManager::class);
    $queue->shouldReceive('giveItemWithCondition')
        ->andReturnUsing(fn (string $u, string $t, int $c, float $cond) => [
            'id' => 'delivery-w1', 'action' => 'give_with_condition', 'username' => $u,
            'item_type' => $t, 'count' => $c, 'condition' => $cond,
            'status' => 'pending', 'created_at' => date('c'),
        ])->byDefault();
    $queue->shouldReceive('readResults')
        ->andReturn(['version' => 1, 'updated_at' => '', 'results' => $results])
        ->byDefault();
    app()->instance(DeliveryQueueManager::class, $queue);

    $players = Mockery::mock(OnlinePlayersReader::class);
    $players->shouldReceive('getOnlineUsernames')->andReturn($online)->byDefault();
    app()->instance(OnlinePlayersReader::class, $players);
}

function seedVaultUser(float $balance = 100): array
{
    VaultSetting::query()->create([
        'default_slots' => 50, 'max_slots' => 500, 'slot_upgrade_increment' => 10,
        'slot_upgrade_cost' => 100, 'withdraw_fee_flat' => 10, 'withdraw_fee_per_item' => 1,
        'enabled' => true,
    ]);
    $user = User::factory()->create(['username' => 'Player1']);
    $wallet = app(WalletService::class)->getOrCreateWallet($user);
    app(WalletService::class)->credit($wallet, $balance, TransactionSource::AdminAward);

    $vault = app(VaultService::class)->getOrCreateVault($user);
    app(VaultService::class)->addItem($vault, 'Base.Axe', 'Axe', 'Weapon', 0.85, 3);

    return [$user, $vault];
}

it('refuses to withdraw when the player is offline', function () {
    mockWithdrawDeps([]);
    [$user] = seedVaultUser();

    expect(fn () => app(VaultWithdrawService::class)->requestWithdrawal($user, 'Player1', 'Base.Axe', 0.85, 1))
        ->toThrow(InvalidArgumentException::class, 'online');
});

it('computes the fee as flat plus per-item', function () {
    mockWithdrawDeps(['Player1']);
    [$user] = seedVaultUser();

    $tx = app(VaultWithdrawService::class)->requestWithdrawal($user, 'Player1', 'Base.Axe', 0.85, 2);

    expect((float) $tx->fee_charged)->toBe(12.0);
});

it('reserves items out of the vault immediately but does not debit yet', function () {
    mockWithdrawDeps(['Player1']);
    [$user, $vault] = seedVaultUser();

    $tx = app(VaultWithdrawService::class)->requestWithdrawal($user, 'Player1', 'Base.Axe', 0.85, 2);

    expect($vault->items()->sum('count'))->toBe(1)
        ->and($tx->wallet_transaction_id)->toBeNull()
        ->and(app(WalletService::class)->getBalance($user))->toBe(100.0);
});

it('debits the fee only after delivery is confirmed', function () {
    mockWithdrawDeps(['Player1'], [[
        'id' => 'delivery-w1', 'status' => 'delivered', 'processed_at' => date('c'), 'message' => null,
    ]]);
    [$user] = seedVaultUser();

    $service = app(VaultWithdrawService::class);
    $tx = $service->requestWithdrawal($user, 'Player1', 'Base.Axe', 0.85, 2);

    $service->processResults();

    $tx->refresh();
    expect($tx->status)->toBe(VaultTransactionStatus::Completed)
        ->and($tx->wallet_transaction_id)->not->toBeNull()
        ->and(app(WalletService::class)->getBalance($user))->toBe(88.0);
});

it('returns items and charges nothing when delivery fails', function () {
    mockWithdrawDeps(['Player1'], [[
        'id' => 'delivery-w1', 'status' => 'failed', 'processed_at' => date('c'), 'message' => 'no space',
    ]]);
    [$user, $vault] = seedVaultUser();

    $service = app(VaultWithdrawService::class);
    $tx = $service->requestWithdrawal($user, 'Player1', 'Base.Axe', 0.85, 2);

    $service->processResults();

    $tx->refresh();
    expect($tx->status)->toBe(VaultTransactionStatus::Failed)
        ->and($vault->items()->sum('count'))->toBe(3)
        ->and(app(WalletService::class)->getBalance($user))->toBe(100.0);
});

it('restores returned items at their original condition', function () {
    mockWithdrawDeps(['Player1'], [[
        'id' => 'delivery-w1', 'status' => 'failed', 'processed_at' => date('c'), 'message' => 'no space',
    ]]);
    [$user, $vault] = seedVaultUser();

    $service = app(VaultWithdrawService::class);
    $service->requestWithdrawal($user, 'Player1', 'Base.Axe', 0.85, 2);
    $service->processResults();

    expect($vault->items()->count())->toBe(1)
        ->and((float) $vault->items()->first()->condition)->toBe(0.85);
});

it('refuses when the fee exceeds the available balance', function () {
    mockWithdrawDeps(['Player1']);
    [$user] = seedVaultUser(balance: 5);

    expect(fn () => app(VaultWithdrawService::class)->requestWithdrawal($user, 'Player1', 'Base.Axe', 0.85, 1))
        ->toThrow(InvalidArgumentException::class, 'balance');
});

it('refuses to withdraw more than the vault holds', function () {
    mockWithdrawDeps(['Player1']);
    [$user] = seedVaultUser();

    expect(fn () => app(VaultWithdrawService::class)->requestWithdrawal($user, 'Player1', 'Base.Axe', 0.85, 99))
        ->toThrow(InvalidArgumentException::class);
});

it('leaves the transaction pending while Lua has not reported yet', function () {
    mockWithdrawDeps(['Player1']);
    [$user] = seedVaultUser();

    $service = app(VaultWithdrawService::class);
    $tx = $service->requestWithdrawal($user, 'Player1', 'Base.Axe', 0.85, 1);

    expect($service->processResults())->toBe([]);

    $tx->refresh();
    expect($tx->status)->toBe(VaultTransactionStatus::Pending);
});

it('restores the original name and category when the whole stack failed to deliver', function () {
    mockWithdrawDeps(['Player1'], [[
        'id' => 'delivery-w1', 'status' => 'failed', 'processed_at' => date('c'), 'message' => 'no space',
    ]]);
    [$user, $vault] = seedVaultUser();

    $service = app(VaultWithdrawService::class);
    $service->requestWithdrawal($user, 'Player1', 'Base.Axe', 0.85, 3);

    expect($vault->items()->count())->toBe(0);

    $service->processResults();

    $restored = $vault->items()->first();
    expect($restored->name)->toBe('Axe')
        ->and($restored->category)->toBe('Weapon');
});
