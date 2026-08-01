<?php

namespace App\Http\Controllers;

use App\Exceptions\InsufficientBalanceException;
use App\Http\Requests\PurchaseItemRequest;
use App\Models\ShopBundle;
use App\Models\ShopCategory;
use App\Models\ShopItem;
use App\Models\ShopPromotion;
use App\Models\ShopPurchase;
use App\Models\WhitelistEntry;
use App\Services\InventoryReader;
use App\Services\ItemIconResolver;
use App\Services\MoneyDepositManager;
use App\Services\OnlinePlayersReader;
use App\Services\PromotionEngine;
use App\Services\ShopDeliveryService;
use App\Services\ShopPurchaseService;
use App\Services\WalletService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

class ShopController extends Controller
{
    public function __construct(
        private readonly ShopPurchaseService $purchaseService,
        private readonly WalletService $walletService,
        private readonly PromotionEngine $promotionEngine,
        private readonly ItemIconResolver $iconResolver,
        private readonly MoneyDepositManager $depositManager,
        private readonly OnlinePlayersReader $onlinePlayersReader,
        private readonly InventoryReader $inventoryReader,
        private readonly ShopDeliveryService $deliveryService,
    ) {}

    /**
     * Browse the shop — categories, featured items, all items.
     */
    public function index(): Response
    {
        $categories = ShopCategory::query()
            ->where('is_active', true)
            ->orderBy('sort_order')
            ->get();

        $items = ShopItem::query()
            ->where('is_active', true)
            ->with('category')
            ->orderByDesc('is_featured')
            ->orderBy('name')
            ->get()
            ->map(fn (ShopItem $item) => [
                ...$item->toArray(),
                'icon' => $this->iconResolver->resolve($item->item_type),
            ]);

        $bundles = ShopBundle::query()
            ->where('is_active', true)
            ->with('items')
            ->orderByDesc('is_featured')
            ->get()
            ->map(fn (ShopBundle $bundle) => [
                ...$bundle->toArray(),
                'items' => $bundle->items->map(fn ($item) => [
                    ...$item->toArray(),
                    'icon' => $this->iconResolver->resolve($item->item_type),
                ]),
            ]);

        $activePromotions = ShopPromotion::query()
            ->whereNotNull('code')
            ->where('is_active', true)
            ->where('starts_at', '<=', now())
            ->where(fn ($q) => $q->whereNull('ends_at')->orWhere('ends_at', '>', now()))
            ->get(['name', 'code', 'type', 'value', 'ends_at']);

        $user = request()->user();
        $balance = $user ? $this->walletService->getBalance($user) : null;
        $availableBalance = $user ? $this->walletService->getAvailableBalance($user) : null;

        $hasPzAccount = false;
        $pendingDeposit = false;
        $lastDepositResult = null;

        if ($user) {
            $whitelistEntry = WhitelistEntry::query()
                ->where('user_id', $user->id)
                ->where('active', true)
                ->first();

            $hasPzAccount = $whitelistEntry !== null;

            if ($hasPzAccount) {
                $pendingDeposit = $this->depositManager->hasPendingRequest($whitelistEntry->pz_username);
                $lastDepositResult = $this->depositManager->getLastResult($whitelistEntry->pz_username);
            }
        }

        return Inertia::render('shop/index', [
            'categories' => $categories,
            'items' => $items,
            'bundles' => $bundles,
            'balance' => $balance,
            'availableBalance' => $availableBalance,
            'activePromotions' => $activePromotions,
            'hasPzAccount' => $hasPzAccount,
            'pendingDeposit' => $pendingDeposit,
            'lastDepositResult' => $lastDepositResult,
        ]);
    }

    /**
     * Show a single shop item detail.
     */
    public function show(string $slug): Response
    {
        $item = ShopItem::query()
            ->where('slug', $slug)
            ->where('is_active', true)
            ->with('category')
            ->firstOrFail();

        $user = request()->user();
        $balance = $user ? $this->walletService->getBalance($user) : null;

        return Inertia::render('shop/item', [
            'item' => [
                ...$item->toArray(),
                'icon' => $this->iconResolver->resolve($item->item_type),
            ],
            'balance' => $balance,
        ]);
    }

    /**
     * Purchase a shop item.
     */
    public function purchaseItem(PurchaseItemRequest $request, string $slug): JsonResponse
    {
        $item = ShopItem::query()
            ->where('slug', $slug)
            ->where('is_active', true)
            ->firstOrFail();

        $validated = $request->validated();
        $quantity = $validated['quantity'] ?? 1;

        // Verify player is online — items can only be delivered to online players
        $whitelistEntry = WhitelistEntry::query()
            ->where('user_id', $request->user()->id)
            ->where('active', true)
            ->first();

        if (! $whitelistEntry) {
            return response()->json(['error' => 'No linked PZ account found. Link your account first.'], 422);
        }

        $onlinePlayers = $this->onlinePlayersReader->getOnlineUsernames();
        if (! in_array($whitelistEntry->pz_username, $onlinePlayers, true)) {
            return response()->json(['error' => 'You must be online in-game to purchase items.'], 422);
        }

        // Best-effort inventory weight check
        if ($item->weight !== null) {
            $inventory = $this->inventoryReader->getPlayerInventory($whitelistEntry->pz_username);
            if ($inventory) {
                $currentWeight = (float) ($inventory['weight'] ?? 0);
                $maxWeight = (float) ($inventory['max_weight'] ?? 15);
                $addedWeight = (float) $item->weight * $item->quantity * $quantity;
                if ($currentWeight + $addedWeight > $maxWeight) {
                    $freeSpace = max(0, $maxWeight - $currentWeight);

                    return response()->json([
                        'error' => "Not enough inventory space. You have {$freeSpace} / {$maxWeight} kg free, but this purchase would add {$addedWeight} kg.",
                    ], 422);
                }
            }
        }

        $promotion = null;
        if (! empty($validated['promotion_code'])) {
            $promotion = ShopPromotion::query()
                ->where('code', strtoupper($validated['promotion_code']))
                ->first();
        }

        try {
            $purchase = $this->purchaseService->purchaseItem(
                $request->user(),
                $item,
                $quantity,
                $promotion,
            );

            return response()->json([
                'message' => "Delivering {$quantity}x {$item->name}...",
                'purchase_id' => $purchase->id,
                'balance' => $this->walletService->getBalance($request->user()),
                'availableBalance' => $this->walletService->getAvailableBalance($request->user()),
            ]);
        } catch (InsufficientBalanceException $e) {
            return response()->json([
                'error' => 'Insufficient balance',
                'balance' => $e->balance,
                'required' => $e->required,
            ], 422);
        } catch (\InvalidArgumentException $e) {
            return response()->json(['error' => $e->getMessage()], 422);
        }
    }

    /**
     * Show a bundle detail.
     */
    public function showBundle(string $slug): Response
    {
        $bundle = ShopBundle::query()
            ->where('slug', $slug)
            ->where('is_active', true)
            ->with('items')
            ->firstOrFail();

        $user = request()->user();
        $balance = $user ? $this->walletService->getBalance($user) : null;

        return Inertia::render('shop/item', [
            'bundle' => [
                ...$bundle->toArray(),
                'items' => $bundle->items->map(fn ($item) => [
                    ...$item->toArray(),
                    'icon' => $this->iconResolver->resolve($item->item_type),
                ]),
            ],
            'balance' => $balance,
        ]);
    }

    /**
     * Purchase a bundle.
     */
    public function purchaseBundle(PurchaseItemRequest $request, string $slug): JsonResponse
    {
        $bundle = ShopBundle::query()
            ->where('slug', $slug)
            ->where('is_active', true)
            ->with('items')
            ->firstOrFail();

        $validated = $request->validated();

        // Verify player is online — items can only be delivered to online players
        $whitelistEntry = WhitelistEntry::query()
            ->where('user_id', $request->user()->id)
            ->where('active', true)
            ->first();

        if (! $whitelistEntry) {
            return response()->json(['error' => 'No linked PZ account found. Link your account first.'], 422);
        }

        $onlinePlayers = $this->onlinePlayersReader->getOnlineUsernames();
        if (! in_array($whitelistEntry->pz_username, $onlinePlayers, true)) {
            return response()->json(['error' => 'You must be online in-game to purchase items.'], 422);
        }

        // Best-effort inventory weight check for bundles
        $totalBundleWeight = 0;
        $hasWeightData = false;
        foreach ($bundle->items as $bundleItem) {
            if ($bundleItem->weight !== null) {
                $hasWeightData = true;
                $totalBundleWeight += (float) $bundleItem->weight * $bundleItem->pivot->quantity;
            }
        }

        if ($hasWeightData && $totalBundleWeight > 0) {
            $inventory = $this->inventoryReader->getPlayerInventory($whitelistEntry->pz_username);
            if ($inventory) {
                $currentWeight = (float) ($inventory['weight'] ?? 0);
                $maxWeight = (float) ($inventory['max_weight'] ?? 15);
                if ($currentWeight + $totalBundleWeight > $maxWeight) {
                    $freeSpace = max(0, $maxWeight - $currentWeight);

                    return response()->json([
                        'error' => "Not enough inventory space. You have {$freeSpace} / {$maxWeight} kg free, but this bundle would add {$totalBundleWeight} kg.",
                    ], 422);
                }
            }
        }

        $promotion = null;
        if (! empty($validated['promotion_code'])) {
            $promotion = ShopPromotion::query()
                ->where('code', strtoupper($validated['promotion_code']))
                ->first();
        }

        try {
            $purchase = $this->purchaseService->purchaseBundle(
                $request->user(),
                $bundle,
                $promotion,
            );

            return response()->json([
                'message' => "Delivering bundle: {$bundle->name}...",
                'purchase_id' => $purchase->id,
                'balance' => $this->walletService->getBalance($request->user()),
                'availableBalance' => $this->walletService->getAvailableBalance($request->user()),
            ]);
        } catch (InsufficientBalanceException $e) {
            return response()->json([
                'error' => 'Insufficient balance',
                'balance' => $e->balance,
                'required' => $e->required,
            ], 422);
        } catch (\InvalidArgumentException $e) {
            return response()->json(['error' => $e->getMessage()], 422);
        }
    }

    /**
     * Show player's purchase history.
     */
    public function myPurchases(): Response
    {
        $purchases = request()->user()->shopPurchases()
            ->with(['deliveries', 'purchasable'])
            ->orderByDesc('created_at')
            ->paginate(20);

        return Inertia::render('shop/my-purchases', [
            'purchases' => $purchases,
            'balance' => $this->walletService->getBalance(request()->user()),
        ]);
    }

    /**
     * Request an in-game money deposit.
     */
    public function requestDeposit(Request $request): JsonResponse
    {
        $user = $request->user();

        $whitelistEntry = WhitelistEntry::query()
            ->where('user_id', $user->id)
            ->where('active', true)
            ->first();

        if (! $whitelistEntry) {
            return response()->json(['error' => 'No linked PZ account found'], 422);
        }

        if ($this->depositManager->hasPendingRequest($whitelistEntry->pz_username)) {
            return response()->json(['error' => 'A deposit request is already pending'], 422);
        }

        // Check if the player is currently online in-game before creating the request
        $onlinePlayers = $this->onlinePlayersReader->getOnlineUsernames();
        if (! in_array($whitelistEntry->pz_username, $onlinePlayers, true)) {
            return response()->json(['error' => 'You must be online in-game to deposit money. Log in to the server and try again.'], 422);
        }

        $entry = $this->depositManager->createRequest($whitelistEntry->pz_username);

        return response()->json([
            'message' => 'Deposit request created. Make sure you are online in-game — your money will be collected within ~15 seconds.',
            'request_id' => $entry['id'],
        ]);
    }

    /**
     * Poll endpoint for deposit status (used by frontend polling).
     * Also processes deposit results inline for near-instant wallet crediting.
     */
    public function depositStatus(Request $request): JsonResponse
    {
        $user = $request->user();

        $whitelistEntry = WhitelistEntry::query()
            ->where('user_id', $user->id)
            ->where('active', true)
            ->first();

        if (! $whitelistEntry) {
            return response()->json([
                'pendingDeposit' => false,
                'lastDepositResult' => null,
                'balance' => $this->walletService->getBalance($user),
            ]);
        }

        // Process any available deposit results inline for instant wallet crediting
        $creditedIds = $this->depositManager->processResults($this->walletService);
        if (count($creditedIds) > 0) {
            $this->depositManager->removeProcessedResults($creditedIds);
        }

        return response()->json([
            'pendingDeposit' => $this->depositManager->hasPendingRequest($whitelistEntry->pz_username),
            'lastDepositResult' => $this->depositManager->getLastResult($whitelistEntry->pz_username),
            'balance' => $this->walletService->getBalance($user),
        ]);
    }

    /**
     * Poll endpoint for purchase delivery status.
     * Processes delivery results inline for near-instant finalization.
     */
    public function purchaseStatus(Request $request, string $purchaseId): JsonResponse
    {
        $purchase = ShopPurchase::query()
            ->where('id', $purchaseId)
            ->where('user_id', $request->user()->id)
            ->with('deliveries')
            ->first();

        if (! $purchase) {
            return response()->json(['error' => 'Purchase not found'], 404);
        }

        // Process any available delivery results inline
        $this->deliveryService->processResults();

        // Refresh to get latest state
        $purchase->refresh();
        $purchase->load('deliveries');

        $isComplete = in_array($purchase->delivery_status->value, ['delivered', 'failed', 'partially_delivered']);

        return response()->json([
            'purchase_id' => $purchase->id,
            'delivery_status' => $purchase->delivery_status->value,
            'is_complete' => $isComplete,
            'is_debited' => $purchase->wallet_transaction_id !== null,
            'total_price' => (float) $purchase->total_price,
            'balance' => $this->walletService->getBalance($request->user()),
            'availableBalance' => $this->walletService->getAvailableBalance($request->user()),
            'deliveries' => $purchase->deliveries->map(fn ($d) => [
                'item_type' => $d->item_type,
                'quantity' => $d->quantity,
                'status' => $d->status->value,
                'error_message' => $d->error_message,
            ]),
        ]);
    }

    /**
     * Show player's wallet and transaction history.
     */
    public function myWallet(): Response
    {
        $user = request()->user();
        $balance = $this->walletService->getBalance($user);
        $transactions = $this->walletService->getTransactionHistory($user, 30);

        return Inertia::render('shop/my-wallet', [
            'balance' => $balance,
            'transactions' => $transactions,
        ]);
    }
}
