<?php

namespace App\Services;

use App\Enums\DeliveryStatus;
use App\Enums\TransactionSource;
use App\Exceptions\InsufficientBalanceException;
use App\Models\ShopDelivery;
use App\Models\ShopPurchase;
use Illuminate\Support\Facades\Log;

class ShopDeliveryService
{
    public function __construct(
        private readonly DeliveryQueueManager $deliveryQueue,
        private readonly WalletService $walletService,
    ) {}

    /**
     * Deliver all items for a purchase.
     *
     * Uses RCON for online players (items appear and work immediately).
     * Falls back to Lua queue for offline players (delivered on next login).
     * Wallet is debited only after delivery is confirmed.
     */
    public function queueDeliveries(ShopPurchase $purchase): void
    {
        $user = $purchase->user;
        $whitelistEntry = $user->whitelistEntries()->where('active', true)->first();

        if (! $whitelistEntry) {
            $purchase->deliveries()->update([
                'status' => DeliveryStatus::Failed,
                'error_message' => 'No active whitelist entry found for user',
            ]);
            $purchase->update(['delivery_status' => DeliveryStatus::Failed]);

            return;
        }

        $pzUsername = $whitelistEntry->pz_username;
        $allDeliveredViaRcon = true;

        foreach ($purchase->deliveries as $delivery) {
            if (! in_array($delivery->status, [DeliveryStatus::Pending, DeliveryStatus::Failed])) {
                continue;
            }

            // Try RCON first — items appear and work immediately for online players
            $entry = $this->deliveryQueue->giveItem($pzUsername, $delivery->item_type, $delivery->quantity);

            if ($entry['status'] === 'delivered') {
                // RCON succeeded — item is in the player's inventory and fully usable
                $delivery->update([
                    'username' => $pzUsername,
                    'status' => DeliveryStatus::Delivered,
                    'delivered_at' => now(),
                    'attempts' => $delivery->attempts + 1,
                    'last_attempt_at' => now(),
                ]);
            } else {
                // RCON failed (player offline) — queued to Lua for later delivery
                $allDeliveredViaRcon = false;
                $delivery->update([
                    'username' => $pzUsername,
                    'delivery_queue_id' => $entry['id'],
                    'status' => DeliveryStatus::Queued,
                    'attempts' => $delivery->attempts + 1,
                    'last_attempt_at' => now(),
                ]);
            }
        }

        $this->updatePurchaseStatuses();
        $purchase->refresh();

        if ($purchase->delivery_status === DeliveryStatus::Pending) {
            $purchase->update(['delivery_status' => DeliveryStatus::Queued]);
        }

        // If all deliveries succeeded via RCON, finalize immediately (debit wallet)
        if ($allDeliveredViaRcon && $this->isReadyForDebit($purchase)) {
            $this->finalizeVerifiedPurchase($purchase);
        }
    }

    /**
     * Process delivery results from Lua and update delivery records.
     * When all deliveries for a purchase are confirmed, debit the wallet.
     *
     * @return int Number of results processed
     */
    public function processResults(): int
    {
        $results = $this->deliveryQueue->readResults();
        $processed = 0;
        $affectedPurchaseIds = [];

        foreach ($results['results'] ?? [] as $result) {
            $delivery = ShopDelivery::query()
                ->where('delivery_queue_id', $result['id'])
                ->first();

            if (! $delivery) {
                continue;
            }

            if ($result['status'] === 'delivered') {
                $delivery->update([
                    'status' => DeliveryStatus::Delivered,
                    'delivered_at' => now(),
                    'error_message' => null,
                ]);
            } else {
                $delivery->update([
                    'status' => DeliveryStatus::Failed,
                    'error_message' => $result['message'] ?? 'Delivery failed',
                ]);
            }

            $affectedPurchaseIds[] = $delivery->shop_purchase_id;
            $processed++;
        }

        if ($processed > 0) {
            $this->updatePurchaseStatuses();

            // Finalize purchases where all deliveries are confirmed
            $uniquePurchaseIds = array_unique($affectedPurchaseIds);
            foreach ($uniquePurchaseIds as $purchaseId) {
                $purchase = ShopPurchase::query()->with('deliveries')->find($purchaseId);
                if ($purchase && $this->isReadyForDebit($purchase)) {
                    $this->finalizeVerifiedPurchase($purchase);
                }
            }
        }

        return $processed;
    }

    /**
     * Retry pending/failed deliveries that are stale (>5 min, <10 attempts).
     *
     * @return int Number of deliveries retried
     */
    public function retryPending(): int
    {
        $staleDeliveries = ShopDelivery::query()
            ->whereIn('status', [DeliveryStatus::Pending, DeliveryStatus::Failed])
            ->where('attempts', '<', 10)
            ->where(function ($q) {
                $q->whereNull('last_attempt_at')
                    ->orWhere('last_attempt_at', '<', now()->subMinutes(5));
            })
            ->with('purchase.user.whitelistEntries')
            ->get();

        $retried = 0;

        foreach ($staleDeliveries as $delivery) {
            $purchase = $delivery->purchase;
            $whitelistEntry = $purchase->user->whitelistEntries()->where('active', true)->first();

            if (! $whitelistEntry) {
                continue;
            }

            $entry = $this->deliveryQueue->giveItem(
                $whitelistEntry->pz_username,
                $delivery->item_type,
                $delivery->quantity,
            );

            if ($entry['status'] === 'delivered') {
                $delivery->update([
                    'username' => $whitelistEntry->pz_username,
                    'status' => DeliveryStatus::Delivered,
                    'delivered_at' => now(),
                    'attempts' => $delivery->attempts + 1,
                    'last_attempt_at' => now(),
                    'error_message' => null,
                ]);

                // Check if this completes the purchase
                $purchase->refresh();
                $purchase->load('deliveries');
                if ($this->isReadyForDebit($purchase)) {
                    $this->finalizeVerifiedPurchase($purchase);
                }
            } else {
                $delivery->update([
                    'username' => $whitelistEntry->pz_username,
                    'delivery_queue_id' => $entry['id'],
                    'status' => DeliveryStatus::Queued,
                    'attempts' => $delivery->attempts + 1,
                    'last_attempt_at' => now(),
                    'error_message' => null,
                ]);
            }

            $retried++;
        }

        return $retried;
    }

    /**
     * Check if a purchase is ready for wallet debit (all deliveries confirmed).
     */
    private function isReadyForDebit(ShopPurchase $purchase): bool
    {
        // Already debited
        if ($purchase->wallet_transaction_id !== null) {
            return false;
        }

        // All deliveries must be delivered
        return $purchase->deliveries->every(
            fn ($d) => $d->status === DeliveryStatus::Delivered
        );
    }

    /**
     * Finalize a confirmed purchase: debit wallet and link transaction.
     */
    private function finalizeVerifiedPurchase(ShopPurchase $purchase): void
    {
        try {
            $wallet = $this->walletService->getOrCreateWallet($purchase->user);

            $itemName = $purchase->metadata['item_name']
                ?? $purchase->purchasable?->name
                ?? 'shop item';

            $transaction = $this->walletService->debit(
                $wallet,
                (float) $purchase->total_price,
                TransactionSource::Purchase,
                "Purchased {$purchase->quantity_bought}x {$itemName}",
            );

            $purchase->update([
                'wallet_transaction_id' => $transaction->id,
            ]);

            Log::info("[ShopDelivery] Purchase {$purchase->id} finalized: debited {$purchase->total_price}");
        } catch (InsufficientBalanceException $e) {
            // Balance dropped below purchase price during async window — rollback items
            Log::warning("[ShopDelivery] Debit failed for purchase {$purchase->id}: {$e->getMessage()}, rolling back delivered items");
            $this->rollbackDeliveredItems($purchase);
        }
    }

    /**
     * Rollback delivered items by queuing removal for each delivery.
     * Marks purchase as failed.
     */
    private function rollbackDeliveredItems(ShopPurchase $purchase): void
    {
        $user = $purchase->user;
        $whitelistEntry = $user->whitelistEntries()->where('active', true)->first();

        if (! $whitelistEntry) {
            Log::error("[ShopDelivery] Cannot rollback purchase {$purchase->id}: no whitelist entry");
            $purchase->update(['delivery_status' => DeliveryStatus::Failed]);

            return;
        }

        foreach ($purchase->deliveries as $delivery) {
            if ($delivery->status === DeliveryStatus::Delivered) {
                $this->deliveryQueue->removeItem(
                    $whitelistEntry->pz_username,
                    $delivery->item_type,
                    $delivery->quantity,
                );
            }
        }

        $purchase->deliveries()->update([
            'status' => DeliveryStatus::Failed,
            'error_message' => 'Rolled back: insufficient balance after delivery',
        ]);

        $purchase->update(['delivery_status' => DeliveryStatus::Failed]);

        Log::info("[ShopDelivery] Purchase {$purchase->id} rolled back: items queued for removal");
    }

    /**
     * Update parent purchase delivery statuses based on child deliveries.
     */
    private function updatePurchaseStatuses(): void
    {
        $purchaseIds = ShopDelivery::query()
            ->whereIn('status', [DeliveryStatus::Delivered, DeliveryStatus::Failed])
            ->pluck('shop_purchase_id')
            ->unique();

        foreach ($purchaseIds as $purchaseId) {
            $purchase = ShopPurchase::query()->with('deliveries')->find($purchaseId);
            if (! $purchase) {
                continue;
            }

            $statuses = $purchase->deliveries->pluck('status');

            if ($statuses->every(fn ($s) => $s === DeliveryStatus::Delivered)) {
                $purchase->update([
                    'delivery_status' => DeliveryStatus::Delivered,
                    'delivered_at' => now(),
                ]);
            } elseif ($statuses->contains(DeliveryStatus::Delivered) && $statuses->contains(DeliveryStatus::Failed)) {
                $purchase->update(['delivery_status' => DeliveryStatus::PartiallyDelivered]);
            } elseif ($statuses->every(fn ($s) => $s === DeliveryStatus::Failed)) {
                $purchase->update(['delivery_status' => DeliveryStatus::Failed]);
            }
        }
    }
}
