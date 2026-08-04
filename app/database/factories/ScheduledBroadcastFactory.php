<?php

namespace Database\Factories;

use App\Enums\BroadcastCadence;
use App\Models\ScheduledBroadcast;
use Illuminate\Database\Eloquent\Factories\Factory;

/** @extends Factory<ScheduledBroadcast> */
class ScheduledBroadcastFactory extends Factory
{
    protected $model = ScheduledBroadcast::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        return [
            'message' => fake()->sentence(),
            'cadence' => BroadcastCadence::Interval,
            'interval_minutes' => 60,
            'time' => null,
            'timezone' => 'Asia/Tbilisi',
            'enabled' => true,
            'last_sent_at' => null,
        ];
    }

    public function daily(string $time = '18:00'): static
    {
        return $this->state([
            'cadence' => BroadcastCadence::Daily,
            'interval_minutes' => null,
            'time' => $time,
        ]);
    }

    public function disabled(): static
    {
        return $this->state(['enabled' => false]);
    }
}
