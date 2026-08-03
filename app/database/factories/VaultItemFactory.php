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
