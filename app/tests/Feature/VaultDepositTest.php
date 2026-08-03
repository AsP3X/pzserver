<?php

use App\Enums\VaultTransactionStatus;
use App\Models\User;
use App\Models\Vault;
use App\Services\DeliveryQueueManager;
use App\Services\VaultDepositService;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

function mockVaultQueue(array $results = []): void
{
    $queue = Mockery::mock(DeliveryQueueManager::class);
    $queue->shouldReceive('removeItemVerified')
        ->andReturnUsing(fn (string $u, string $t, int $c) => [
            'id' => 'delivery-1', 'action' => 'remove_verified', 'username' => $u,
            'item_type' => $t, 'count' => $c, 'status' => 'pending', 'created_at' => date('c'),
        ])->byDefault();
    $queue->shouldReceive('readResults')
        ->andReturn(['version' => 1, 'updated_at' => '', 'results' => $results])
        ->byDefault();

    app()->instance(DeliveryQueueManager::class, $queue);
}

it('queues a removal and records a pending transaction', function () {
    mockVaultQueue();
    $user = User::factory()->create();

    $tx = app(VaultDepositService::class)->requestDeposit($user, 'Player1', 'Base.Axe', 'Axe', 'Weapon', 2);

    expect($tx->status)->toBe(VaultTransactionStatus::Pending)
        ->and($tx->requested_count)->toBe(2)
        ->and($tx->delivery_id)->toBe('delivery-1');
});

it('credits the vault with exactly what Lua reported removing', function () {
    mockVaultQueue([[
        'id' => 'delivery-1',
        'status' => 'delivered',
        'processed_at' => date('c'),
        'message' => null,
        'removed_count' => 2,
        'removed' => [
            ['full_type' => 'Base.Axe', 'name' => 'Axe', 'category' => 'Weapon', 'condition' => 0.85],
            ['full_type' => 'Base.Axe', 'name' => 'Axe', 'category' => 'Weapon', 'condition' => 1.0],
        ],
    ]]);

    $user = User::factory()->create();
    $service = app(VaultDepositService::class);
    $tx = $service->requestDeposit($user, 'Player1', 'Base.Axe', 'Axe', 'Weapon', 2);

    $service->processResults();

    $tx->refresh();
    $vault = Vault::query()->where('user_id', $user->id)->first();

    expect($tx->status)->toBe(VaultTransactionStatus::Completed)
        ->and($tx->actual_count)->toBe(2)
        ->and($vault->items()->count())->toBe(2);
});

it('credits a partial removal rather than losing the items', function () {
    mockVaultQueue([[
        'id' => 'delivery-1',
        'status' => 'delivered',
        'processed_at' => date('c'),
        'message' => null,
        'removed_count' => 1,
        'removed' => [
            ['full_type' => 'Base.Axe', 'name' => 'Axe', 'category' => 'Weapon', 'condition' => 1.0],
        ],
    ]]);

    $user = User::factory()->create();
    $service = app(VaultDepositService::class);
    $tx = $service->requestDeposit($user, 'Player1', 'Base.Axe', 'Axe', 'Weapon', 5);

    $service->processResults();

    $tx->refresh();
    $vault = Vault::query()->where('user_id', $user->id)->first();

    expect($tx->status)->toBe(VaultTransactionStatus::Partial)
        ->and($tx->actual_count)->toBe(1)
        ->and($vault->items()->sum('count'))->toBe(1);
});

it('marks the transaction failed when nothing was removed', function () {
    mockVaultQueue([[
        'id' => 'delivery-1', 'status' => 'failed', 'processed_at' => date('c'),
        'message' => 'player not online', 'removed_count' => 0, 'removed' => [],
    ]]);

    $user = User::factory()->create();
    $service = app(VaultDepositService::class);
    $tx = $service->requestDeposit($user, 'Player1', 'Base.Axe', 'Axe', 'Weapon', 1);

    $service->processResults();

    $tx->refresh();
    expect($tx->status)->toBe(VaultTransactionStatus::Failed)
        ->and($tx->actual_count)->toBe(0);
});

it('leaves the transaction pending while Lua has not reported yet', function () {
    mockVaultQueue();

    $user = User::factory()->create();
    $service = app(VaultDepositService::class);
    $tx = $service->requestDeposit($user, 'Player1', 'Base.Axe', 'Axe', 'Weapon', 1);

    expect($service->processResults())->toBe([]);

    $tx->refresh();
    expect($tx->status)->toBe(VaultTransactionStatus::Pending);
});

it('does not double-credit when results are processed twice', function () {
    mockVaultQueue([[
        'id' => 'delivery-1', 'status' => 'delivered', 'processed_at' => date('c'), 'message' => null,
        'removed_count' => 1,
        'removed' => [['full_type' => 'Base.Axe', 'name' => 'Axe', 'category' => 'Weapon', 'condition' => 1.0]],
    ]]);

    $user = User::factory()->create();
    $service = app(VaultDepositService::class);
    $service->requestDeposit($user, 'Player1', 'Base.Axe', 'Axe', 'Weapon', 1);

    $service->processResults();
    $service->processResults();

    $vault = Vault::query()->where('user_id', $user->id)->first();
    expect($vault->items()->sum('count'))->toBe(1);
});

it('rejects a count below one', function () {
    mockVaultQueue();
    $user = User::factory()->create();

    expect(fn () => app(VaultDepositService::class)->requestDeposit($user, 'Player1', 'Base.Axe', 'Axe', 'Weapon', 0))
        ->toThrow(InvalidArgumentException::class);
});
