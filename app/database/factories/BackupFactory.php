<?php

namespace Database\Factories;

use App\Enums\BackupType;
use App\Models\Backup;
use Illuminate\Database\Eloquent\Factories\Factory;

/** @extends Factory<Backup> */
class BackupFactory extends Factory
{
    protected $model = Backup::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        $type = fake()->randomElement(BackupType::cases());

        return [
            'filename' => 'backup_'.fake()->dateTimeThisMonth()->format('Y-m-d_H-i-s').'.tar.gz',
            'path' => '/backups/backup_'.fake()->dateTimeThisMonth()->format('Y-m-d_H-i-s').'.tar.gz',
            'size_bytes' => fake()->numberBetween(1024 * 1024, 500 * 1024 * 1024),
            'type' => $type,
            'game_version' => fake()->optional(0.7)->numerify('4#.#.##'),
            'steam_branch' => fake()->optional(0.7)->randomElement(['public', 'unstable', 'iwillbackupmysave']),
            'notes' => fake()->optional(0.3)->sentence(),
            'created_at' => fake()->dateTimeBetween('-30 days'),
        ];
    }

    public function manual(): static
    {
        return $this->state(['type' => BackupType::Manual]);
    }

    public function scheduled(): static
    {
        return $this->state(['type' => BackupType::Scheduled]);
    }

    public function daily(): static
    {
        return $this->state(['type' => BackupType::Daily]);
    }

    public function preRollback(): static
    {
        return $this->state(['type' => BackupType::PreRollback]);
    }
}
