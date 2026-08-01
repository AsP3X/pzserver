<?php

namespace Database\Factories;

use App\Models\ScheduledRestartTime;
use Illuminate\Database\Eloquent\Factories\Factory;

/** @extends Factory<ScheduledRestartTime> */
class ScheduledRestartTimeFactory extends Factory
{
    protected $model = ScheduledRestartTime::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        return [
            'time' => sprintf('%02d:00', fake()->numberBetween(0, 23)),
            'enabled' => true,
        ];
    }

    public function disabled(): static
    {
        return $this->state([
            'enabled' => false,
        ]);
    }
}
