<?php

use App\Enums\TransactionSource;
use App\Enums\VaultDirection;
use App\Enums\VaultTransactionStatus;
use App\Models\User;
use App\Models\Vault;
use App\Models\VaultTransaction;
use App\Services\WalletService;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

function walletWithVaultTransaction(VaultTransactionStatus $status, float $fee): User
{
    $service = app(WalletService::class);
    $user = User::factory()->create();
    $wallet = $service->getOrCreateWallet($user);
    $service->credit($wallet, 100, TransactionSource::AdminAward);

    $vault = Vault::factory()->create(['user_id' => $user->id]);
    VaultTransaction::query()->create([
        'vault_id' => $vault->id,
        'direction' => VaultDirection::Withdraw,
        'status' => $status,
        'full_type' => 'Base.Axe',
        'condition' => 1.0,
        'requested_count' => 1,
        'fee_charged' => $fee,
    ]);

    return $user;
}

it('subtracts pending vault withdrawal fees from the available balance', function () {
    $user = walletWithVaultTransaction(VaultTransactionStatus::Pending, 30);
    $service = app(WalletService::class);

    expect($service->getBalance($user))->toBe(100.0)
        ->and($service->getAvailableBalance($user))->toBe(70.0);
});

it('stops holding once the withdrawal is charged', function () {
    $user = walletWithVaultTransaction(VaultTransactionStatus::Completed, 30);

    expect(app(WalletService::class)->getAvailableBalance($user))->toBe(100.0);
});

it('stops holding when the withdrawal failed', function () {
    $user = walletWithVaultTransaction(VaultTransactionStatus::Failed, 30);

    expect(app(WalletService::class)->getAvailableBalance($user))->toBe(100.0);
});

it('does not hold another player vault fees against this user', function () {
    walletWithVaultTransaction(VaultTransactionStatus::Pending, 30);

    $service = app(WalletService::class);
    $other = User::factory()->create();
    $service->credit($service->getOrCreateWallet($other), 100, TransactionSource::AdminAward);

    expect($service->getAvailableBalance($other))->toBe(100.0);
});
