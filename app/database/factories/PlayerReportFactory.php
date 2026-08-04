<?php

namespace Database\Factories;

use App\Enums\ReportKind;
use App\Enums\ReportStatus;
use App\Models\PlayerReport;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/** @extends Factory<PlayerReport> */
class PlayerReportFactory extends Factory
{
    protected $model = PlayerReport::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        return [
            'user_id' => User::factory(),
            'kind' => ReportKind::Support,
            'subject' => fake()->sentence(4),
            'body' => fake()->paragraph(),
            'accused' => null,
            'status' => ReportStatus::Open,
            'resolution' => null,
            'handled_by' => null,
            'handled_at' => null,
        ];
    }

    public function accusing(string $username = 'Mallory'): static
    {
        return $this->state([
            'kind' => ReportKind::Report,
            'accused' => $username,
        ]);
    }

    public function resolved(): static
    {
        return $this->state([
            'status' => ReportStatus::Resolved,
            'resolution' => 'Handled.',
            'handled_at' => now(),
        ]);
    }
}
