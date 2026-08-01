<?php

namespace Database\Factories;

use App\Models\AutoRestartSetting;
use Illuminate\Database\Eloquent\Factories\Factory;

/** @extends Factory<AutoRestartSetting> */
class AutoRestartSettingFactory extends Factory
{
    protected $model = AutoRestartSetting::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        return [
            'enabled' => false,
            'warning_minutes' => 5,
            'warning_message' => null,
            'timezone' => 'Asia/Tbilisi',
            'discord_reminder_minutes' => 30,
        ];
    }

    public function enabled(): static
    {
        return $this->state([
            'enabled' => true,
        ]);
    }
}
