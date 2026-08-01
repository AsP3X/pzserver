<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\UpdateDiscordWebhookRequest;
use App\Models\DiscordWebhookSetting;
use App\Services\AuditLogger;
use App\Services\DiscordWebhookService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

class DiscordWebhookController extends Controller
{
    public function __construct(
        private readonly AuditLogger $auditLogger,
        private readonly DiscordWebhookService $discordWebhook,
    ) {}

    public function index(): Response
    {
        $settings = DiscordWebhookSetting::instance();

        return Inertia::render('admin/discord-webhook', [
            'settings' => [
                'has_webhook_url' => (bool) $settings->webhook_url,
                'webhook_url_masked' => $settings->webhook_url
                    ? str_repeat("\u{2022}", 8)
                    : null,
                'enabled' => $settings->enabled,
                'enabled_events' => $settings->enabled_events ?? [],
            ],
            'available_events' => DiscordWebhookSetting::availableEvents(),
        ]);
    }

    public function update(UpdateDiscordWebhookRequest $request): JsonResponse
    {
        $settings = DiscordWebhookSetting::instance();
        $validated = $request->validated();

        // Only update webhook_url if explicitly provided
        if (array_key_exists('webhook_url', $validated)) {
            $settings->webhook_url = $validated['webhook_url'];
        }

        if (array_key_exists('enabled', $validated)) {
            $settings->enabled = $validated['enabled'];
        }

        if (array_key_exists('enabled_events', $validated)) {
            $settings->enabled_events = $validated['enabled_events'];
        }

        $settings->save();

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'discord.webhook.update',
            details: [
                'enabled' => $settings->enabled,
                'events_count' => count($settings->enabled_events ?? []),
                'url_changed' => array_key_exists('webhook_url', $validated),
            ],
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Discord webhook settings updated']);
    }

    public function test(Request $request): JsonResponse
    {
        $settings = DiscordWebhookSetting::instance();

        if (! $settings->webhook_url) {
            return response()->json([
                'success' => false,
                'error' => 'No webhook URL configured',
            ], 422);
        }

        $result = $this->discordWebhook->sendTestMessage($settings->webhook_url);

        return response()->json($result);
    }
}
