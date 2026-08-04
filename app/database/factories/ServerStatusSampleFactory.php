<?php

namespace Database\Factories;

use App\Models\ServerStatusSample;
use Illuminate\Database\Eloquent\Factories\Factory;

/** @extends Factory<ServerStatusSample> */
class ServerStatusSampleFactory extends Factory
{
    protected $model = ServerStatusSample::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        return [
            'online' => true,
            'player_count' => fake()->numberBetween(0, 20),
            'game_status' => 'online',
            'sampled_at' => now(),
        ];
    }

    public function offline(): static
    {
        return $this->state([
            'online' => false,
            'player_count' => 0,
            'game_status' => 'offline',
        ]);
    }
}
