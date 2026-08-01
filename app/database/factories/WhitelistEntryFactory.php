<?php

namespace Database\Factories;

use App\Models\WhitelistEntry;
use Illuminate\Database\Eloquent\Factories\Factory;

/** @extends Factory<WhitelistEntry> */
class WhitelistEntryFactory extends Factory
{
    protected $model = WhitelistEntry::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        return [
            'pz_username' => fake()->unique()->userName(),
            'pz_password_hash' => fake()->sha256(),
            'active' => true,
            'synced_at' => now(),
        ];
    }

    public function inactive(): static
    {
        return $this->state(['active' => false]);
    }
}
