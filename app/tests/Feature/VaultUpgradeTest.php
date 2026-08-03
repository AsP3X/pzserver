<?php

use App\Enums\TransactionSource;
use App\Models\User;
use App\Models\VaultSetting;
use App\Services\VaultService;
use App\Services\WalletService;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

function upgradeUser(float $balance): User
{
    VaultSetting::query()->create([
        'default_slots' => 10, 'max_slots' => 30,
        'slot_upgrade_increment' => 10, 'slot_upgrade_cost' => 50,
        'withdraw_fee_flat' => 0, 'withdraw_fee_per_item' => 0, 'enabled' => true,
    ]);
    $user = User::factory()->create();
    $wallet = app(WalletService::class)->getOrCreateWallet($user);
    app(WalletService::class)->credit($wallet, $balance, TransactionSource::AdminAward);

    return $user;
}

it('adds slots and debits the cost', function () {
    $user = upgradeUser(100);

    $vault = app(VaultService::class)->purchaseSlots($user);

    expect($vault->slot_capacity)->toBe(20)
        ->and(app(WalletService::class)->getBalance($user))->toBe(50.0);
});

it('records the debit against the vault upgrade source', function () {
    $user = upgradeUser(100);

    app(VaultService::class)->purchaseSlots($user);

    $transaction = $user->wallet->transactions()->latest()->first();
    expect($transaction->source)->toBe(TransactionSource::VaultUpgrade);
});

it('refuses when the balance is too low', function () {
    $user = upgradeUser(10);

    expect(fn () => app(VaultService::class)->purchaseSlots($user))
        ->toThrow(InvalidArgumentException::class, 'balance');
});

it('refuses to exceed the configured maximum', function () {
    $user = upgradeUser(1000);
    $service = app(VaultService::class);
    $service->purchaseSlots($user);
    $service->purchaseSlots($user);

    expect(fn () => $service->purchaseSlots($user))
        ->toThrow(InvalidArgumentException::class, 'maximum');
});

it('does not debit when the upgrade is refused', function () {
    $user = upgradeUser(10);

    try {
        app(VaultService::class)->purchaseSlots($user);
    } catch (InvalidArgumentException) {
        // expected
    }

    expect(app(WalletService::class)->getBalance($user))->toBe(10.0);
});
