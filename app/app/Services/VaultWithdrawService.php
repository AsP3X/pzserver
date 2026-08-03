<?php

namespace App\Services;

use App\Enums\TransactionSource;
use App\Enums\VaultDirection;
use App\Enums\VaultTransactionStatus;
use App\Models\User;
use App\Models\VaultSetting;
use App\Models\VaultTransaction;
use InvalidArgumentException;

/**
 * Deliver-then-debit withdrawal from a player's vault.
 *
 * Items are reserved out of the vault and delivered first; the coin fee is only
 * debited once Lua confirms delivery. A failed delivery returns the items at
 * their original condition and charges nothing.
 */
class VaultWithdrawService
{
    public function __construct(
        private readonly VaultService $vaultService,
        private readonly DeliveryQueueManager $deliveryQueue,
        private readonly OnlinePlayersReader $onlinePlayers,
        private readonly WalletService $walletService,
    ) {}

    /**
     * Fee for withdrawing `count` items.
     */
    public function feeFor(int $count): float
    {
        $settings = VaultSetting::instance();

        return round($settings->withdraw_fee_flat + ($settings->withdraw_fee_per_item * $count), 2);
    }

    /**
     * Reserve items and queue delivery. The fee is not charged yet.
     */
    public function requestWithdrawal(
        User $user,
        string $pzUsername,
        string $fullType,
        float $condition,
        int $count,
    ): VaultTransaction {
        if ($count < 1) {
            throw new InvalidArgumentException('Count must be at least 1.');
        }

        if (! in_array($pzUsername, $this->onlinePlayers->getOnlineUsernames(), true)) {
            throw new InvalidArgumentException('You must be online in-game to withdraw items.');
        }

        $fee = $this->feeFor($count);

        if ($this->walletService->getAvailableBalance($user) < $fee) {
            throw new InvalidArgumentException('Insufficient available balance for the withdrawal fee.');
        }

        $vault = $this->vaultService->getOrCreateVault($user);

        // Remember how the stack presented itself, so a failed delivery can be
        // restored as "Axe / Weapon" rather than "Base.Axe / General".
        $stack = $vault->items()
            ->where('full_type', $fullType)
            ->where('condition', round($condition, 2))
            ->first();

        $identity = [
            'name' => $stack->name ?? $fullType,
            'category' => $stack->category ?? 'General',
        ];

        // Reserve by removing from the vault up front; restored on failure.
        $this->vaultService->takeItem($vault, $fullType, $condition, $count);

        $entry = $this->deliveryQueue->giveItemWithCondition($pzUsername, $fullType, $count, $condition);

        return $vault->transactions()->create([
            'direction' => VaultDirection::Withdraw,
            'status' => VaultTransactionStatus::Pending,
            'full_type' => $fullType,
            'condition' => $condition,
            'requested_count' => $count,
            'actual_count' => 0,
            'fee_charged' => $fee,
            'delivery_id' => $entry['id'],
            'message' => json_encode($identity),
        ]);
    }

    /**
     * Settle pending withdrawals against Lua delivery results.
     *
     * @return list<string> IDs of transactions that were settled
     */
    public function processResults(): array
    {
        $pending = VaultTransaction::query()
            ->where('direction', VaultDirection::Withdraw->value)
            ->where('status', VaultTransactionStatus::Pending->value)
            ->whereNotNull('delivery_id')
            ->with('vault.user')
            ->get();

        if ($pending->isEmpty()) {
            return [];
        }

        $results = collect($this->deliveryQueue->readResults()['results'] ?? [])->keyBy('id');
        $settled = [];

        foreach ($pending as $transaction) {
            $result = $results->get($transaction->delivery_id);
            if ($result === null) {
                continue;
            }

            if (($result['status'] ?? '') === 'delivered') {
                $walletTransaction = $this->walletService->debit(
                    $this->walletService->getOrCreateWallet($transaction->vault->user),
                    (float) $transaction->fee_charged,
                    TransactionSource::VaultFee,
                    "Vault withdrawal fee for {$transaction->requested_count}x {$transaction->full_type}",
                    VaultTransaction::class,
                    $transaction->id,
                );

                $transaction->wallet_transaction_id = $walletTransaction->id;
                $transaction->actual_count = $transaction->requested_count;
                $transaction->status = VaultTransactionStatus::Completed;
                $transaction->save();

                $settled[] = $transaction->id;

                continue;
            }

            // Delivery failed — put the reserved items back, charge nothing.
            $identity = json_decode((string) $transaction->message, true);

            $this->vaultService->addItem(
                $transaction->vault,
                $transaction->full_type,
                is_array($identity) ? ($identity['name'] ?? $transaction->full_type) : $transaction->full_type,
                is_array($identity) ? ($identity['category'] ?? 'General') : 'General',
                (float) $transaction->condition,
                $transaction->requested_count,
            );

            $transaction->status = VaultTransactionStatus::Failed;
            $transaction->message = $result['message'] ?? 'Delivery failed';
            $transaction->save();

            $settled[] = $transaction->id;
        }

        return $settled;
    }
}
