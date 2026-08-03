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
