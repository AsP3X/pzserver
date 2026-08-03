<?php

namespace App\Services;

use App\Enums\VaultDirection;
use App\Enums\VaultTransactionStatus;
use App\Models\User;
use App\Models\VaultTransaction;
use Illuminate\Support\Facades\Log;
use InvalidArgumentException;

/**
 * Items-first deposit into a player's vault.
 *
 * Items leave the game inventory before anything is credited, and the vault is
 * credited with exactly what Lua reports removing — including on a partial
 * removal, so a player never loses items without getting them back.
 */
class VaultDepositService
{
    public function __construct(
        private readonly VaultService $vaultService,
        private readonly DeliveryQueueManager $deliveryQueue,
    ) {}

    /**
     * Queue a removal from the game inventory and record a pending deposit.
     */
    public function requestDeposit(
        User $user,
        string $pzUsername,
        string $fullType,
        string $name,
        string $category,
        int $count,
    ): VaultTransaction {
        if ($count < 1) {
            throw new InvalidArgumentException('Count must be at least 1.');
        }

        $vault = $this->vaultService->getOrCreateVault($user);

        $entry = $this->deliveryQueue->removeItemVerified($pzUsername, $fullType, $count);

        return $vault->transactions()->create([
            'direction' => VaultDirection::Deposit,
            'status' => VaultTransactionStatus::Pending,
            'full_type' => $fullType,
            'condition' => 1.0,
            'requested_count' => $count,
            'actual_count' => 0,
            'fee_charged' => 0,
            'delivery_id' => $entry['id'],
            'message' => json_encode(['name' => $name, 'category' => $category]),
        ]);
    }

    /**
     * Match Lua results to pending deposits and credit the vault.
     *
     * Only pending transactions are considered, so replaying the same result
     * file cannot credit a deposit twice.
     *
     * @return list<string> IDs of transactions that were settled
     */
    public function processResults(): array
    {
        $pending = VaultTransaction::query()
            ->where('direction', VaultDirection::Deposit->value)
            ->where('status', VaultTransactionStatus::Pending->value)
            ->whereNotNull('delivery_id')
            ->with('vault')
            ->get();

        if ($pending->isEmpty()) {
            return [];
        }

        $results = collect($this->deliveryQueue->readResults()['results'] ?? [])
            ->keyBy('id');

        $settled = [];

        foreach ($pending as $transaction) {
            $result = $results->get($transaction->delivery_id);
            if ($result === null) {
                continue;
            }

            $removed = $result['removed'] ?? [];
            $removedCount = (int) ($result['removed_count'] ?? count($removed));

            foreach ($removed as $item) {
                try {
                    $this->vaultService->addItem(
                        $transaction->vault,
                        (string) ($item['full_type'] ?? $transaction->full_type),
                        (string) ($item['name'] ?? $transaction->full_type),
                        (string) ($item['category'] ?? 'General'),
                        (float) ($item['condition'] ?? 1.0),
                        1,
                    );
                } catch (InvalidArgumentException $e) {
                    Log::warning('[Vault] Could not store deposited item', [
                        'transaction' => $transaction->id,
                        'error' => $e->getMessage(),
                    ]);
                }
            }

            $transaction->actual_count = $removedCount;
            $transaction->status = match (true) {
                $removedCount === 0 => VaultTransactionStatus::Failed,
                $removedCount < $transaction->requested_count => VaultTransactionStatus::Partial,
                default => VaultTransactionStatus::Completed,
            };
            $transaction->save();

            $settled[] = $transaction->id;
        }

        return $settled;
    }
}
