<?php

namespace Database\Factories;

use App\Models\PvpViolation;
use Illuminate\Database\Eloquent\Factories\Factory;

/** @extends Factory<PvpViolation> */
class PvpViolationFactory extends Factory
{
    protected $model = PvpViolation::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        return [
            'attacker' => fake()->userName(),
            'victim' => fake()->userName(),
            'zone_id' => 'zone_' . fake()->randomNumber(3),
            'zone_name' => fake()->randomElement(['Spawn', 'Market', 'Hospital', 'Safe House']),
            'attacker_x' => fake()->numberBetween(8000, 12000),
            'attacker_y' => fake()->numberBetween(8000, 12000),
            'strike_number' => fake()->numberBetween(2, 5),
            'status' => 'pending',
            'occurred_at' => fake()->dateTimeBetween('-7 days'),
        ];
    }

    public function dismissed(): static
    {
        return $this->state(fn () => [
            'status' => 'dismissed',
            'resolved_by' => 'admin',
            'resolution_note' => 'Accidental hit',
            'resolved_at' => now(),
        ]);
    }

    public function actioned(): static
    {
        return $this->state(fn () => [
            'status' => 'actioned',
            'resolved_by' => 'admin',
            'resolution_note' => 'Player kicked for repeated violations',
            'resolved_at' => now(),
        ]);
    }
}
