# Player Item Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let players move items out of their in-game inventory into a web-side vault, and withdraw them later for a coin fee.

**Architecture:** Deposits are items-first (Lua removes and reports exactly what came out, then PHP credits the vault). Withdrawals are deliver-then-debit (items are delivered and confirmed, then the fee is debited). Both mirror rules already established for money deposits and shop purchases. Items are stored grouped by `(full_type, condition)` so stacks collapse but a damaged axe never becomes a pristine one.

**Tech Stack:** Laravel 12 / PHP 8.3, PostgreSQL, Pest 3, React 19 + Inertia v2, Tailwind v4, PZ Lua mod (`ZomboidManager`).

## Context

**Phase**: 24
**Title**: Player Item Vault
**Branch**: `phase-24-item-vault` (to be created)
**Created**: 2026-08-03
**Depends on**: Phase 18 (Lua bridge), Phase 20 (admin inventory), Phase 23 (shop/wallet), and the player inventory page (`d07d86d`)

---

## Design Decisions (settled during brainstorming)

| Decision | Choice |
|---|---|
| Economics | Free to deposit, coin fee to withdraw |
| Item fidelity | Preserve per-item condition exactly |
| Lua mod | May be modified (workshop re-upload required) |
| Capacity | Capped, upgradeable with coins |
| Fee shape | Flat fee per withdrawal + optional per-item fee, both admin-tunable |

---

## Technical Discovery

### Reusable as-is
- `App\Services\InventoryReader` — `getPlayerInventory()`, `requestExport()`
- `App\Services\DeliveryQueueManager` — `readQueue()`, `readResults()`, `addEntry()` (private)
- `App\Services\WalletService` — `credit()`, `debit()`, `getBalance()`, `getAvailableBalance()`
- `App\Services\OnlinePlayersReader` — `getOnlineUsernames()`
- `resources/js/components/inventory/inventory-table.tsx` — has a `rowActions` render slot, already built for this
- `resources/js/lib/inventory.ts` — `stackItems()`

### Must change
- `WalletService::getAvailableBalance()` only subtracts pending `ShopPurchase` holds. Pending vault withdrawal fees must also hold, or a player can double-spend across a purchase and a withdrawal.
- `ZM_DeliveryQueue.lua` `removeItem()` returns `false` on partial removal **after items are already deleted**. Building the vault on it would destroy items without crediting. Needs `remove_verified`.
- `ZM_DeliveryQueue.lua` has no way to set condition on a given item. Needs `give_with_condition`.
- `ZM_InventoryExporter.lua` only walks main inventory + back-worn backpack, while `collectContainers()` in `ZM_DeliveryQueue.lua` reaches every nested bag. The web under-reports what a player carries.

### Existing snapshot item shape
```json
{ "full_type": "Base.Axe", "name": "Axe", "category": "Weapon",
  "count": 1, "condition": 0.85, "equipped": true, "container": "inventory" }
```
`condition` is a 0–1 fraction rounded to 2 decimals by `ZM_InventoryExporter.serializeItem()`. Restoration is therefore accurate to ±1%.

---

## File Structure

**Create — backend**
- `app/database/migrations/2026_08_03_100001_create_vaults_table.php`
- `app/database/migrations/2026_08_03_100002_create_vault_items_table.php`
- `app/database/migrations/2026_08_03_100003_create_vault_transactions_table.php`
- `app/database/migrations/2026_08_03_100004_create_vault_settings_table.php`
- `app/app/Models/Vault.php`, `VaultItem.php`, `VaultTransaction.php`, `VaultSetting.php`
- `app/app/Enums/VaultDirection.php`, `VaultTransactionStatus.php`
- `app/app/Services/VaultService.php` — capacity, storage, grouping
- `app/app/Services/VaultDepositService.php` — items-first deposit
- `app/app/Services/VaultWithdrawService.php` — deliver-then-debit withdrawal
- `app/app/Http/Controllers/PlayerVaultController.php`
- `app/app/Http/Controllers/Admin/VaultSettingController.php`
- `app/app/Http/Requests/DepositToVaultRequest.php`, `WithdrawFromVaultRequest.php`, `Admin/UpdateVaultSettingsRequest.php`

**Create — frontend**
- `app/resources/js/pages/portal/vault.tsx`
- `app/resources/js/components/inventory/vault-capacity-meter.tsx`
- `app/resources/js/pages/admin/vault-settings.tsx`

**Create — Lua**
- (none; all changes are to existing modules)

**Modify**
- `game-server/mods/ZomboidManager/42/media/lua/server/ZM_DeliveryQueue.lua` — add `remove_verified`, `give_with_condition`
- `game-server/mods/ZomboidManager/42/media/lua/server/ZM_InventoryExporter.lua` — walk nested containers
- `game-server/mods/ZomboidManager/42/mod.info` — version bump
- `app/app/Services/DeliveryQueueManager.php` — `removeItemVerified()`, `giveItemWithCondition()`
- `app/app/Services/WalletService.php:161` — include vault holds in `getAvailableBalance()`
- `app/app/Enums/TransactionSource.php` — add `VaultFee`, `VaultUpgrade`
- `app/routes/web.php` — vault routes
- `app/resources/js/components/app-sidebar.tsx` — "My Vault" nav entry
- `app/resources/js/pages/portal/inventory.tsx` — "Deposit to vault" row action
- `app/lang/en.json`, `app/lang/ka.json` — `vault.*` keys
- `IMPLEMENTATION_PLAN.md` — Phase 24 status row

---

## Task 1: Schema and models

**Files:**
- Create: the four migrations above, four models, two enums
- Test: `app/tests/Unit/VaultModelTest.php`

- [ ] **Step 1: Write the failing test**

```php
<?php

use App\Models\User;
use App\Models\Vault;
use App\Models\VaultItem;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

it('creates a vault for a user with default capacity', function () {
    $user = User::factory()->create();
    $vault = Vault::query()->create(['user_id' => $user->id, 'slot_capacity' => 50]);

    expect($vault->slot_capacity)->toBe(50)
        ->and($vault->user->id)->toBe($user->id);
});

it('stores items grouped by type and condition', function () {
    $user = User::factory()->create();
    $vault = Vault::query()->create(['user_id' => $user->id, 'slot_capacity' => 50]);

    VaultItem::query()->create([
        'vault_id' => $vault->id, 'full_type' => 'Base.Axe', 'name' => 'Axe',
        'category' => 'Weapon', 'condition' => 0.85, 'count' => 1,
    ]);
    VaultItem::query()->create([
        'vault_id' => $vault->id, 'full_type' => 'Base.Axe', 'name' => 'Axe',
        'category' => 'Weapon', 'condition' => 1.0, 'count' => 2,
    ]);

    expect($vault->items()->count())->toBe(2)
        ->and($vault->items()->sum('count'))->toBe(3);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `make exec CMD="php artisan test --compact --filter=VaultModelTest"`
Expected: FAIL — `Class "App\Models\Vault" not found`

- [ ] **Step 3: Write the migrations**

`2026_08_03_100001_create_vaults_table.php`:
```php
<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('vaults', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->unsignedInteger('slot_capacity')->default(50);
            $table->timestamps();
            $table->unique('user_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('vaults');
    }
};
```

`2026_08_03_100002_create_vault_items_table.php`:
```php
<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('vault_items', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('vault_id')->constrained()->cascadeOnDelete();
            $table->string('full_type');
            $table->string('name');
            $table->string('category')->default('General');
            $table->decimal('condition', 4, 2)->default(1.00);
            $table->unsignedInteger('count')->default(1);
            $table->timestamps();
            $table->unique(['vault_id', 'full_type', 'condition']);
            $table->index(['vault_id', 'full_type']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('vault_items');
    }
};
```

`2026_08_03_100003_create_vault_transactions_table.php`:
```php
<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('vault_transactions', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('vault_id')->constrained()->cascadeOnDelete();
            $table->string('direction');
            $table->string('status')->default('pending');
            $table->string('full_type');
            $table->decimal('condition', 4, 2)->default(1.00);
            $table->unsignedInteger('requested_count');
            $table->unsignedInteger('actual_count')->default(0);
            $table->decimal('fee_charged', 12, 2)->default(0);
            // wallet_transactions.id is a UUID — foreignId would fail here.
            $table->foreignUuid('wallet_transaction_id')->nullable()->constrained('wallet_transactions')->nullOnDelete();
            $table->string('delivery_id')->nullable();
            $table->text('message')->nullable();
            $table->timestamps();
            $table->index(['vault_id', 'created_at']);
            $table->index(['status', 'delivery_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('vault_transactions');
    }
};
```

`2026_08_03_100004_create_vault_settings_table.php`:
```php
<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('vault_settings', function (Blueprint $table) {
            $table->id();
            $table->unsignedInteger('default_slots')->default(50);
            $table->unsignedInteger('max_slots')->default(500);
            $table->unsignedInteger('slot_upgrade_increment')->default(10);
            $table->decimal('slot_upgrade_cost', 12, 2)->default(100);
            $table->decimal('withdraw_fee_flat', 12, 2)->default(5);
            $table->decimal('withdraw_fee_per_item', 12, 2)->default(0);
            $table->boolean('enabled')->default(true);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('vault_settings');
    }
};
```

- [ ] **Step 4: Write the enums**

`app/app/Enums/VaultDirection.php`:
```php
<?php

namespace App\Enums;

enum VaultDirection: string
{
    case Deposit = 'deposit';
    case Withdraw = 'withdraw';
}
```

`app/app/Enums/VaultTransactionStatus.php`:
```php
<?php

namespace App\Enums;

enum VaultTransactionStatus: string
{
    case Pending = 'pending';
    case Completed = 'completed';
    case Partial = 'partial';
    case Failed = 'failed';
}
```

- [ ] **Step 5: Write the models**

`app/app/Models/Vault.php`:
```php
<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Vault extends Model
{
    use HasFactory, HasUuids;

    protected $fillable = ['user_id', 'slot_capacity'];

    protected function casts(): array
    {
        return ['slot_capacity' => 'integer'];
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** @return HasMany<VaultItem, $this> */
    public function items(): HasMany
    {
        return $this->hasMany(VaultItem::class);
    }

    /** @return HasMany<VaultTransaction, $this> */
    public function transactions(): HasMany
    {
        return $this->hasMany(VaultTransaction::class);
    }
}
```

`app/app/Models/VaultItem.php`:
```php
<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class VaultItem extends Model
{
    use HasFactory, HasUuids;

    protected $fillable = ['vault_id', 'full_type', 'name', 'category', 'condition', 'count'];

    protected function casts(): array
    {
        return ['condition' => 'float', 'count' => 'integer'];
    }

    /** @return BelongsTo<Vault, $this> */
    public function vault(): BelongsTo
    {
        return $this->belongsTo(Vault::class);
    }
}
```

`app/app/Models/VaultTransaction.php`:
```php
<?php

namespace App\Models;

use App\Enums\VaultDirection;
use App\Enums\VaultTransactionStatus;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class VaultTransaction extends Model
{
    use HasFactory, HasUuids;

    protected $fillable = [
        'vault_id', 'direction', 'status', 'full_type', 'condition',
        'requested_count', 'actual_count', 'fee_charged',
        'wallet_transaction_id', 'delivery_id', 'message',
    ];

    protected function casts(): array
    {
        return [
            'direction' => VaultDirection::class,
            'status' => VaultTransactionStatus::class,
            'condition' => 'float',
            'requested_count' => 'integer',
            'actual_count' => 'integer',
            'fee_charged' => 'decimal:2',
        ];
    }

    /** @return BelongsTo<Vault, $this> */
    public function vault(): BelongsTo
    {
        return $this->belongsTo(Vault::class);
    }
}
```

`app/app/Models/VaultSetting.php`:
```php
<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class VaultSetting extends Model
{
    protected $fillable = [
        'default_slots', 'max_slots', 'slot_upgrade_increment',
        'slot_upgrade_cost', 'withdraw_fee_flat', 'withdraw_fee_per_item', 'enabled',
    ];

    protected function casts(): array
    {
        return [
            'default_slots' => 'integer',
            'max_slots' => 'integer',
            'slot_upgrade_increment' => 'integer',
            'slot_upgrade_cost' => 'float',
            'withdraw_fee_flat' => 'float',
            'withdraw_fee_per_item' => 'float',
            'enabled' => 'boolean',
        ];
    }

    /**
     * Get the singleton settings row, creating it with defaults if absent.
     */
    public static function instance(): static
    {
        return static::query()->firstOrCreate([], []);
    }
}
```

- [ ] **Step 6: Write factories**

`app/database/factories/VaultFactory.php`:
```php
<?php

namespace Database\Factories;

use App\Models\User;
use App\Models\Vault;
use Illuminate\Database\Eloquent\Factories\Factory;

/** @extends Factory<Vault> */
class VaultFactory extends Factory
{
    protected $model = Vault::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        return [
            'user_id' => User::factory(),
            'slot_capacity' => 50,
        ];
    }
}
```

`app/database/factories/VaultItemFactory.php`:
```php
<?php

namespace Database\Factories;

use App\Models\Vault;
use App\Models\VaultItem;
use Illuminate\Database\Eloquent\Factories\Factory;

/** @extends Factory<VaultItem> */
class VaultItemFactory extends Factory
{
    protected $model = VaultItem::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        return [
            'vault_id' => Vault::factory(),
            'full_type' => 'Base.Axe',
            'name' => 'Axe',
            'category' => 'Weapon',
            'condition' => 1.0,
            'count' => 1,
        ];
    }
}
```

- [ ] **Step 7: Run the test**

Run: `make exec CMD="php artisan test --compact --filter=VaultModelTest"`
Expected: PASS, 2 tests

- [ ] **Step 8: Format and commit**

```bash
make exec CMD="vendor/bin/pint --dirty --format agent"
git add app/database/migrations app/app/Models app/app/Enums app/database/factories app/tests/Unit/VaultModelTest.php
git commit -m "Add vault schema, models and enums."
```

---

## Task 2: VaultService — capacity and item storage

**Files:**
- Create: `app/app/Services/VaultService.php`
- Test: `app/tests/Unit/VaultServiceTest.php`

`VaultService` owns everything about *what is in a vault*: getting or creating it, counting slots, adding items (merging on `(full_type, condition)`), and taking items back out. It knows nothing about coins or Lua — that keeps it testable without mocks.

- [ ] **Step 1: Write the failing test**

```php
<?php

use App\Models\User;
use App\Models\Vault;
use App\Models\VaultItem;
use App\Models\VaultSetting;
use App\Services\VaultService;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->service = app(VaultService::class);
});

it('creates a vault on first access using the configured default capacity', function () {
    VaultSetting::query()->create(['default_slots' => 25]);
    $user = User::factory()->create();

    $vault = $this->service->getOrCreateVault($user);

    expect($vault->slot_capacity)->toBe(25);
});

it('merges deposited items into an existing stack with the same type and condition', function () {
    $vault = Vault::factory()->create();
    $this->service->addItem($vault, 'Base.Axe', 'Axe', 'Weapon', 1.0, 2);
    $this->service->addItem($vault, 'Base.Axe', 'Axe', 'Weapon', 1.0, 3);

    expect($vault->items()->count())->toBe(1)
        ->and($vault->items()->first()->count)->toBe(5);
});

it('keeps different conditions in separate stacks', function () {
    $vault = Vault::factory()->create();
    $this->service->addItem($vault, 'Base.Axe', 'Axe', 'Weapon', 1.0, 1);
    $this->service->addItem($vault, 'Base.Axe', 'Axe', 'Weapon', 0.4, 1);

    expect($vault->items()->count())->toBe(2);
});

it('reports used slots as the number of distinct stacks', function () {
    $vault = Vault::factory()->create(['slot_capacity' => 3]);
    $this->service->addItem($vault, 'Base.Axe', 'Axe', 'Weapon', 1.0, 99);
    $this->service->addItem($vault, 'Base.Nails', 'Nails', 'Material', 1.0, 500);

    expect($this->service->usedSlots($vault))->toBe(2)
        ->and($this->service->hasFreeSlot($vault, 'Base.Rope', 1.0))->toBeTrue();
});

it('allows topping up an existing stack even when every slot is used', function () {
    $vault = Vault::factory()->create(['slot_capacity' => 1]);
    $this->service->addItem($vault, 'Base.Axe', 'Axe', 'Weapon', 1.0, 1);

    expect($this->service->hasFreeSlot($vault, 'Base.Axe', 1.0))->toBeTrue()
        ->and($this->service->hasFreeSlot($vault, 'Base.Rope', 1.0))->toBeFalse();
});

it('removes a stack entirely when its count reaches zero', function () {
    $vault = Vault::factory()->create();
    $this->service->addItem($vault, 'Base.Axe', 'Axe', 'Weapon', 1.0, 2);

    $this->service->takeItem($vault, 'Base.Axe', 1.0, 2);

    expect($vault->items()->count())->toBe(0);
});

it('refuses to take more items than the stack holds', function () {
    $vault = Vault::factory()->create();
    $this->service->addItem($vault, 'Base.Axe', 'Axe', 'Weapon', 1.0, 1);

    expect(fn () => $this->service->takeItem($vault, 'Base.Axe', 1.0, 5))
        ->toThrow(InvalidArgumentException::class);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `make exec CMD="php artisan test --compact --filter=VaultServiceTest"`
Expected: FAIL — `Class "App\Services\VaultService" not found`

- [ ] **Step 3: Implement VaultService**

```php
<?php

namespace App\Services;

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
     * Round to the 2 decimals the Lua exporter emits, so lookups match storage.
     */
    private function normalizeCondition(float $condition): float
    {
        return round(max(0.0, min(1.0, $condition)), 2);
    }
}
```

- [ ] **Step 4: Run the test**

Run: `make exec CMD="php artisan test --compact --filter=VaultServiceTest"`
Expected: PASS, 7 tests

- [ ] **Step 5: Format and commit**

```bash
make exec CMD="vendor/bin/pint --dirty --format agent"
git add app/app/Services/VaultService.php app/tests/Unit/VaultServiceTest.php
git commit -m "Add VaultService for vault capacity and item storage."
```

---

## Task 3: Lua — `remove_verified` action

**Files:**
- Modify: `game-server/mods/ZomboidManager/42/media/lua/server/ZM_DeliveryQueue.lua`
- Modify: `game-server/mods/ZomboidManager/42/mod.info` (bump version)

This is the safety-critical change. `removeItem()` currently deletes items and then reports failure on a partial, losing the record of what was taken. `removeItemVerified()` returns the actual list.

- [ ] **Step 1: Add `removeOneItemDetailed` above `removeItem`**

Insert after the existing `removeOneItem` definition (currently ends around line 358):

```lua
--- Remove one matching item and return its identity, or nil if none found.
local function removeOneItemDetailed(player, itemType)
    local inventory = player:getInventory()
    if not inventory then
        return nil
    end

    local item = nil
    for _, container in ipairs(collectContainers(player)) do
        item = findItemInContainer(container, itemType)
        if item then
            break
        end
    end

    if not item and inventory.getFirstTypeRecurse then
        item = inventory:getFirstTypeRecurse(shortTypeName(itemType))
        if not item then
            item = inventory:getFirstTypeRecurse(itemType)
        end
    end

    if not item then
        return nil
    end

    -- Capture identity BEFORE removal; the object is unusable afterwards.
    local detail = {
        full_type = item:getFullType(),
        name = item:getName(),
        category = tostring(item:getDisplayCategory() or "General"),
        condition = 1.0,
    }
    if item.getCondition and item.getMaxCondition then
        local maxCond = item:getMaxCondition()
        if maxCond > 0 then
            detail.condition = math.floor((item:getCondition() / maxCond) * 100) / 100
        end
    end

    if player:isEquipped(item) then
        player:removeWornItem(item)
    end
    if player:getPrimaryHandItem() == item then
        player:setPrimaryHandItem(nil)
    end
    if player:getSecondaryHandItem() == item then
        player:setSecondaryHandItem(nil)
    end

    local container = item:getContainer()
    if container and container.DoRemoveItem then
        container:DoRemoveItem(item)
    elseif container and container.Remove then
        container:Remove(item)
    elseif inventory.DoRemoveItem then
        inventory:DoRemoveItem(item)
    else
        inventory:Remove(item)
    end

    return detail
end

--- Remove up to `count` items, reporting exactly what came out.
--- Always succeeds; the caller decides what a partial removal means.
local function removeItemVerified(player, itemType, count)
    count = count or 1
    local removed = {}

    for _ = 1, count do
        local detail = removeOneItemDetailed(player, itemType)
        if not detail then
            break
        end
        table.insert(removed, detail)
    end

    if isServer() and #removed > 0 then
        sendServerCommand(player, "ZomboidManager", "removeItem", {
            item_type = itemType,
            count = tostring(#removed),
        })
        syncRemoveToClient(player)
    end

    return true, nil, {removed = removed, removed_count = #removed}
end
```

- [ ] **Step 2: Wire the action into `ZM_DeliveryQueue.process`**

In the action dispatch block (currently around line 444), add a branch after the `remove` branch:

```lua
                elseif entry.action == "remove_verified" then
                    success, errMsg, verificationData = removeItemVerified(player, entry.item_type, entry.count or 1)
```

- [ ] **Step 3: Include the removal detail in the written result**

In the `if success then` block, replace the existing `if verificationData then` body with:

```lua
                    if verificationData then
                        result.verified = true
                        result.count_before = verificationData.count_before
                        result.count_after = verificationData.count_after
                        result.removed = verificationData.removed
                        result.removed_count = verificationData.removed_count
                    end
```

- [ ] **Step 4: Bump the mod version**

In `game-server/mods/ZomboidManager/42/mod.info`, increment the version line (e.g. `1.2.0` → `1.3.0`).

- [ ] **Step 5: Syntax check the Lua**

Run: `docker run --rm -v "$(pwd)/game-server/mods/ZomboidManager/42/media/lua/server:/lua:ro" alpine:latest sh -c "apk add --no-cache lua5.3 >/dev/null && luac5.3 -p /lua/ZM_DeliveryQueue.lua && echo 'syntax OK'"`
Expected: `syntax OK`

- [ ] **Step 6: Commit**

```bash
git add game-server/mods/ZomboidManager/42/media/lua/server/ZM_DeliveryQueue.lua game-server/mods/ZomboidManager/42/mod.info
git commit -m "Add remove_verified Lua action reporting exactly what was removed."
```

---

## Task 4: Lua — `give_with_condition` action

**Files:**
- Modify: `game-server/mods/ZomboidManager/42/media/lua/server/ZM_DeliveryQueue.lua`

- [ ] **Step 1: Add the function after `giveItemVerified`**

```lua
--- Give items and restore a specific condition fraction (0..1) on each.
local function giveItemWithCondition(player, itemType, count, condition)
    local inventory = player:getInventory()
    if not inventory then
        return false, "player has no inventory", nil
    end

    condition = tonumber(condition) or 1.0
    if condition < 0 then condition = 0 end
    if condition > 1 then condition = 1 end

    local countBefore = countItemType(player, itemType)
    local added = {}

    for i = 1, count do
        local item = inventory:AddItem(itemType)
        if not item then
            -- Roll back whatever landed so the caller can retry cleanly.
            for _ = 1, #added do
                removeOneItem(player, itemType)
            end
            return false, "failed to add item " .. itemType .. " (attempt " .. i .. "/" .. count .. ")", nil
        end
        if item.setCondition and item.getMaxCondition then
            local maxCond = item:getMaxCondition()
            if maxCond and maxCond > 0 then
                item:setCondition(math.max(1, math.floor(condition * maxCond)))
            end
        end
        table.insert(added, item)
    end

    local countAfter = countItemType(player, itemType)
    if countAfter < countBefore + count then
        for _ = 1, (countAfter - countBefore) do
            removeOneItem(player, itemType)
        end
        return false, "verification failed: expected >=" .. (countBefore + count) .. " but found " .. countAfter, nil
    end

    syncAddToClient(player, itemType, count)

    return true, nil, {count_before = countBefore, count_after = countAfter, verified = true}
end
```

- [ ] **Step 2: Wire the action into the dispatch block**

```lua
                elseif entry.action == "give_with_condition" then
                    success, errMsg, verificationData = giveItemWithCondition(player, entry.item_type, entry.count or 1, entry.condition or 1.0)
```

- [ ] **Step 3: Syntax check**

Run: `docker run --rm -v "$(pwd)/game-server/mods/ZomboidManager/42/media/lua/server:/lua:ro" alpine:latest sh -c "apk add --no-cache lua5.3 >/dev/null && luac5.3 -p /lua/ZM_DeliveryQueue.lua && echo 'syntax OK'"`
Expected: `syntax OK`

- [ ] **Step 4: Commit**

```bash
git add game-server/mods/ZomboidManager/42/media/lua/server/ZM_DeliveryQueue.lua
git commit -m "Add give_with_condition Lua action restoring item condition."
```

---

## Task 5: Lua — export all nested containers

**Files:**
- Modify: `game-server/mods/ZomboidManager/42/media/lua/server/ZM_InventoryExporter.lua:64-93`

Fixes a pre-existing gap: the exporter sees less than the delivery queue can reach, so players would be unable to deposit items they can see in-game.

- [ ] **Step 1: Replace the item-collection block in `exportPlayer`**

Replace lines 64–93 (from `local items = {}` through the backpack block) with:

```lua
    local items = {}
    local totalWeight = 0
    local seenContainers = {}

    --- Walk a container and every nested container inside it.
    local function collect(container, containerName)
        if not container then
            return
        end
        local key = tostring(container)
        if seenContainers[key] then
            return
        end
        seenContainers[key] = true

        local containerItems = container:getItems()
        if not containerItems then
            return
        end

        for i = 0, containerItems:size() - 1 do
            local item = containerItems:get(i)
            if item then
                table.insert(items, serializeItem(item, containerName, primaryItem, secondaryItem))
                totalWeight = totalWeight + (item:getWeight() or 0)

                if item.getItemContainer then
                    local nested = item:getItemContainer()
                    if nested then
                        collect(nested, item:getName() or containerName)
                    end
                end
            end
        end
    end

    collect(inventory, "inventory")

    if player.getWornItems then
        local worn = player:getWornItems()
        if worn then
            for i = 0, worn:size() - 1 do
                local wornItem = worn:get(i)
                local item = wornItem
                if wornItem and wornItem.getItem then
                    item = wornItem:getItem()
                end
                if item and item.getItemContainer then
                    local c = item:getItemContainer()
                    if c then
                        collect(c, item:getName() or "worn")
                    end
                end
            end
        end
    end

    local backpack = player:getClothingItem_Back()
    if backpack and backpack:getItemContainer() then
        collect(backpack:getItemContainer(), backpack:getName() or "backpack")
    end
```

- [ ] **Step 2: Syntax check**

Run: `docker run --rm -v "$(pwd)/game-server/mods/ZomboidManager/42/media/lua/server:/lua:ro" alpine:latest sh -c "apk add --no-cache lua5.3 >/dev/null && luac5.3 -p /lua/ZM_InventoryExporter.lua && echo 'syntax OK'"`
Expected: `syntax OK`

- [ ] **Step 3: Commit**

```bash
git add game-server/mods/ZomboidManager/42/media/lua/server/ZM_InventoryExporter.lua
git commit -m "Export items from every nested container, not just the back bag."
```

---

## Task 6: DeliveryQueueManager — new queue actions

**Files:**
- Modify: `app/app/Services/DeliveryQueueManager.php`
- Test: `app/tests/Unit/DeliveryQueueManagerTest.php` (append)

- [ ] **Step 1: Write the failing tests (append to the existing file)**

```php
it('queues a remove_verified entry', function () {
    $entry = $this->manager->removeItemVerified('TestPlayer', 'Base.Axe', 3);

    expect($entry['action'])->toBe('remove_verified')
        ->and($entry['count'])->toBe(3)
        ->and($entry['status'])->toBe('pending');

    $queue = $this->manager->readQueue();
    expect($queue['entries'])->toHaveCount(1);
});

it('queues a give_with_condition entry carrying the condition', function () {
    $entry = $this->manager->giveItemWithCondition('TestPlayer', 'Base.Axe', 1, 0.42);

    expect($entry['action'])->toBe('give_with_condition')
        ->and($entry['condition'])->toBe(0.42);
});
```

`$this->manager` is built in the existing `beforeEach` at the top of this file with
temp queue/results paths and mocked RCON — no new helper is needed.

- [ ] **Step 2: Run and confirm failure**

Run: `make exec CMD="php artisan test --compact --filter=DeliveryQueueManagerTest"`
Expected: FAIL — `Call to undefined method ...::removeItemVerified()`

- [ ] **Step 3: Add the methods**

Insert after `removeItem()` (currently line 61):

```php
    /**
     * Remove items via Lua with a full report of what actually came out.
     *
     * Unlike removeItem(), a partial removal is not an error — Lua reports the
     * exact items removed so the caller can credit precisely that much.
     *
     * @return array{id: string, action: string, username: string, item_type: string, count: int, status: string, created_at: string}
     */
    public function removeItemVerified(string $username, string $itemType, int $count = 1): array
    {
        return $this->addEntry('remove_verified', $username, $itemType, $count);
    }

    /**
     * Give items and restore a specific condition fraction on each.
     *
     * @return array{id: string, action: string, username: string, item_type: string, count: int, condition: float, status: string, created_at: string}
     */
    public function giveItemWithCondition(string $username, string $itemType, int $count, float $condition): array
    {
        return $this->addEntry('give_with_condition', $username, $itemType, $count, ['condition' => $condition]);
    }
```

- [ ] **Step 4: Let `addEntry` carry extra fields**

Replace the `addEntry` signature and entry construction (currently lines 196–208):

```php
    /**
     * Add an entry to the delivery queue with atomic write.
     *
     * @param  array<string, mixed>  $extra  Additional fields merged into the entry
     */
    private function addEntry(string $action, string $username, string $itemType, int $count, array $extra = []): array
    {
        $queue = $this->readQueue();

        $entry = [
            'id' => Str::uuid()->toString(),
            'action' => $action,
            'username' => $username,
            'item_type' => $itemType,
            'count' => $count,
            'status' => 'pending',
            'created_at' => date('c'),
            ...$extra,
        ];
```

- [ ] **Step 5: Run the tests**

Run: `make exec CMD="php artisan test --compact --filter=DeliveryQueueManagerTest"`
Expected: PASS — all existing tests plus the 2 new ones

- [ ] **Step 6: Format and commit**

```bash
make exec CMD="vendor/bin/pint --dirty --format agent"
git add app/app/Services/DeliveryQueueManager.php app/tests/Unit/DeliveryQueueManagerTest.php
git commit -m "Add remove_verified and give_with_condition queue actions."
```

---

## Task 7: Wallet holds for pending vault withdrawals

**Files:**
- Modify: `app/app/Services/WalletService.php:161-176`
- Modify: `app/app/Enums/TransactionSource.php`
- Test: `app/tests/Unit/WalletVaultHoldTest.php`

Without this, a player can spend the same coins on a shop purchase and a vault withdrawal simultaneously.

- [ ] **Step 1: Write the failing test**

```php
<?php

use App\Enums\VaultDirection;
use App\Enums\VaultTransactionStatus;
use App\Models\User;
use App\Models\Vault;
use App\Models\VaultTransaction;
use App\Services\WalletService;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

it('subtracts pending vault withdrawal fees from the available balance', function () {
    $service = app(WalletService::class);
    $user = User::factory()->create();
    $wallet = $service->getOrCreateWallet($user);
    $service->credit($wallet, 100, App\Enums\TransactionSource::AdminAward);

    $vault = Vault::factory()->create(['user_id' => $user->id]);
    VaultTransaction::query()->create([
        'vault_id' => $vault->id,
        'direction' => VaultDirection::Withdraw,
        'status' => VaultTransactionStatus::Pending,
        'full_type' => 'Base.Axe',
        'condition' => 1.0,
        'requested_count' => 1,
        'fee_charged' => 30,
    ]);

    expect($service->getBalance($user))->toBe(100.0)
        ->and($service->getAvailableBalance($user))->toBe(70.0);
});

it('stops holding once the withdrawal is charged', function () {
    $service = app(WalletService::class);
    $user = User::factory()->create();
    $wallet = $service->getOrCreateWallet($user);
    $service->credit($wallet, 100, App\Enums\TransactionSource::AdminAward);

    $vault = Vault::factory()->create(['user_id' => $user->id]);
    VaultTransaction::query()->create([
        'vault_id' => $vault->id,
        'direction' => VaultDirection::Withdraw,
        'status' => VaultTransactionStatus::Completed,
        'full_type' => 'Base.Axe',
        'condition' => 1.0,
        'requested_count' => 1,
        'fee_charged' => 30,
    ]);

    expect($service->getAvailableBalance($user))->toBe(100.0);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `make exec CMD="php artisan test --compact --filter=WalletVaultHoldTest"`
Expected: FAIL — available balance is 100.0, expected 70.0

- [ ] **Step 3: Add the transaction sources**

In `app/app/Enums/TransactionSource.php`, add two cases:

```php
    case VaultFee = 'vault_fee';
    case VaultUpgrade = 'vault_upgrade';
```

- [ ] **Step 4: Extend `getAvailableBalance`**

Replace the body of `getAvailableBalance` (line 161) with:

```php
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

        $pendingHolds += (float) VaultTransaction::query()
            ->whereHas('vault', fn ($q) => $q->where('user_id', $user->id))
            ->where('direction', VaultDirection::Withdraw->value)
            ->where('status', VaultTransactionStatus::Pending->value)
            ->whereNull('wallet_transaction_id')
            ->sum('fee_charged');

        return max(0, $balance - $pendingHolds);
    }
```

Add the imports at the top of the file:

```php
use App\Enums\VaultDirection;
use App\Enums\VaultTransactionStatus;
use App\Models\VaultTransaction;
```

- [ ] **Step 5: Run the tests**

Run: `make exec CMD="php artisan test --compact --filter=WalletVaultHoldTest"`
Expected: PASS, 2 tests

- [ ] **Step 6: Run the shop tests to check nothing regressed**

Run: `make exec CMD="php artisan test --compact --filter=ShopPurchase"`
Expected: no new failures versus baseline

- [ ] **Step 7: Format and commit**

```bash
make exec CMD="vendor/bin/pint --dirty --format agent"
git add app/app/Services/WalletService.php app/app/Enums/TransactionSource.php app/tests/Unit/WalletVaultHoldTest.php
git commit -m "Hold pending vault withdrawal fees against available balance."
```

---

## Task 8: VaultDepositService — items-first deposit

**Files:**
- Create: `app/app/Services/VaultDepositService.php`
- Test: `app/tests/Feature/VaultDepositTest.php`

**Flow:** record a pending transaction → queue `remove_verified` → on result, credit the vault with exactly `removed_count` items, using each reported condition.

- [ ] **Step 1: Write the failing test**

```php
<?php

use App\Enums\VaultTransactionStatus;
use App\Models\User;
use App\Models\Vault;
use App\Models\VaultTransaction;
use App\Services\DeliveryQueueManager;
use App\Services\VaultDepositService;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

function mockVaultQueue(array $results = []): void
{
    $queue = Mockery::mock(DeliveryQueueManager::class);
    $queue->shouldReceive('removeItemVerified')
        ->andReturnUsing(fn (string $u, string $t, int $c) => [
            'id' => 'delivery-1', 'action' => 'remove_verified', 'username' => $u,
            'item_type' => $t, 'count' => $c, 'status' => 'pending', 'created_at' => date('c'),
        ])->byDefault();
    $queue->shouldReceive('readResults')
        ->andReturn(['version' => 1, 'updated_at' => '', 'results' => $results])
        ->byDefault();

    app()->instance(DeliveryQueueManager::class, $queue);
}

it('queues a removal and records a pending transaction', function () {
    mockVaultQueue();
    $user = User::factory()->create();

    $tx = app(VaultDepositService::class)->requestDeposit($user, 'Player1', 'Base.Axe', 'Axe', 'Weapon', 2);

    expect($tx->status)->toBe(VaultTransactionStatus::Pending)
        ->and($tx->requested_count)->toBe(2)
        ->and($tx->delivery_id)->toBe('delivery-1');
});

it('credits the vault with exactly what Lua reported removing', function () {
    mockVaultQueue([[
        'id' => 'delivery-1',
        'status' => 'delivered',
        'processed_at' => date('c'),
        'message' => null,
        'removed_count' => 2,
        'removed' => [
            ['full_type' => 'Base.Axe', 'name' => 'Axe', 'category' => 'Weapon', 'condition' => 0.85],
            ['full_type' => 'Base.Axe', 'name' => 'Axe', 'category' => 'Weapon', 'condition' => 1.0],
        ],
    ]]);

    $user = User::factory()->create();
    $service = app(VaultDepositService::class);
    $tx = $service->requestDeposit($user, 'Player1', 'Base.Axe', 'Axe', 'Weapon', 2);

    $service->processResults();

    $tx->refresh();
    $vault = Vault::query()->where('user_id', $user->id)->first();

    expect($tx->status)->toBe(VaultTransactionStatus::Completed)
        ->and($tx->actual_count)->toBe(2)
        ->and($vault->items()->count())->toBe(2);
});

it('credits a partial removal rather than losing the items', function () {
    mockVaultQueue([[
        'id' => 'delivery-1',
        'status' => 'delivered',
        'processed_at' => date('c'),
        'message' => null,
        'removed_count' => 1,
        'removed' => [
            ['full_type' => 'Base.Axe', 'name' => 'Axe', 'category' => 'Weapon', 'condition' => 1.0],
        ],
    ]]);

    $user = User::factory()->create();
    $service = app(VaultDepositService::class);
    $tx = $service->requestDeposit($user, 'Player1', 'Base.Axe', 'Axe', 'Weapon', 5);

    $service->processResults();

    $tx->refresh();
    $vault = Vault::query()->where('user_id', $user->id)->first();

    expect($tx->status)->toBe(VaultTransactionStatus::Partial)
        ->and($tx->actual_count)->toBe(1)
        ->and($vault->items()->sum('count'))->toBe(1);
});

it('marks the transaction failed when nothing was removed', function () {
    mockVaultQueue([[
        'id' => 'delivery-1', 'status' => 'failed', 'processed_at' => date('c'),
        'message' => 'player not online', 'removed_count' => 0, 'removed' => [],
    ]]);

    $user = User::factory()->create();
    $service = app(VaultDepositService::class);
    $tx = $service->requestDeposit($user, 'Player1', 'Base.Axe', 'Axe', 'Weapon', 1);

    $service->processResults();

    $tx->refresh();
    expect($tx->status)->toBe(VaultTransactionStatus::Failed)
        ->and($tx->actual_count)->toBe(0);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `make exec CMD="php artisan test --compact --filter=VaultDepositTest"`
Expected: FAIL — `Class "App\Services\VaultDepositService" not found`

- [ ] **Step 3: Implement the service**

```php
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
```

- [ ] **Step 4: Run the tests**

Run: `make exec CMD="php artisan test --compact --filter=VaultDepositTest"`
Expected: PASS, 4 tests

- [ ] **Step 5: Format and commit**

```bash
make exec CMD="vendor/bin/pint --dirty --format agent"
git add app/app/Services/VaultDepositService.php app/tests/Feature/VaultDepositTest.php
git commit -m "Add items-first vault deposit crediting exactly what Lua removed."
```

---

## Task 9: VaultWithdrawService — deliver-then-debit

**Files:**
- Create: `app/app/Services/VaultWithdrawService.php`
- Test: `app/tests/Feature/VaultWithdrawTest.php`

**Flow:** check online + balance + fee → reserve by taking items out of the vault → queue `give_with_condition` → on confirmed delivery, debit the fee. On failure, return the items to the vault and charge nothing.

- [ ] **Step 1: Write the failing test**

```php
<?php

use App\Enums\TransactionSource;
use App\Enums\VaultTransactionStatus;
use App\Models\User;
use App\Models\Vault;
use App\Models\VaultSetting;
use App\Services\DeliveryQueueManager;
use App\Services\OnlinePlayersReader;
use App\Services\VaultService;
use App\Services\VaultWithdrawService;
use App\Services\WalletService;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

function mockWithdrawDeps(array $online, array $results = []): void
{
    $queue = Mockery::mock(DeliveryQueueManager::class);
    $queue->shouldReceive('giveItemWithCondition')
        ->andReturnUsing(fn (string $u, string $t, int $c, float $cond) => [
            'id' => 'delivery-w1', 'action' => 'give_with_condition', 'username' => $u,
            'item_type' => $t, 'count' => $c, 'condition' => $cond,
            'status' => 'pending', 'created_at' => date('c'),
        ])->byDefault();
    $queue->shouldReceive('readResults')
        ->andReturn(['version' => 1, 'updated_at' => '', 'results' => $results])
        ->byDefault();
    app()->instance(DeliveryQueueManager::class, $queue);

    $players = Mockery::mock(OnlinePlayersReader::class);
    $players->shouldReceive('getOnlineUsernames')->andReturn($online)->byDefault();
    app()->instance(OnlinePlayersReader::class, $players);
}

function seedVaultUser(float $balance = 100): array
{
    VaultSetting::query()->create(['withdraw_fee_flat' => 10, 'withdraw_fee_per_item' => 1]);
    $user = User::factory()->create(['username' => 'Player1']);
    $wallet = app(WalletService::class)->getOrCreateWallet($user);
    app(WalletService::class)->credit($wallet, $balance, TransactionSource::AdminAward);

    $vault = app(VaultService::class)->getOrCreateVault($user);
    app(VaultService::class)->addItem($vault, 'Base.Axe', 'Axe', 'Weapon', 0.85, 3);

    return [$user, $vault];
}

it('refuses to withdraw when the player is offline', function () {
    mockWithdrawDeps([]);
    [$user] = seedVaultUser();

    expect(fn () => app(VaultWithdrawService::class)->requestWithdrawal($user, 'Player1', 'Base.Axe', 0.85, 1))
        ->toThrow(InvalidArgumentException::class, 'online');
});

it('computes the fee as flat plus per-item', function () {
    mockWithdrawDeps(['Player1']);
    [$user] = seedVaultUser();

    $tx = app(VaultWithdrawService::class)->requestWithdrawal($user, 'Player1', 'Base.Axe', 0.85, 2);

    expect((float) $tx->fee_charged)->toBe(12.0);
});

it('reserves items out of the vault immediately but does not debit yet', function () {
    mockWithdrawDeps(['Player1']);
    [$user, $vault] = seedVaultUser();

    $tx = app(VaultWithdrawService::class)->requestWithdrawal($user, 'Player1', 'Base.Axe', 0.85, 2);

    expect($vault->items()->sum('count'))->toBe(1)
        ->and($tx->wallet_transaction_id)->toBeNull()
        ->and(app(WalletService::class)->getBalance($user))->toBe(100.0);
});

it('debits the fee only after delivery is confirmed', function () {
    mockWithdrawDeps(['Player1'], [[
        'id' => 'delivery-w1', 'status' => 'delivered', 'processed_at' => date('c'), 'message' => null,
    ]]);
    [$user] = seedVaultUser();

    $service = app(VaultWithdrawService::class);
    $tx = $service->requestWithdrawal($user, 'Player1', 'Base.Axe', 0.85, 2);

    $service->processResults();

    $tx->refresh();
    expect($tx->status)->toBe(VaultTransactionStatus::Completed)
        ->and($tx->wallet_transaction_id)->not->toBeNull()
        ->and(app(WalletService::class)->getBalance($user))->toBe(88.0);
});

it('returns items and charges nothing when delivery fails', function () {
    mockWithdrawDeps(['Player1'], [[
        'id' => 'delivery-w1', 'status' => 'failed', 'processed_at' => date('c'), 'message' => 'no space',
    ]]);
    [$user, $vault] = seedVaultUser();

    $service = app(VaultWithdrawService::class);
    $tx = $service->requestWithdrawal($user, 'Player1', 'Base.Axe', 0.85, 2);

    $service->processResults();

    $tx->refresh();
    expect($tx->status)->toBe(VaultTransactionStatus::Failed)
        ->and($vault->items()->sum('count'))->toBe(3)
        ->and(app(WalletService::class)->getBalance($user))->toBe(100.0);
});

it('refuses when the fee exceeds the available balance', function () {
    mockWithdrawDeps(['Player1']);
    [$user] = seedVaultUser(balance: 5);

    expect(fn () => app(VaultWithdrawService::class)->requestWithdrawal($user, 'Player1', 'Base.Axe', 0.85, 1))
        ->toThrow(InvalidArgumentException::class, 'balance');
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `make exec CMD="php artisan test --compact --filter=VaultWithdrawTest"`
Expected: FAIL — `Class "App\Services\VaultWithdrawService" not found`

- [ ] **Step 3: Implement the service**

```php
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
 * debited once Lua confirms delivery. A failed delivery returns the items and
 * charges nothing.
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
            $this->vaultService->addItem(
                $transaction->vault,
                $transaction->full_type,
                $transaction->full_type,
                'General',
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
```

- [ ] **Step 4: Run the tests**

Run: `make exec CMD="php artisan test --compact --filter=VaultWithdrawTest"`
Expected: PASS, 6 tests

- [ ] **Step 5: Format and commit**

```bash
make exec CMD="vendor/bin/pint --dirty --format agent"
git add app/app/Services/VaultWithdrawService.php app/tests/Feature/VaultWithdrawTest.php
git commit -m "Add deliver-then-debit vault withdrawal."
```

---

## Task 10: Capacity upgrades

**Files:**
- Modify: `app/app/Services/VaultService.php`
- Test: `app/tests/Feature/VaultUpgradeTest.php`

- [ ] **Step 1: Write the failing test**

```php
<?php

use App\Enums\TransactionSource;
use App\Models\User;
use App\Models\VaultSetting;
use App\Services\VaultService;
use App\Services\WalletService;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

function upgradeUser(float $balance): User
{
    VaultSetting::query()->create([
        'default_slots' => 10, 'max_slots' => 30,
        'slot_upgrade_increment' => 10, 'slot_upgrade_cost' => 50,
    ]);
    $user = User::factory()->create();
    $wallet = app(WalletService::class)->getOrCreateWallet($user);
    app(WalletService::class)->credit($wallet, $balance, TransactionSource::AdminAward);

    return $user;
}

it('adds slots and debits the cost', function () {
    $user = upgradeUser(100);

    $vault = app(VaultService::class)->purchaseSlots($user);

    expect($vault->slot_capacity)->toBe(20)
        ->and(app(WalletService::class)->getBalance($user))->toBe(50.0);
});

it('refuses when the balance is too low', function () {
    $user = upgradeUser(10);

    expect(fn () => app(VaultService::class)->purchaseSlots($user))
        ->toThrow(InvalidArgumentException::class, 'balance');
});

it('refuses to exceed the configured maximum', function () {
    $user = upgradeUser(1000);
    $service = app(VaultService::class);
    $service->purchaseSlots($user);
    $service->purchaseSlots($user);

    expect(fn () => $service->purchaseSlots($user))
        ->toThrow(InvalidArgumentException::class, 'maximum');
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `make exec CMD="php artisan test --compact --filter=VaultUpgradeTest"`
Expected: FAIL — `Call to undefined method ...::purchaseSlots()`

- [ ] **Step 3: Add `purchaseSlots` to VaultService**

Add the constructor and method (VaultService currently has no constructor):

```php
    public function __construct(private readonly WalletService $walletService) {}

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
```

Add imports: `use App\Enums\TransactionSource;`

- [ ] **Step 4: Run the tests**

Run: `make exec CMD="php artisan test --compact --filter=VaultUpgradeTest"`
Expected: PASS, 3 tests

- [ ] **Step 5: Format and commit**

```bash
make exec CMD="vendor/bin/pint --dirty --format agent"
git add app/app/Services/VaultService.php app/tests/Feature/VaultUpgradeTest.php
git commit -m "Let players buy vault capacity with wallet coins."
```

---

## Task 11: Routes, Form Requests and PlayerVaultController

**Files:**
- Create: `app/app/Http/Controllers/PlayerVaultController.php`
- Create: `app/app/Http/Requests/DepositToVaultRequest.php`, `WithdrawFromVaultRequest.php`
- Modify: `app/routes/web.php`
- Test: `app/tests/Feature/PlayerVaultPageTest.php`

The PZ username is resolved server-side exactly as `PlayerInventoryController` does — the routes never accept a username.

- [ ] **Step 1: Write the failing test**

```php
<?php

use App\Models\User;
use App\Models\WhitelistEntry;
use App\Services\OnlinePlayersReader;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->withoutVite();

    $players = Mockery::mock(OnlinePlayersReader::class);
    $players->shouldReceive('getOnlineUsernames')->andReturn(['Player1'])->byDefault();
    app()->instance(OnlinePlayersReader::class, $players);
});

function vaultPlayer(string $username = 'Player1'): User
{
    $user = User::factory()->create(['username' => $username]);
    WhitelistEntry::factory()->create([
        'user_id' => $user->id, 'pz_username' => $username, 'active' => true,
    ]);

    return $user;
}

it('redirects guests to login', function () {
    $this->get('/portal/vault')->assertRedirect('/login');
});

it('renders the vault page with capacity and contents', function () {
    $response = $this->actingAs(vaultPlayer())->get('/portal/vault');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page
        ->component('portal/vault')
        ->has('items')
        ->has('capacity')
        ->has('fees')
        ->where('hasPzAccount', true)
    );
});

it('rejects a withdrawal of an item the player does not have', function () {
    $response = $this->actingAs(vaultPlayer())->postJson('/portal/vault/withdraw', [
        'full_type' => 'Base.Axe', 'condition' => 1.0, 'count' => 1,
    ]);

    $response->assertStatus(422);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `make exec CMD="php artisan test --compact --filter=PlayerVaultPageTest"`
Expected: FAIL — 404, route not defined

- [ ] **Step 3: Write the Form Requests**

`app/app/Http/Requests/DepositToVaultRequest.php`:
```php
<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class DepositToVaultRequest extends FormRequest
{
    /** @return array<string, array<int, string>> */
    public function rules(): array
    {
        return [
            'full_type' => ['required', 'string', 'max:255'],
            'name' => ['required', 'string', 'max:255'],
            'category' => ['required', 'string', 'max:255'],
            'count' => ['required', 'integer', 'min:1', 'max:100'],
        ];
    }
}
```

`app/app/Http/Requests/WithdrawFromVaultRequest.php`:
```php
<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class WithdrawFromVaultRequest extends FormRequest
{
    /** @return array<string, array<int, string>> */
    public function rules(): array
    {
        return [
            'full_type' => ['required', 'string', 'max:255'],
            'condition' => ['required', 'numeric', 'min:0', 'max:1'],
            'count' => ['required', 'integer', 'min:1', 'max:100'],
        ];
    }
}
```

- [ ] **Step 4: Write the controller**

```php
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
```

- [ ] **Step 5: Register the routes**

In `app/routes/web.php`, inside the existing `Route::middleware(['auth'])` group, after the `portal/inventory` line:

```php
    Route::get('portal/vault', [PlayerVaultController::class, 'show'])->name('portal.vault');
    Route::post('portal/vault/deposit', [PlayerVaultController::class, 'deposit'])->name('portal.vault.deposit')->middleware('throttle:10,1');
    Route::post('portal/vault/withdraw', [PlayerVaultController::class, 'withdraw'])->name('portal.vault.withdraw')->middleware('throttle:10,1');
    Route::post('portal/vault/upgrade', [PlayerVaultController::class, 'upgrade'])->name('portal.vault.upgrade')->middleware('throttle:5,1');
```

Add the import: `use App\Http\Controllers\PlayerVaultController;`

- [ ] **Step 6: Run the tests**

Run: `make exec CMD="php artisan test --compact --filter=PlayerVaultPageTest"`
Expected: PASS, 3 tests

- [ ] **Step 7: Format and commit**

```bash
make exec CMD="vendor/bin/pint --dirty --format agent"
git add app/app/Http/Controllers/PlayerVaultController.php app/app/Http/Requests app/routes/web.php app/tests/Feature/PlayerVaultPageTest.php
git commit -m "Add player vault routes and controller."
```

---

## Task 12: Vault page UI

**Files:**
- Create: `app/resources/js/components/inventory/vault-capacity-meter.tsx`
- Create: `app/resources/js/pages/portal/vault.tsx`
- Modify: `app/resources/js/components/app-sidebar.tsx`
- Modify: `app/resources/js/types/server.ts`

- [ ] **Step 1: Add the types**

Append to `app/resources/js/types/server.ts`:

```ts
export type VaultItemRow = {
    id: string;
    full_type: string;
    name: string;
    category: string;
    condition: number;
    count: number;
    icon: string;
};

export type VaultCapacity = {
    used: number;
    total: number;
    max: number;
    upgrade_cost: number;
    upgrade_increment: number;
};

export type VaultTransactionRow = {
    id: string;
    direction: 'deposit' | 'withdraw';
    status: 'pending' | 'completed' | 'partial' | 'failed';
    full_type: string;
    requested_count: number;
    actual_count: number;
    fee_charged: string;
    created_at: string;
};
```

- [ ] **Step 2: Write the capacity meter**

```tsx
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/use-translation';
import type { VaultCapacity } from '@/types/server';

type Props = {
    capacity: VaultCapacity;
    onUpgrade: () => void;
    upgrading: boolean;
};

export function VaultCapacityMeter({ capacity, onUpgrade, upgrading }: Props) {
    const { t } = useTranslation();
    const percent = capacity.total > 0 ? Math.min(100, (capacity.used / capacity.total) * 100) : 0;
    const atMax = capacity.total >= capacity.max;

    let barClass = 'bg-green-500';
    if (percent >= 90) barClass = 'bg-red-500';
    else if (percent >= 70) barClass = 'bg-yellow-500';

    return (
        <div className="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                    {t('vault.capacity', { used: String(capacity.used), total: String(capacity.total) })}
                </p>
                <div className="mt-2 h-2 w-full rounded-full bg-muted">
                    <div className={`h-2 rounded-full ${barClass}`} style={{ width: `${percent}%` }} />
                </div>
            </div>
            <Button
                variant="outline"
                size="sm"
                disabled={atMax || upgrading}
                onClick={onUpgrade}
                className="sm:ml-4"
            >
                {atMax
                    ? t('vault.at_max')
                    : t('vault.buy_slots', {
                          count: String(capacity.upgrade_increment),
                          cost: String(capacity.upgrade_cost),
                      })}
            </Button>
        </div>
    );
}
```

- [ ] **Step 3: Write the vault page**

```tsx
import { Head, router, usePoll } from '@inertiajs/react';
import { Vault as VaultIcon, X } from 'lucide-react';
import { useState } from 'react';
import { ConditionBar } from '@/components/inventory/condition-bar';
import { ItemIcon } from '@/components/inventory/item-icon';
import { VaultCapacityMeter } from '@/components/inventory/vault-capacity-meter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTranslation } from '@/hooks/use-translation';
import AppLayout from '@/layouts/app-layout';
import { fetchAction } from '@/lib/fetch-action';
import type { BreadcrumbItem } from '@/types';
import type { VaultCapacity, VaultItemRow } from '@/types/server';

type Props = {
    username: string | null;
    hasPzAccount: boolean;
    items: VaultItemRow[];
    capacity: VaultCapacity;
    fees: { flat: number; per_item: number };
    balance: number;
    availableBalance: number;
    transactions: VaultTransactionRow[];
};

export default function PortalVault({ items, capacity, fees, availableBalance, hasPzAccount, transactions }: Props) {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    usePoll(5000, { only: ['items', 'capacity', 'balance', 'availableBalance'] });

    const breadcrumbs: BreadcrumbItem[] = [
        { title: t('portal.title'), href: '/portal' },
        { title: t('vault.title'), href: '/portal/vault' },
    ];

    async function post(url: string, data: Record<string, unknown>) {
        setBusy(true);
        setError(null);
        const result = await fetchAction(url, { data });
        if (!result) {
            setError(t('vault.action_failed'));
        }
        setBusy(false);
        router.reload({ only: ['items', 'capacity', 'balance', 'availableBalance'] });
    }

    return (
        <AppLayout breadcrumbs={breadcrumbs}>
            <Head title={t('vault.title')} />

            <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">{t('vault.title')}</h1>
                    <p className="text-muted-foreground text-sm">{t('vault.description')}</p>
                </div>

                {error && (
                    <div className="flex items-center justify-between rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                        <span>{error}</span>
                        <button onClick={() => setError(null)}>
                            <X className="size-4" />
                        </button>
                    </div>
                )}

                {!hasPzAccount ? (
                    <Card>
                        <CardContent className="py-12 text-center">
                            <p className="font-medium">{t('portal.inventory.no_account')}</p>
                            <p className="text-muted-foreground text-sm">{t('portal.inventory.no_account_desc')}</p>
                        </CardContent>
                    </Card>
                ) : (
                    <>
                        <VaultCapacityMeter
                            capacity={capacity}
                            upgrading={busy}
                            onUpgrade={() => post('/portal/vault/upgrade', {})}
                        />

                        <Card>
                            <CardHeader>
                                <CardTitle>{t('vault.stored_items')}</CardTitle>
                                <CardDescription>
                                    {t('vault.fee_note', {
                                        flat: String(fees.flat),
                                        per_item: String(fees.per_item),
                                        balance: String(availableBalance),
                                    })}
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="overflow-x-auto">
                                {items.length > 0 ? (
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead className="w-[50px]" />
                                                <TableHead>{t('inventory.item')}</TableHead>
                                                <TableHead>{t('common.category')}</TableHead>
                                                <TableHead className="text-center">{t('inventory.qty')}</TableHead>
                                                <TableHead className="w-[120px]">{t('inventory.condition')}</TableHead>
                                                <TableHead>{t('common.actions')}</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {items.map((item) => (
                                                <TableRow key={item.id}>
                                                    <TableCell>
                                                        <ItemIcon src={item.icon} name={item.name} size={32} />
                                                    </TableCell>
                                                    <TableCell>
                                                        <div className="flex min-w-0 flex-col">
                                                            <span className="text-sm font-medium">{item.name}</span>
                                                            <span className="text-muted-foreground text-xs">{item.full_type}</span>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell>
                                                        <Badge variant="outline" className="text-xs">{item.category}</Badge>
                                                    </TableCell>
                                                    <TableCell className="text-center tabular-nums">{item.count}</TableCell>
                                                    <TableCell>
                                                        <ConditionBar condition={item.condition} />
                                                    </TableCell>
                                                    <TableCell>
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            disabled={busy}
                                                            onClick={() =>
                                                                post('/portal/vault/withdraw', {
                                                                    full_type: item.full_type,
                                                                    condition: item.condition,
                                                                    count: 1,
                                                                })
                                                            }
                                                        >
                                                            {t('vault.withdraw')}
                                                        </Button>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                ) : (
                                    <div className="flex flex-col items-center gap-3 py-12 text-center">
                                        <VaultIcon className="text-muted-foreground size-8" />
                                        <div>
                                            <p className="font-medium">{t('vault.empty')}</p>
                                            <p className="text-muted-foreground text-sm">{t('vault.empty_desc')}</p>
                                        </div>
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>{t('vault.history')}</CardTitle>
                            </CardHeader>
                            <CardContent className="overflow-x-auto">
                                {transactions.length > 0 ? (
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>{t('vault.direction')}</TableHead>
                                                <TableHead>{t('inventory.item')}</TableHead>
                                                <TableHead className="text-center">{t('inventory.qty')}</TableHead>
                                                <TableHead>{t('vault.fee')}</TableHead>
                                                <TableHead>{t('common.status')}</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {transactions.map((tx) => (
                                                <TableRow key={tx.id}>
                                                    <TableCell className="text-sm">
                                                        {tx.direction === 'deposit' ? t('vault.deposit') : t('vault.withdraw')}
                                                    </TableCell>
                                                    <TableCell className="text-muted-foreground text-sm">{tx.full_type}</TableCell>
                                                    <TableCell className="text-center tabular-nums">
                                                        {tx.actual_count} / {tx.requested_count}
                                                    </TableCell>
                                                    <TableCell className="tabular-nums">{tx.fee_charged}</TableCell>
                                                    <TableCell>
                                                        <Badge
                                                            variant={tx.status === 'failed' ? 'destructive' : 'secondary'}
                                                            className="text-xs"
                                                        >
                                                            {tx.status}
                                                        </Badge>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                ) : (
                                    <p className="text-muted-foreground py-4 text-center text-sm">
                                        {t('vault.no_history')}
                                    </p>
                                )}
                            </CardContent>
                        </Card>
                    </>
                )}
            </div>
        </AppLayout>
    );
}
```

Add `VaultTransactionRow` to the `@/types/server` import list at the top of the file, and include `transactions` in the `usePoll` `only` array so history refreshes with the rest.

- [ ] **Step 4: Add the nav entry**

In `app/resources/js/components/app-sidebar.tsx`, add `Vault` to the lucide import list and insert into `playerNavGroups` after the My Inventory entry:

```tsx
                { title: t('nav.my_vault'), href: '/portal/vault', icon: Vault },
```

- [ ] **Step 5: Type-check**

Run: `make exec CMD="npx tsc --noEmit"`
Expected: no errors in `pages/portal/vault.tsx` or `components/inventory/vault-capacity-meter.tsx`

- [ ] **Step 6: Commit**

```bash
git add app/resources/js
git commit -m "Add the player vault page and capacity meter."
```

---

## Task 13: Deposit action on the inventory page

**Files:**
- Modify: `app/resources/js/pages/portal/inventory.tsx`

This uses the `rowActions` slot already present on `InventoryTable`.

- [ ] **Step 1: Add the deposit handler and row action**

Replace `<InventoryTable items={stackedItems} />` with:

```tsx
                        <InventoryTable
                            items={stackedItems}
                            rowActions={(item) => (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={depositing !== null}
                                    onClick={() => handleDeposit(item)}
                                >
                                    {t('vault.deposit')}
                                </Button>
                            )}
                        />
```

and add above the `return`:

```tsx
    const [depositing, setDepositing] = useState<string | null>(null);

    async function handleDeposit(item: StackedItem) {
        setDepositing(item.full_type);
        await fetchAction('/portal/vault/deposit', {
            data: {
                full_type: item.full_type,
                name: item.name,
                category: item.category,
                count: item.totalCount,
            },
        });
        setDepositing(null);
        router.reload({ only: ['inventory'] });
    }
```

Add the imports: `useState` from `react`, `router` from `@inertiajs/react`, `Button` from `@/components/ui/button`, `fetchAction` from `@/lib/fetch-action`, and `StackedItem` from `@/types/server`.

- [ ] **Step 2: Type-check**

Run: `make exec CMD="npx tsc --noEmit"`
Expected: no errors in `pages/portal/inventory.tsx`

- [ ] **Step 3: Commit**

```bash
git add app/resources/js/pages/portal/inventory.tsx
git commit -m "Add deposit-to-vault action to the player inventory table."
```

---

## Task 14: Admin vault settings

**Files:**
- Create: `app/app/Http/Controllers/Admin/VaultSettingController.php`
- Create: `app/app/Http/Requests/Admin/UpdateVaultSettingsRequest.php`
- Create: `app/resources/js/pages/admin/vault-settings.tsx`
- Modify: `app/routes/web.php`, `app/resources/js/components/app-sidebar.tsx`
- Test: `app/tests/Feature/AdminVaultSettingsTest.php`

- [ ] **Step 1: Write the failing test**

```php
<?php

use App\Models\User;
use App\Models\VaultSetting;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(fn () => $this->withoutVite());

it('renders the vault settings page for admins', function () {
    $response = $this->actingAs(User::factory()->admin()->create())->get('/admin/vault');

    $response->assertOk();
    $response->assertInertia(fn ($page) => $page->component('admin/vault-settings')->has('settings'));
});

it('blocks non-admins', function () {
    $this->actingAs(User::factory()->create())->get('/admin/vault')->assertForbidden();
});

it('updates the settings', function () {
    $admin = User::factory()->admin()->create();

    $this->actingAs($admin)->patch('/admin/vault', [
        'default_slots' => 20, 'max_slots' => 200, 'slot_upgrade_increment' => 5,
        'slot_upgrade_cost' => 75, 'withdraw_fee_flat' => 3,
        'withdraw_fee_per_item' => 0.5, 'enabled' => true,
    ])->assertRedirect();

    expect(VaultSetting::instance()->default_slots)->toBe(20)
        ->and(VaultSetting::instance()->withdraw_fee_flat)->toBe(3.0);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `make exec CMD="php artisan test --compact --filter=AdminVaultSettingsTest"`
Expected: FAIL — 404

- [ ] **Step 3: Write the Form Request**

```php
<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;

class UpdateVaultSettingsRequest extends FormRequest
{
    /** @return array<string, array<int, string>> */
    public function rules(): array
    {
        return [
            'default_slots' => ['required', 'integer', 'min:1', 'max:10000'],
            'max_slots' => ['required', 'integer', 'min:1', 'max:10000'],
            'slot_upgrade_increment' => ['required', 'integer', 'min:1', 'max:1000'],
            'slot_upgrade_cost' => ['required', 'numeric', 'min:0', 'max:1000000'],
            'withdraw_fee_flat' => ['required', 'numeric', 'min:0', 'max:1000000'],
            'withdraw_fee_per_item' => ['required', 'numeric', 'min:0', 'max:1000000'],
            'enabled' => ['required', 'boolean'],
        ];
    }
}
```

- [ ] **Step 4: Write the controller**

```php
<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\UpdateVaultSettingsRequest;
use App\Models\VaultSetting;
use App\Services\AuditLogger;
use Illuminate\Http\RedirectResponse;
use Inertia\Inertia;
use Inertia\Response;

class VaultSettingController extends Controller
{
    public function __construct(private readonly AuditLogger $auditLogger) {}

    public function index(): Response
    {
        return Inertia::render('admin/vault-settings', [
            'settings' => VaultSetting::instance(),
        ]);
    }

    public function update(UpdateVaultSettingsRequest $request): RedirectResponse
    {
        $validated = $request->validated();

        $settings = VaultSetting::instance();
        $settings->fill($validated);
        $settings->save();

        $this->auditLogger->log(
            actor: $request->user()->username ?? 'admin',
            action: 'vault.settings.update',
            target: 'vault_settings',
            details: $validated,
            ip: $request->ip(),
        );

        return back();
    }
}
```

- [ ] **Step 5: Register the routes**

Inside the admin group in `app/routes/web.php`:

```php
        // Vault
        Route::get('vault', [Admin\VaultSettingController::class, 'index'])->name('vault');
        Route::patch('vault', [Admin\VaultSettingController::class, 'update'])->name('vault.update')->middleware('throttle:admin-sensitive');
```

- [ ] **Step 6: Write the admin page**

`app/resources/js/pages/admin/vault-settings.tsx`:

```tsx
import { Head, useForm } from '@inertiajs/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/hooks/use-translation';
import AppLayout from '@/layouts/app-layout';
import type { BreadcrumbItem } from '@/types';

type Settings = {
    default_slots: number;
    max_slots: number;
    slot_upgrade_increment: number;
    slot_upgrade_cost: number;
    withdraw_fee_flat: number;
    withdraw_fee_per_item: number;
    enabled: boolean;
};

type Props = { settings: Settings };

const NUMBER_FIELDS: Array<keyof Settings> = [
    'default_slots',
    'max_slots',
    'slot_upgrade_increment',
    'slot_upgrade_cost',
    'withdraw_fee_flat',
    'withdraw_fee_per_item',
];

export default function VaultSettings({ settings }: Props) {
    const { t } = useTranslation();
    const { data, setData, patch, processing } = useForm<Settings>({
        default_slots: settings.default_slots,
        max_slots: settings.max_slots,
        slot_upgrade_increment: settings.slot_upgrade_increment,
        slot_upgrade_cost: settings.slot_upgrade_cost,
        withdraw_fee_flat: settings.withdraw_fee_flat,
        withdraw_fee_per_item: settings.withdraw_fee_per_item,
        enabled: settings.enabled,
    });

    const breadcrumbs: BreadcrumbItem[] = [
        { title: t('nav.dashboard'), href: '/dashboard' },
        { title: t('admin.vault.title'), href: '/admin/vault' },
    ];

    return (
        <AppLayout breadcrumbs={breadcrumbs}>
            <Head title={t('admin.vault.title')} />

            <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">{t('admin.vault.title')}</h1>
                    <p className="text-muted-foreground text-sm">{t('admin.vault.description')}</p>
                </div>

                <Card>
                    <CardHeader>
                        <CardTitle>{t('admin.vault.settings')}</CardTitle>
                        <CardDescription>{t('admin.vault.settings_desc')}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="flex items-center justify-between">
                            <Label htmlFor="vault-enabled">{t('admin.vault.enabled')}</Label>
                            <Switch
                                id="vault-enabled"
                                checked={data.enabled}
                                onCheckedChange={(checked) => setData('enabled', checked)}
                            />
                        </div>

                        <div className="grid gap-4 sm:grid-cols-2">
                            {NUMBER_FIELDS.map((field) => (
                                <div key={field} className="space-y-2">
                                    <Label htmlFor={`vault-${field}`}>{t(`admin.vault.${field}`)}</Label>
                                    <Input
                                        id={`vault-${field}`}
                                        type="number"
                                        min={0}
                                        step="0.01"
                                        value={String(data[field])}
                                        onChange={(e) => setData(field, Number(e.target.value) as never)}
                                    />
                                </div>
                            ))}
                        </div>

                        <Button disabled={processing} onClick={() => patch('/admin/vault', { preserveScroll: true })}>
                            {processing ? t('common.saving') : t('common.save')}
                        </Button>
                    </CardContent>
                </Card>
            </div>
        </AppLayout>
    );
}
```

- [ ] **Step 7: Add the admin nav entry**

In `app_sidebar.tsx`, add to the shop group: `{ title: t('nav.vault'), href: '/admin/vault', icon: Vault },`

- [ ] **Step 8: Run the tests**

Run: `make exec CMD="php artisan test --compact --filter=AdminVaultSettingsTest"`
Expected: PASS, 3 tests

- [ ] **Step 9: Format and commit**

```bash
make exec CMD="vendor/bin/pint --dirty --format agent"
git add app/app/Http/Controllers/Admin/VaultSettingController.php app/app/Http/Requests/Admin app/routes/web.php app/resources/js app/tests/Feature/AdminVaultSettingsTest.php
git commit -m "Add admin vault settings page."
```

---

## Task 15: Translations

**Files:**
- Modify: `app/lang/en.json`, `app/lang/ka.json`

- [ ] **Step 1: Add the English keys**

Insert alphabetically. `nav.my_vault`, `nav.vault`, then the `vault.*` block, then `admin.vault.*`:

```json
    "nav.my_vault": "My Vault",
    "nav.vault": "Vault",
    "vault.action_failed": "Action failed. Please try again.",
    "vault.at_max": "Maximum size reached",
    "vault.buy_slots": "Buy :count slots (:cost coins)",
    "vault.capacity": ":used / :total slots used",
    "vault.deposit": "Store",
    "vault.description": "Items you have stored out of the game world. Withdraw them back to your character for a fee.",
    "vault.direction": "Action",
    "vault.empty": "Your vault is empty",
    "vault.empty_desc": "Store items from your inventory to keep them safe outside the game world.",
    "vault.fee": "Fee",
    "vault.fee_note": "Withdrawal costs :flat coins plus :per_item per item. You have :balance available.",
    "vault.history": "Recent Activity",
    "vault.no_history": "No vault activity yet",
    "vault.stored_items": "Stored Items",
    "vault.title": "My Vault",
    "vault.withdraw": "Withdraw"
```

And the admin keys — one per field rendered by `NUMBER_FIELDS` in Task 14 Step 6, plus the page chrome:

```json
    "admin.vault.default_slots": "Default slots for new vaults",
    "admin.vault.description": "Capacity and withdrawal pricing for player item vaults.",
    "admin.vault.enabled": "Vault enabled",
    "admin.vault.max_slots": "Maximum slots a vault can reach",
    "admin.vault.settings": "Vault Settings",
    "admin.vault.settings_desc": "Changes apply immediately to all players.",
    "admin.vault.slot_upgrade_cost": "Cost per upgrade (coins)",
    "admin.vault.slot_upgrade_increment": "Slots added per upgrade",
    "admin.vault.title": "Item Vault",
    "admin.vault.withdraw_fee_flat": "Flat withdrawal fee (coins)",
    "admin.vault.withdraw_fee_per_item": "Additional fee per item (coins)"
```

- [ ] **Step 2: Add the Georgian keys**

Mirror every key added above into `app/lang/ka.json` at the matching alphabetical position.

- [ ] **Step 3: Verify both files parse and have matching keys**

Run:
```bash
node -e "
const en=require('./app/lang/en.json'), ka=require('./app/lang/ka.json');
const missing=Object.keys(en).filter(k=>k.startsWith('vault.')||k.startsWith('admin.vault.')||k==='nav.my_vault'||k==='nav.vault').filter(k=>!(k in ka));
console.log(missing.length? 'MISSING IN ka: '+missing.join(', ') : 'all vault keys present in both');
"
```
Expected: `all vault keys present in both`

- [ ] **Step 4: Commit**

```bash
git add app/lang/en.json app/lang/ka.json
git commit -m "Add vault translation keys."
```

---

## Task 16: Full verification and status update

- [ ] **Step 1: Run the whole suite**

Run: `make test`
Expected: no failures beyond the 10 known pre-existing ones (`LuaBridgeHealthServiceTest`, `MapConfigBuilderTest` ×2, `MapTileStoreTest` ×3, `MoneyDepositPreviewTest`, `AdminPagesTest` ×2, `ShopPurchaseTest`)

- [ ] **Step 2: Type-check and build**

Run: `make exec CMD="npx tsc --noEmit"` then `make exec CMD="npm run build"`
Expected: no new type errors; build succeeds

- [ ] **Step 3: Format**

Run: `make exec CMD="vendor/bin/pint --dirty --format agent"`
Expected: `{"result":"pass"}`

- [ ] **Step 4: Add the Phase 24 row to `IMPLEMENTATION_PLAN.md`**

Append to the status table:

```markdown
| Phase 24 — Player Item Vault | DONE | Vaults/vault_items/vault_transactions schema, items-first deposit with remove_verified, deliver-then-debit withdrawal with give_with_condition, coin-purchasable capacity, admin settings page |
```

- [ ] **Step 5: Commit**

```bash
git add IMPLEMENTATION_PLAN.md
git commit -m "Record Phase 24 in the implementation status table."
```

---

## Deployment Notes

The Lua mod changed, so this is **not** a web-only deploy:

1. `make update` (rebuilds app, runs migrations, restarts game-server)
2. Re-package and re-upload the workshop mod: `make workshop-package`
3. The game server must load the new mod version before deposits or withdrawals will work — until then, `remove_verified` and `give_with_condition` entries sit in the queue unprocessed and their transactions stay `pending`.

Because unprocessed entries stay pending rather than failing, deploying the web side before the mod is safe: nothing is lost, transactions simply settle once the mod catches up.

## Deliberately Out of Scope

Cut from the approved design to keep this plan to one shippable slice. Each is a
follow-up, not an oversight:

- **Admin read-only view of a player's vault, with force-return.** The design
  mentioned it as a support escape hatch. Admins can still inspect
  `vault_items` directly, and every movement is recorded in `vault_transactions`,
  so nothing is unrecoverable without it.
- **Choosing which condition to deposit.** Depositing picks whichever matching
  items Lua finds first (see Known Limitations).
- **Player-to-player trading.** Separate feature; the vault is a prerequisite.

## Known Limitations

- Condition is stored to 2 decimal places, matching the exporter, so a withdrawn item can differ from the deposited one by up to 1%.
- Deposits move a whole stack of one `(full_type)` at a time. Depositing "2 of my 5 axes" picks whichever the Lua side finds first, so conditions are not chooseable at deposit time.
- Items with data beyond type and condition (custom names, contained liquids, attached parts, ammo counts) are **not** preserved — they come back as clean items of that type at the stored condition. Do not deploy this without either accepting that or blocking such items.
