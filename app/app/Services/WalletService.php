<?php

namespace App\Services;

use App\Enums\TransactionSource;
use App\Enums\TransactionType;
use App\Exceptions\InsufficientBalanceException;
use App\Enums\DeliveryStatus;
use App\Models\ShopPurchase;
use App\Models\User;
use App\Models\Wallet;
use App\Models\WalletTransaction;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;
use Illuminate\Support\Facades\DB;

class WalletService
{
    /**
     * Get or lazily create a wallet for the user.
     */
    public function getOrCreateWallet(User $user): Wallet
    {
        return $user->wallet ?? $user->wallet()->create([
            'balance' => 0,
            'total_earned' => 0,
            'total_spent' => 0,
        ]);
    }

    /**
     * Credit currency to a wallet.
     */
    public function credit(
        Wallet $wallet,
        float $amount,
        TransactionSource $source,
        ?string $description = null,
        ?string $referenceType = null,
        ?string $referenceId = null,
        ?array $metadata = null,
    ): WalletTransaction {
        return DB::transaction(function () use ($wallet, $amount, $source, $description, $referenceType, $referenceId, $metadata) {
            $wallet = Wallet::query()->lockForUpdate()->find($wallet->id);

            $wallet->balance = (float) $wallet->balance + $amount;
            $wallet->total_earned = (float) $wallet->total_earned + $amount;
            $wallet->save();

            return $wallet->transactions()->create([
                'type' => TransactionType::Credit,
                'amount' => $amount,
                'balance_after' => $wallet->balance,
                'source' => $source,
                'reference_type' => $referenceType,
                'reference_id' => $referenceId,
                'description' => $description,
                'metadata' => $metadata,
            ]);
        });
    }

    /**
     * Debit currency from a wallet.
     *
     * @throws InsufficientBalanceException
     */
    public function debit(
        Wallet $wallet,
        float $amount,
        TransactionSource $source,
        ?string $description = null,
        ?string $referenceType = null,
        ?string $referenceId = null,
        ?array $metadata = null,
    ): WalletTransaction {
        return DB::transaction(function () use ($wallet, $amount, $source, $description, $referenceType, $referenceId, $metadata) {
            $wallet = Wallet::query()->lockForUpdate()->find($wallet->id);

            if ((float) $wallet->balance < $amount) {
                throw new InsufficientBalanceException((float) $wallet->balance, $amount);
            }

            $wallet->balance = (float) $wallet->balance - $amount;
            $wallet->total_spent = (float) $wallet->total_spent + $amount;
            $wallet->save();

            return $wallet->transactions()->create([
                'type' => TransactionType::Debit,
                'amount' => $amount,
                'balance_after' => $wallet->balance,
                'source' => $source,
                'reference_type' => $referenceType,
                'reference_id' => $referenceId,
                'description' => $description,
                'metadata' => $metadata,
            ]);
        });
    }

    /**
     * Refund a purchase back to the wallet.
     */
    public function refund(ShopPurchase $purchase): WalletTransaction
    {
        $wallet = $this->getOrCreateWallet($purchase->user);

        return $this->credit(
            $wallet,
            (float) $purchase->total_price,
            TransactionSource::Refund,
            "Refund for purchase #{$purchase->id}",
            ShopPurchase::class,
            $purchase->id,
        );
    }

    /**
     * Reset a wallet balance to zero.
     */
    public function resetBalance(Wallet $wallet, ?string $description = null): ?WalletTransaction
    {
        return DB::transaction(function () use ($wallet, $description) {
            $wallet = Wallet::query()->lockForUpdate()->find($wallet->id);

            $currentBalance = (float) $wallet->balance;

            if ($currentBalance <= 0) {
                $wallet->balance = 0;
                $wallet->save();

                return null;
            }

            $wallet->balance = 0;
            $wallet->save();

            return $wallet->transactions()->create([
                'type' => TransactionType::Debit,
                'amount' => $currentBalance,
                'balance_after' => 0,
                'source' => TransactionSource::AdminReset,
                'description' => $description ?? 'Balance reset by admin',
            ]);
        });
    }

    /**
     * Get current balance for a user.
     */
    public function getBalance(User $user): float
    {
        return (float) ($user->wallet()->value('balance') ?? 0);
    }

    /**
     * Get available balance (actual balance minus pending purchase holds).
     *
     * Pending purchases that haven't been debited yet (wallet_transaction_id is null)
     * still "hold" their total_price from the available balance to prevent double-spending.
     */
    public function getAvailableBalance(User $user): float
    {
        $balance = $this->getBalance($user);

        $pendingHolds = (float) ShopPurchase::query()
            ->where('user_id', $user->id)
            ->whereNull('wallet_transaction_id')
            ->whereNotIn('delivery_status', [
                DeliveryStatus::Failed->value,
                DeliveryStatus::Delivered->value,
            ])
            ->sum('total_price');

        return max(0, $balance - $pendingHolds);
    }

    /**
     * Get paginated transaction history for a user.
     */
    public function getTransactionHistory(User $user, int $perPage = 20): LengthAwarePaginator
    {
        $wallet = $user->wallet;

        if (! $wallet) {
            return new \Illuminate\Pagination\LengthAwarePaginator([], 0, $perPage);
        }

        return $wallet->transactions()
            ->orderByDesc('created_at')
            ->paginate($perPage);
    }
}
