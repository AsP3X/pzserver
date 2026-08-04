<?php

namespace Database\Factories;

use App\Models\VehicleKeyHolder;
use Illuminate\Database\Eloquent\Factories\Factory;

/** @extends Factory<VehicleKeyHolder> */
class VehicleKeyHolderFactory extends Factory
{
    protected $model = VehicleKeyHolder::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        return [
            'vehicle_id' => fake()->unique()->numberBetween(1, 5000),
            'key_id' => fake()->numberBetween(1, 5000),
            'username' => fake()->userName(),
            'last_seen_at' => now(),
        ];
    }
}
