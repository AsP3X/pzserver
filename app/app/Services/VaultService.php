<?php

namespace App\Services;

use App\Enums\TransactionSource;
use App\Models\User;
use App\Models\Vault;
use App\Models\VaultItem;
use App\Models\VaultSetting;
use Illuminate\Support\Facades\DB;
use InvalidArgumentException;

/**
 * Owns the contents of a player's vault: capacity accounting and item storage.
 *
 * Knows nothing about coins or the Lua bridge — those live in
 * VaultDepositService and VaultWithdrawService.
 */
class VaultService
{
    public function __construct(private readonly WalletService $walletService) {}

    /**
     * Get the player's vault, creating it with the configured default capacity.
     */
    public function getOrCreateVault(User $user): Vault
    {
        $existing = Vault::query()->where('user_id', $user->id)->first();

        if ($existing !== null) {
            return $existing;
        }

        return Vault::query()->create([
            'user_id' => $user->id,
            'slot_capacity' => VaultSetting::instance()->default_slots,
        ]);
    }

    /**
     * Number of distinct stacks currently stored.
     */
    public function usedSlots(Vault $vault): int
    {
        return $vault->items()->count();
    }

    /**
     * Can this (type, condition) be stored? True if it merges into an existing
     * stack, or if there is a free slot.
     */
    public function hasFreeSlot(Vault $vault, string $fullType, float $condition): bool
    {
        $existing = $vault->items()
            ->where('full_type', $fullType)
            ->where('condition', $this->normalizeCondition($condition))
            ->exists();

        if ($existing) {
            return true;
        }

        return $this->usedSlots($vault) < $vault->slot_capacity;
    }

    /**
     * Add items to the vault, merging into a matching stack when one exists.
     */
    public function addItem(
        Vault $vault,
        string $fullType,
        string $name,
        string $category,
        float $condition,
        int $count,
    ): VaultItem {
        if ($count < 1) {
            throw new InvalidArgumentException('Count must be at least 1.');
        }

        $normalized = $this->normalizeCondition($condition);

        return DB::transaction(function () use ($vault, $fullType, $name, $category, $normalized, $count) {
            $item = $vault->items()
                ->where('full_type', $fullType)
                ->where('condition', $normalized)
                ->lockForUpdate()
                ->first();

            if ($item !== null) {
                $item->count += $count;
                $item->save();

                return $item;
            }

            if ($this->usedSlots($vault) >= $vault->slot_capacity) {
                throw new InvalidArgumentException('Vault is full.');
            }

            return $vault->items()->create([
                'full_type' => $fullType,
                'name' => $name,
                'category' => $category,
                'condition' => $normalized,
                'count' => $count,
            ]);
        });
    }

    /**
     * Take items out of the vault, deleting the stack when it empties.
     */
    public function takeItem(Vault $vault, string $fullType, float $condition, int $count): void
    {
        $normalized = $this->normalizeCondition($condition);

        DB::transaction(function () use ($vault, $fullType, $normalized, $count) {
            $item = $vault->items()
                ->where('full_type', $fullType)
                ->where('condition', $normalized)
                ->lockForUpdate()
                ->first();

            if ($item === null || $item->count < $count) {
                throw new InvalidArgumentException('Not enough items in the vault.');
            }

            $item->count -= $count;

            if ($item->count === 0) {
                $item->delete();

                return;
            }

            $item->save();
        });
    }

    /**
     * Buy one capacity increment with wallet coins.
     */
    public function purchaseSlots(User $user): Vault
    {
        $settings = VaultSetting::instance();
        $vault = $this->getOrCreateVault($user);

        $newCapacity = $vault->slot_capacity + $settings->slot_upgrade_increment;

        if ($newCapacity > $settings->max_slots) {
            throw new InvalidArgumentException('Vault is already at its maximum size.');
        }

        if ($this->walletService->getAvailableBalance($user) < $settings->slot_upgrade_cost) {
            throw new InvalidArgumentException('Insufficient available balance for the upgrade.');
        }

        return DB::transaction(function () use ($user, $vault, $settings, $newCapacity) {
            $this->walletService->debit(
                $this->walletService->getOrCreateWallet($user),
                (float) $settings->slot_upgrade_cost,
                TransactionSource::VaultUpgrade,
                "Vault capacity upgrade to {$newCapacity} slots",
                Vault::class,
                $vault->id,
            );

            $vault->slot_capacity = $newCapacity;
            $vault->save();

            return $vault;
        });
    }

    /**
     * Round to the 2 decimals the Lua exporter emits, so lookups match storage.
     */
    private function normalizeCondition(float $condition): float
    {
        return round(max(0.0, min(1.0, $condition)), 2);
    }
}
