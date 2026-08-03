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
