<?php

namespace App\Http\Controllers;

use App\Http\Requests\DepositToVaultRequest;
use App\Http\Requests\WithdrawFromVaultRequest;
use App\Models\User;
use App\Models\VaultSetting;
use App\Models\WhitelistEntry;
use App\Services\ItemIconResolver;
use App\Services\VaultDepositService;
use App\Services\VaultService;
use App\Services\VaultWithdrawService;
use App\Services\WalletService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;
use InvalidArgumentException;

/**
 * The authenticated player's own item vault.
 *
 * As with PlayerInventoryController, the PZ username is resolved from the
 * session so a player can never act on another player's vault.
 */
class PlayerVaultController extends Controller
{
    public function __construct(
        private readonly VaultService $vaultService,
        private readonly VaultDepositService $depositService,
        private readonly VaultWithdrawService $withdrawService,
        private readonly WalletService $walletService,
        private readonly ItemIconResolver $iconResolver,
    ) {}

    public function show(Request $request): Response
    {
        $user = $request->user();
        $pzUsername = $this->resolvePzUsername($user);

        // Settle anything Lua has finished since the last page view.
        $this->depositService->processResults();
        $this->withdrawService->processResults();

        $vault = $this->vaultService->getOrCreateVault($user);
        $settings = VaultSetting::instance();

        $items = $vault->items()->orderBy('name')->get()->map(fn ($item) => [
            'id' => $item->id,
            'full_type' => $item->full_type,
            'name' => $item->name,
            'category' => $item->category,
            'condition' => (float) $item->condition,
            'count' => $item->count,
            'icon' => $this->iconResolver->resolve($item->full_type),
        ]);

        return Inertia::render('portal/vault', [
            'username' => $pzUsername,
            'hasPzAccount' => $pzUsername !== null,
            'items' => $items,
            'capacity' => [
                'used' => $this->vaultService->usedSlots($vault),
                'total' => $vault->slot_capacity,
                'max' => $settings->max_slots,
                'upgrade_cost' => (float) $settings->slot_upgrade_cost,
                'upgrade_increment' => $settings->slot_upgrade_increment,
            ],
            'fees' => [
                'flat' => (float) $settings->withdraw_fee_flat,
                'per_item' => (float) $settings->withdraw_fee_per_item,
            ],
            'balance' => $this->walletService->getBalance($user),
            'availableBalance' => $this->walletService->getAvailableBalance($user),
            'transactions' => $vault->transactions()
                ->orderByDesc('created_at')->limit(20)->get(),
        ]);
    }

    public function deposit(DepositToVaultRequest $request): JsonResponse
    {
        $pzUsername = $this->resolvePzUsername($request->user());

        if ($pzUsername === null) {
            return response()->json(['error' => 'No linked PZ account found.'], 422);
        }

        $validated = $request->validated();

        try {
            $transaction = $this->depositService->requestDeposit(
                $request->user(),
                $pzUsername,
                $validated['full_type'],
                $validated['name'],
                $validated['category'],
                $validated['count'],
            );
        } catch (InvalidArgumentException $e) {
            return response()->json(['error' => $e->getMessage()], 422);
        }

        return response()->json(['transaction_id' => $transaction->id], 201);
    }

    public function withdraw(WithdrawFromVaultRequest $request): JsonResponse
    {
        $pzUsername = $this->resolvePzUsername($request->user());

        if ($pzUsername === null) {
            return response()->json(['error' => 'No linked PZ account found.'], 422);
        }

        $validated = $request->validated();

        try {
            $transaction = $this->withdrawService->requestWithdrawal(
                $request->user(),
                $pzUsername,
                $validated['full_type'],
                (float) $validated['condition'],
                $validated['count'],
            );
        } catch (InvalidArgumentException $e) {
            return response()->json(['error' => $e->getMessage()], 422);
        }

        return response()->json([
            'transaction_id' => $transaction->id,
            'fee' => (float) $transaction->fee_charged,
        ], 201);
    }

    public function upgrade(Request $request): JsonResponse
    {
        try {
            $vault = $this->vaultService->purchaseSlots($request->user());
        } catch (InvalidArgumentException $e) {
            return response()->json(['error' => $e->getMessage()], 422);
        }

        return response()->json([
            'slot_capacity' => $vault->slot_capacity,
            'balance' => $this->walletService->getBalance($request->user()),
        ]);
    }

    /**
     * Resolve the caller's PZ character name, preferring the linked entry.
     */
    private function resolvePzUsername(User $user): ?string
    {
        $entry = WhitelistEntry::query()
            ->where('user_id', $user->id)
            ->where('active', true)
            ->first();

        if ($entry !== null) {
            return $entry->pz_username;
        }

        return WhitelistEntry::query()
            ->where('pz_username', $user->username)
            ->where('active', true)
            ->first()?->pz_username;
    }
}
