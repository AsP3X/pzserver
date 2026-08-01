<?php

namespace Database\Factories;

use App\Models\DiscordWebhookSetting;
use Illuminate\Database\Eloquent\Factories\Factory;

/** @extends Factory<DiscordWebhookSetting> */
class DiscordWebhookSettingFactory extends Factory
{
    protected $model = DiscordWebhookSetting::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        return [
            'webhook_url' => 'https://discord.com/api/webhooks/123456789/fake-token',
            'enabled' => false,
            'enabled_events' => [],
        ];
    }

    public function enabled(): static
    {
        return $this->state([
            'enabled' => true,
        ]);
    }

    /**
     * @param  array<int, string>  $events
     */
    public function withEvents(array $events): static
    {
        return $this->state([
            'enabled_events' => $events,
        ]);
    }
}
