<?php

use App\Models\User;
use App\Models\Vault;
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

it('returns the same vault on repeat access', function () {
    $user = User::factory()->create();

    $first = $this->service->getOrCreateVault($user);
    $second = $this->service->getOrCreateVault($user);

    expect($second->id)->toBe($first->id)
        ->and(Vault::query()->count())->toBe(1);
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

it('refuses to create a new stack when the vault is full', function () {
    $vault = Vault::factory()->create(['slot_capacity' => 1]);
    $this->service->addItem($vault, 'Base.Axe', 'Axe', 'Weapon', 1.0, 1);

    expect(fn () => $this->service->addItem($vault, 'Base.Rope', 'Rope', 'Material', 1.0, 1))
        ->toThrow(InvalidArgumentException::class, 'full');
});

it('removes a stack entirely when its count reaches zero', function () {
    $vault = Vault::factory()->create();
    $this->service->addItem($vault, 'Base.Axe', 'Axe', 'Weapon', 1.0, 2);

    $this->service->takeItem($vault, 'Base.Axe', 1.0, 2);

    expect($vault->items()->count())->toBe(0);
});

it('leaves the remainder behind on a partial take', function () {
    $vault = Vault::factory()->create();
    $this->service->addItem($vault, 'Base.Axe', 'Axe', 'Weapon', 1.0, 5);

    $this->service->takeItem($vault, 'Base.Axe', 1.0, 2);

    expect($vault->items()->first()->count)->toBe(3);
});

it('refuses to take more items than the stack holds', function () {
    $vault = Vault::factory()->create();
    $this->service->addItem($vault, 'Base.Axe', 'Axe', 'Weapon', 1.0, 1);

    expect(fn () => $this->service->takeItem($vault, 'Base.Axe', 1.0, 5))
        ->toThrow(InvalidArgumentException::class);
});

it('matches stored conditions after rounding to two decimals', function () {
    $vault = Vault::factory()->create();
    $this->service->addItem($vault, 'Base.Axe', 'Axe', 'Weapon', 0.8549, 1);

    $this->service->takeItem($vault, 'Base.Axe', 0.85, 1);

    expect($vault->items()->count())->toBe(0);
});
