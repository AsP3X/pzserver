<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Services\AuditLogger;
use App\Services\DeployChecklistService;
use App\Services\InventoryReader;
use App\Services\LuaBridgeHealthService;
use App\Services\LuaBridgeRepairService;
use App\Services\MoneyDepositManager;
use App\Services\ModManager;
use App\Services\SteamWorkshopClient;
use App\Services\WalletService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

class BridgeController extends Controller
{
    public function __construct(
        private readonly LuaBridgeHealthService $health,
        private readonly LuaBridgeRepairService $repair,
        private readonly DeployChecklistService $checklist,
        private readonly MoneyDepositManager $deposits,
        private readonly InventoryReader $inventory,
        private readonly WalletService $wallets,
        private readonly AuditLogger $audit,
        private readonly ModManager $mods,
        private readonly SteamWorkshopClient $workshop,
    ) {}

    public function index(): Response
    {
        $iniPath = config('zomboid.paths.server_ini');
        $modList = [];
        try {
            $modList = $this->mods->list($iniPath);
        } catch (\Throwable) {
        }

        $modUpdates = [];
        foreach (array_slice($modList, 0, 30) as $mod) {
            $wid = (string) ($mod['workshop_id'] ?? '');
            if ($wid === '' || $wid === '0') {
                continue;
            }
            try {
                $details = $this->workshop->getDetails($wid);
                if ($details) {
                    $modUpdates[] = [
                        'workshop_id' => $wid,
                        'mod_id' => $mod['mod_id'] ?? null,
                        'title' => $details['title'] ?? $mod['mod_id'] ?? $wid,
                        'time_updated' => $details['time_updated'] ?? null,
                    ];
                }
            } catch (\Throwable) {
            }
        }

        return Inertia::render('admin/bridge', [
            'health' => $this->health->status(),
            'checklist' => $this->checklist->checklist(),
            'deposits' => $this->deposits->listRecent(40),
            'rates' => [
                'money_value' => $this->deposits->moneyValue(),
                'bundle_value' => $this->deposits->bundleValue(),
            ],
            'mod_updates' => $modUpdates,
        ]);
    }

    public function repair(Request $request): JsonResponse
    {
        $result = $this->repair->repair();
        $actor = (string) ($request->user()?->username ?? 'admin');
        $this->audit->log($actor, 'bridge.repair', 'lua-bridge', [
            'ok' => $result['ok'],
            'actions' => count($result['actions']),
            'errors' => $result['errors'],
        ]);

        return response()->json($result);
    }

    public function health(): JsonResponse
    {
        return response()->json($this->health->status());
    }

    public function cancelDeposit(Request $request, string $id): JsonResponse
    {
        $actor = (string) ($request->user()?->username ?? 'admin');
        $ok = $this->deposits->cancelPending($id, 'Cancelled by admin '.$actor);
        if ($ok) {
            $this->audit->log($actor, 'bridge.deposit.cancel', $id, []);
        }

        return response()->json(['ok' => $ok]);
    }

    public function forceCredit(Request $request, string $id): JsonResponse
    {
        $data = $request->validate([
            'coins' => ['required', 'integer', 'min:1', 'max:1000000'],
            'message' => ['nullable', 'string', 'max:255'],
        ]);

        $ok = $this->deposits->forceCredit(
            $id,
            $this->wallets,
            (int) $data['coins'],
            $data['message'] ?? 'Force-credited by admin',
        );

        if ($ok) {
            $this->audit->log((string) ($request->user()?->username ?? 'admin'), 'bridge.deposit.force_credit', $id, $data);
        }

        return response()->json(['ok' => $ok]);
    }

    public function simulateDeposit(Request $request): JsonResponse
    {
        $data = $request->validate([
            'username' => ['required', 'string', 'max:50'],
        ]);

        $result = $this->deposits->simulateFromInventory(
            $data['username'],
            $this->inventory,
            $request->user()?->id,
        );

        $this->audit->log((string) ($request->user()?->username ?? 'admin'), 'bridge.deposit.simulate', $data['username'], $result);

        return response()->json($result);
    }

    public function updateRates(Request $request): JsonResponse
    {
        $data = $request->validate([
            'money_value' => ['required', 'integer', 'min:0', 'max:10000'],
            'bundle_value' => ['required', 'integer', 'min:0', 'max:100000'],
        ]);

        config([
            'zomboid.money_deposit.money_value' => (int) $data['money_value'],
            'zomboid.money_deposit.bundle_value' => (int) $data['bundle_value'],
        ]);

        $overridePath = storage_path('app/money_deposit_rates.json');
        file_put_contents($overridePath, json_encode($data, JSON_PRETTY_PRINT));
        @chmod($overridePath, 0664);

        $this->repair->syncDepositRatesConfig();
        $this->audit->log((string) ($request->user()?->username ?? 'admin'), 'bridge.rates.update', 'money_deposit', $data);

        return response()->json(['ok' => true, 'rates' => $data]);
    }
}

