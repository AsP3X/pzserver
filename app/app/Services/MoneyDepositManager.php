<?php

namespace App\Services;

use App\Enums\TransactionSource;
use App\Models\MoneyDeposit;
use App\Models\WalletTransaction;
use App\Models\WhitelistEntry;
use App\Support\LuaBridgeFile;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class MoneyDepositManager
{
    /** Seconds before a pending request with no result is considered timed out. */
    private const PENDING_TIMEOUT_SECONDS = 120;

    private string $requestsPath;

    private string $resultsPath;

    public function __construct(?string $requestsPath = null, ?string $resultsPath = null)
    {
        $this->requestsPath = $requestsPath ?? config('zomboid.lua_bridge.deposit_requests');
        $this->resultsPath = $resultsPath ?? config('zomboid.lua_bridge.deposit_results');
    }

    public function moneyValue(): int
    {
        return max(0, (int) config('zomboid.money_deposit.money_value', 1));
    }

    public function bundleValue(): int
    {
        return max(0, (int) config('zomboid.money_deposit.bundle_value', 100));
    }

    /**
     * Preview coins from last inventory snapshot (may be stale until export).
     *
     * @return array{username: string, money_count: int, bundle_count: int, estimated_coins: int, rates: array{money_value: int, bundle_value: int}, inventory_found: bool, inventory_age_seconds: ?int}
     */
    public function previewForUsername(string $username, InventoryReader $inventoryReader): array
    {
        $money = 0;
        $bundles = 0;
        $found = false;
        $age = null;

        $inventory = $inventoryReader->getPlayerInventory($username);
        if (is_array($inventory)) {
            $found = true;
            foreach ($inventory['items'] ?? [] as $item) {
                $type = $item['full_type'] ?? '';
                $count = (int) ($item['count'] ?? 1);
                if ($type === 'Base.Money') {
                    $money += $count;
                } elseif ($type === 'Base.MoneyBundle') {
                    $bundles += $count;
                }
            }
            $path = config('zomboid.lua_bridge.inventory_dir').'/'.$username.'.json';
            if (is_file($path)) {
                $age = max(0, time() - (int) filemtime($path));
            }
        }

        return [
            'username' => $username,
            'money_count' => $money,
            'bundle_count' => $bundles,
            'estimated_coins' => ($money * $this->moneyValue()) + ($bundles * $this->bundleValue()),
            'rates' => [
                'money_value' => $this->moneyValue(),
                'bundle_value' => $this->bundleValue(),
            ],
            'inventory_found' => $found,
            'inventory_age_seconds' => $age,
        ];
    }

    /**
     * Create a deposit request for a player (DB outbox + JSON for Lua).
     *
     * @return array{id: string, username: string, status: string, created_at: string}
     */
    public function createRequest(string $username, ?int $userId = null, string $source = 'web', bool $dryRun = false): array
    {
        $id = Str::uuid()->toString();
        $createdAt = date('c');

        MoneyDeposit::query()->create([
            'id' => $id,
            'username' => $username,
            'user_id' => $userId,
            'status' => 'pending',
            'source' => $source,
            'dry_run' => $dryRun,
            'message' => $dryRun ? 'Dry-run: Lua will report counts without removing items' : null,
            'meta' => ['created_via' => $source],
        ]);

        if (! $dryRun) {
            $data = $this->readJsonFile($this->requestsPath, ['version' => 1, 'updated_at' => '', 'requests' => []]);
            $data['requests'][] = [
                'id' => $id,
                'username' => $username,
                'status' => 'pending',
                'created_at' => $createdAt,
            ];
            $data['updated_at'] = $createdAt;
            $this->writeJsonFileAtomic($this->requestsPath, $data);
        }

        $this->ensureResultsFileWritable();
        app(LuaBridgeRepairService::class)->syncDepositRatesConfig();

        return [
            'id' => $id,
            'username' => $username,
            'status' => 'pending',
            'created_at' => $createdAt,
            'dry_run' => $dryRun,
        ];
    }

    /**
     * Admin dry-run: estimates from inventory snapshot and records a synthetic result.
     *
     * @return array{id: string, username: string, status: string, money_count: int, bundle_count: int, total_coins: int, message: string}
     */
    public function simulateFromInventory(string $username, InventoryReader $inventoryReader, ?int $userId = null): array
    {
        $preview = $this->previewForUsername($username, $inventoryReader);
        $id = Str::uuid()->toString();

        $status = $preview['inventory_found']
            ? (($preview['money_count'] + $preview['bundle_count']) > 0 ? 'success' : 'failed')
            : 'failed';

        $message = ! $preview['inventory_found']
            ? 'No inventory snapshot found (request export / stay online)'
            : (($preview['money_count'] + $preview['bundle_count']) > 0
                ? 'Dry-run estimate from inventory snapshot (items NOT removed)'
                : 'no money items found in inventory snapshot');

        MoneyDeposit::query()->create([
            'id' => $id,
            'username' => $username,
            'user_id' => $userId,
            'status' => $status,
            'money_count' => $preview['money_count'],
            'bundle_count' => $preview['bundle_count'],
            'total_coins' => $preview['estimated_coins'],
            'message' => $message,
            'source' => 'admin_simulate',
            'dry_run' => true,
            'processed_at' => now(),
            'meta' => ['preview' => $preview],
        ]);

        return [
            'id' => $id,
            'username' => $username,
            'status' => $status,
            'money_count' => $preview['money_count'],
            'bundle_count' => $preview['bundle_count'],
            'total_coins' => $preview['estimated_coins'],
            'message' => $message,
        ];
    }

    public function hasPendingRequest(string $username): bool
    {
        // Prefer DB outbox
        $pending = MoneyDeposit::query()
            ->where('username', $username)
            ->where('status', 'pending')
            ->where('dry_run', false)
            ->where('created_at', '>=', now()->subSeconds(self::PENDING_TIMEOUT_SECONDS))
            ->exists();

        if ($pending) {
            return true;
        }

        // Fall back to JSON for mid-upgrade edge cases
        $requests = $this->readJsonFile($this->requestsPath, ['version' => 1, 'updated_at' => '', 'requests' => []]);
        $results = $this->readJsonFile($this->resultsPath, ['version' => 1, 'updated_at' => '', 'results' => []]);

        $processedIds = [];
        foreach ($results['results'] as $result) {
            if (isset($result['id'])) {
                $processedIds[$result['id']] = true;
            }
        }

        $timeoutCutoff = time() - self::PENDING_TIMEOUT_SECONDS;

        foreach ($requests['requests'] as $request) {
            if (($request['username'] ?? '') !== $username || ($request['status'] ?? '') !== 'pending') {
                continue;
            }
            if (isset($processedIds[$request['id']])) {
                continue;
            }
            $createdAt = strtotime($request['created_at'] ?? '');
            if ($createdAt && $createdAt < $timeoutCutoff) {
                continue;
            }

            return true;
        }

        return false;
    }

    /**
     * @return array{id: string, username: string, status: string, money_count: int, stack_count: int, bundle_count?: int, total_coins: int, message: string|null, processed_at: string, credited?: bool}|null
     */
    public function getLastResult(string $username): ?array
    {
        $db = MoneyDeposit::query()
            ->where('username', $username)
            ->where('created_at', '>=', now()->subMinutes(10))
            ->whereIn('status', ['success', 'failed', 'timeout', 'credited'])
            ->orderByDesc('created_at')
            ->first();

        if ($db && $db->status !== 'pending') {
            return $this->depositToResultArray($db);
        }

        // Timeout synthesis from DB pending
        $timedOut = MoneyDeposit::query()
            ->where('username', $username)
            ->where('status', 'pending')
            ->where('dry_run', false)
            ->where('created_at', '<', now()->subSeconds(self::PENDING_TIMEOUT_SECONDS))
            ->where('created_at', '>', now()->subMinutes(10))
            ->orderByDesc('created_at')
            ->first();

        if ($timedOut) {
            $timedOut->update([
                'status' => 'timeout',
                'message' => 'Deposit timed out. Stay online with Money/MoneyBundle. If this keeps happening, open Admin → Lua Bridge and run Repair.',
                'processed_at' => now(),
            ]);

            return $this->depositToResultArray($timedOut->fresh());
        }

        // JSON fallback
        $resultsData = $this->readJsonFile($this->resultsPath, ['version' => 1, 'updated_at' => '', 'results' => []]);
        $requestsData = $this->readJsonFile($this->requestsPath, ['version' => 1, 'updated_at' => '', 'requests' => []]);
        $recentRequestIds = [];
        $fiveMinutesAgo = time() - 300;
        foreach ($requestsData['requests'] as $request) {
            if (($request['username'] ?? '') !== $username) {
                continue;
            }
            $createdAt = strtotime($request['created_at'] ?? '');
            if ($createdAt && $createdAt > $fiveMinutesAgo) {
                $recentRequestIds[$request['id']] = true;
            }
        }

        $last = null;
        foreach ($resultsData['results'] as $result) {
            if (($result['username'] ?? '') === $username && isset($recentRequestIds[$result['id'] ?? ''])) {
                $last = $result;
            }
        }

        return $last;
    }

    /**
     * @return array<string>
     */
    public function processResults(WalletService $walletService): array
    {
        $data = $this->readJsonFile($this->resultsPath, ['version' => 1, 'updated_at' => '', 'results' => []]);
        $creditedIds = [];

        if (! empty($data['results'])) {
            foreach ($data['results'] as $result) {
                $id = $result['id'] ?? null;
                if (! $id) {
                    continue;
                }

                $deposit = MoneyDeposit::query()->find($id);
                if ($deposit) {
                    $this->applyLuaResultToDeposit($deposit, $result);
                } else {
                    // Lua result without DB row (legacy) — create one
                    $deposit = MoneyDeposit::query()->create([
                        'id' => $id,
                        'username' => $result['username'] ?? 'unknown',
                        'status' => ($result['status'] ?? '') === 'success' ? 'success' : 'failed',
                        'money_count' => (int) ($result['money_count'] ?? 0),
                        'bundle_count' => (int) ($result['bundle_count'] ?? $result['stack_count'] ?? 0),
                        'total_coins' => (int) ($result['total_coins'] ?? 0),
                        'message' => $result['message'] ?? null,
                        'source' => 'web',
                        'processed_at' => now(),
                    ]);
                }

                $fresh = $deposit->fresh();
                if ($this->creditDepositIfNeeded($fresh, $walletService)) {
                    $creditedIds[] = $id;
                } elseif (($result['status'] ?? '') === 'success' && WalletTransaction::query()->where('reference_id', $id)->exists()) {
                    $creditedIds[] = $id;
                } elseif (($result['status'] ?? '') !== 'success') {
                    // Keep failed results in JSON for a short window so UI can poll once,
                    // then allow cleanup once DB has the terminal state.
                    if ($fresh && in_array($fresh->status, ['failed', 'timeout', 'cancelled'], true)) {
                        $creditedIds[] = $id;
                    }
                }
            }
        }

        // Also credit any DB success rows not yet credited (e.g. force credit path)
        $pendingCredit = MoneyDeposit::query()
            ->where('status', 'success')
            ->where('credited', false)
            ->where('dry_run', false)
            ->where('total_coins', '>', 0)
            ->limit(50)
            ->get();

        foreach ($pendingCredit as $deposit) {
            if ($this->creditDepositIfNeeded($deposit, $walletService)) {
                $creditedIds[] = $deposit->id;
            }
        }

        return array_values(array_unique($creditedIds));
    }

    public function cleanupStaleRequests(): void
    {
        // Mark timed-out DB rows
        MoneyDeposit::query()
            ->where('status', 'pending')
            ->where('dry_run', false)
            ->where('created_at', '<', now()->subSeconds(self::PENDING_TIMEOUT_SECONDS))
            ->update([
                'status' => 'timeout',
                'message' => 'Deposit timed out. Stay online with Money/MoneyBundle. If this keeps happening, open Admin → Lua Bridge and run Repair.',
                'processed_at' => now(),
            ]);

        $data = $this->readJsonFile($this->requestsPath, ['version' => 1, 'updated_at' => '', 'requests' => []]);
        $results = $this->readJsonFile($this->resultsPath, ['version' => 1, 'updated_at' => '', 'results' => []]);
        $cutoff = strtotime('-10 minutes');
        $changed = false;

        $processedIds = [];
        foreach ($results['results'] as $result) {
            if (isset($result['id'])) {
                $processedIds[$result['id']] = true;
            }
        }

        // Also treat DB non-pending as processed
        try {
            foreach (MoneyDeposit::query()->whereIn('status', ['success', 'failed', 'timeout', 'credited', 'cancelled'])->pluck('id') as $id) {
                $processedIds[$id] = true;
            }
        } catch (\Throwable) {
        }

        $data['requests'] = array_values(array_filter($data['requests'], function ($request) use ($cutoff, $processedIds, &$changed) {
            if (isset($processedIds[$request['id']])) {
                $changed = true;

                return false;
            }
            $createdAt = strtotime($request['created_at'] ?? '');
            if (($request['status'] ?? '') === 'pending' && $createdAt && $createdAt < $cutoff) {
                $changed = true;

                return false;
            }

            return true;
        }));

        if ($changed) {
            $data['updated_at'] = date('c');
            $this->writeJsonFileAtomic($this->requestsPath, $data);
        }
    }

    /**
     * @param  array<string>  $creditedIds
     */
    public function removeProcessedResults(array $creditedIds): bool
    {
        if (empty($creditedIds)) {
            return true;
        }

        $data = $this->readJsonFile($this->resultsPath, ['version' => 1, 'updated_at' => '', 'results' => []]);
        $idSet = array_flip($creditedIds);

        $data['results'] = array_values(array_filter(
            $data['results'],
            fn ($result) => ! isset($idSet[$result['id'] ?? '']),
        ));
        $data['updated_at'] = date('c');

        return $this->writeJsonFileAtomic($this->resultsPath, $data);
    }

    public function cancelPending(string $id, string $reason = 'Cancelled by admin'): bool
    {
        $deposit = MoneyDeposit::query()->find($id);
        if (! $deposit || $deposit->status !== 'pending') {
            return false;
        }

        $deposit->update([
            'status' => 'cancelled',
            'message' => $reason,
            'processed_at' => now(),
        ]);

        $this->removeRequestFromJson($id);

        return true;
    }

    public function forceCredit(string $id, WalletService $walletService, int $coins, string $message = 'Force-credited by admin'): bool
    {
        $deposit = MoneyDeposit::query()->find($id);
        if (! $deposit) {
            return false;
        }

        $deposit->update([
            'status' => 'success',
            'total_coins' => $coins,
            'message' => $message,
            'processed_at' => now(),
            'source' => 'admin_force',
        ]);

        return $this->creditDepositIfNeeded($deposit->fresh(), $walletService);
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function listRecent(int $limit = 50): array
    {
        return MoneyDeposit::query()
            ->orderByDesc('created_at')
            ->limit($limit)
            ->get()
            ->map(fn (MoneyDeposit $d) => [
                'id' => $d->id,
                'username' => $d->username,
                'user_id' => $d->user_id,
                'status' => $d->status,
                'money_count' => $d->money_count,
                'bundle_count' => $d->bundle_count,
                'total_coins' => $d->total_coins,
                'message' => $d->message,
                'source' => $d->source,
                'dry_run' => $d->dry_run,
                'credited' => $d->credited,
                'created_at' => $d->created_at?->toIso8601String(),
                'processed_at' => $d->processed_at?->toIso8601String(),
                'credited_at' => $d->credited_at?->toIso8601String(),
            ])
            ->all();
    }

    private function applyLuaResultToDeposit(MoneyDeposit $deposit, array $result): void
    {
        if (in_array($deposit->status, ['credited', 'cancelled'], true) && $deposit->credited) {
            return;
        }

        $status = ($result['status'] ?? '') === 'success' ? 'success' : 'failed';
        $deposit->update([
            'status' => $status,
            'money_count' => (int) ($result['money_count'] ?? 0),
            'bundle_count' => (int) ($result['bundle_count'] ?? $result['stack_count'] ?? 0),
            'total_coins' => (int) ($result['total_coins'] ?? 0),
            'message' => $result['message'] ?? $deposit->message,
            'processed_at' => now(),
        ]);
    }

    private function creditDepositIfNeeded(MoneyDeposit $deposit, WalletService $walletService): bool
    {
        if ($deposit->dry_run || $deposit->credited) {
            return $deposit->credited;
        }

        if ($deposit->status !== 'success' || $deposit->total_coins <= 0) {
            return false;
        }

        if (WalletTransaction::query()->where('reference_id', $deposit->id)->exists()) {
            $deposit->update([
                'credited' => true,
                'status' => 'credited',
                'credited_at' => now(),
            ]);

            return true;
        }

        $whitelistEntry = WhitelistEntry::query()
            ->where('pz_username', $deposit->username)
            ->where('active', true)
            ->first();

        if (! $whitelistEntry || ! $whitelistEntry->user) {
            Log::warning('Deposit credit skipped: no linked user', ['deposit_id' => $deposit->id, 'username' => $deposit->username]);

            return false;
        }

        $wallet = $walletService->getOrCreateWallet($whitelistEntry->user);
        $walletService->credit(
            $wallet,
            (float) $deposit->total_coins,
            TransactionSource::InGameDeposit,
            "In-game money deposit: {$deposit->money_count}x Money + {$deposit->bundle_count}x MoneyBundle",
            'deposit',
            $deposit->id,
            [
                'money_count' => $deposit->money_count,
                'bundle_count' => $deposit->bundle_count,
                'pz_username' => $deposit->username,
            ],
        );

        $deposit->update([
            'credited' => true,
            'status' => 'credited',
            'credited_at' => now(),
            'user_id' => $whitelistEntry->user_id,
        ]);

        // Discord (best-effort)
        try {
            $this->notifyDiscordDeposit($deposit);
        } catch (\Throwable) {
        }

        return true;
    }

    private function notifyDiscordDeposit(MoneyDeposit $deposit): void
    {
        $settings = \App\Models\DiscordWebhookSetting::instance();
        if (! $settings->shouldNotify('shop.deposit.credited')) {
            return;
        }

        $audit = new \App\Models\AuditLog([
            'actor' => $deposit->username,
            'action' => 'shop.deposit.credited',
            'target' => $deposit->username,
            'details' => [
                'coins' => $deposit->total_coins,
                'money' => $deposit->money_count,
                'bundles' => $deposit->bundle_count,
                'id' => $deposit->id,
            ],
        ]);
        app(DiscordWebhookService::class)->sendNotification((string) $settings->webhook_url, $audit);
    }

    /**
     * @return array{id: string, username: string, status: string, money_count: int, stack_count: int, bundle_count: int, total_coins: int, message: string|null, processed_at: string, credited: bool}
     */
    private function depositToResultArray(MoneyDeposit $d): array
    {
        return [
            'id' => $d->id,
            'username' => $d->username,
            'status' => in_array($d->status, ['success', 'credited'], true) ? 'success' : 'failed',
            'money_count' => $d->money_count,
            'stack_count' => $d->bundle_count,
            'bundle_count' => $d->bundle_count,
            'total_coins' => $d->total_coins,
            'message' => $d->message,
            'processed_at' => ($d->processed_at ?? $d->updated_at)?->toIso8601String() ?? date('c'),
            'credited' => $d->credited,
        ];
    }

    private function ensureResultsFileWritable(): void
    {
        if (! file_exists($this->resultsPath)) {
            LuaBridgeFile::writeJsonAtomic($this->resultsPath, [
                'version' => 1,
                'updated_at' => date('c'),
                'results' => [],
            ]);

            return;
        }

        LuaBridgeFile::makeWorldWritable(dirname($this->resultsPath));
        LuaBridgeFile::makeWorldWritable($this->resultsPath);
        LuaBridgeFile::makeWorldWritable($this->requestsPath);
    }

    private function removeRequestFromJson(string $id): void
    {
        $data = $this->readJsonFile($this->requestsPath, ['version' => 1, 'updated_at' => '', 'requests' => []]);
        $before = count($data['requests']);
        $data['requests'] = array_values(array_filter(
            $data['requests'],
            fn ($r) => ($r['id'] ?? '') !== $id,
        ));
        if (count($data['requests']) !== $before) {
            $data['updated_at'] = date('c');
            $this->writeJsonFileAtomic($this->requestsPath, $data);
        }
    }

    private function readJsonFile(string $path, array $default): array
    {
        if (! file_exists($path)) {
            return $default;
        }

        $content = file_get_contents($path);
        if ($content === false) {
            return $default;
        }

        $data = json_decode($content, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            return $default;
        }

        return $data;
    }

    private function writeJsonFileAtomic(string $path, array $data): bool
    {
        return LuaBridgeFile::writeJsonAtomic($path, $data);
    }
}
