<?php

namespace App\Http\Controllers;

use App\Services\InventoryReader;
use App\Services\ItemIconResolver;
use App\Services\OnlinePlayersReader;
use App\Services\PzIdentityResolver;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Read-only view of the authenticated player's own in-game inventory.
 *
 * The PZ username is always resolved server-side from the session, never
 * from request input, so a player can only ever see their own inventory.
 */
class PlayerInventoryController extends Controller
{
    public function __construct(
        private readonly InventoryReader $inventoryReader,
        private readonly ItemIconResolver $iconResolver,
        private readonly OnlinePlayersReader $onlinePlayersReader,
        private readonly PzIdentityResolver $identity,
    ) {}

    public function __invoke(Request $request): Response
    {
        $pzUsername = $this->identity->resolve($request->user());

        if ($pzUsername === null) {
            return Inertia::render('portal/inventory', [
                'username' => null,
                'inventory' => null,
                'isOnline' => false,
                'hasPzAccount' => false,
            ]);
        }

        /** Ask the Lua mod for a fresh snapshot; it lands within ~2.5s and the page polls. */
        $this->inventoryReader->requestExport($pzUsername);

        $inventory = $this->inventoryReader->getPlayerInventory($pzUsername);

        return Inertia::render('portal/inventory', [
            'username' => $pzUsername,
            'inventory' => $inventory ? [
                'username' => $inventory['username'],
                'timestamp' => $inventory['timestamp'],
                'weight' => $inventory['weight'],
                'max_weight' => $inventory['max_weight'],
                'items' => $this->withIcons($inventory['items'] ?? []),
                'containers' => $inventory['containers'] ?? [],
            ] : null,
            'isOnline' => in_array($pzUsername, $this->onlinePlayersReader->getOnlineUsernames(), true),
            'hasPzAccount' => true,
        ]);
    }

    /**
     * Attach resolved icon paths to inventory items.
     *
     * @param  array<int, array<string, mixed>>  $items
     * @return array<int, array<string, mixed>>
     */
    private function withIcons(array $items): array
    {
        return array_map(fn (array $item) => [
            ...$item,
            'icon' => $this->iconResolver->resolve($item['full_type']),
        ], $items);
    }
}
