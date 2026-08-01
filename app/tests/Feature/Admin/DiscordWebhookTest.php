<?php

use App\Enums\UserRole;
use App\Jobs\SendDiscordWebhookNotification;
use App\Models\AuditLog;
use App\Models\DiscordWebhookSetting;
use App\Models\User;
use App\Services\DiscordWebhookService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->admin = User::factory()->admin()->create();
});

// ── Page rendering ───────────────────────────────────────────────────

describe('Discord webhook page', function () {
    it('renders the settings page', function () {
        $this->actingAs($this->admin)
            ->get(route('admin.discord'))
            ->assertOk()
            ->assertInertia(fn ($page) => $page
                ->component('admin/discord-webhook')
                ->has('settings')
                ->has('available_events')
            );
    });

    it('requires authentication', function () {
        $this->get(route('admin.discord'))
            ->assertRedirect('/login');
    });

    it('requires admin role', function () {
        $player = User::factory()->create(['role' => UserRole::Player]);

        $this->actingAs($player)
            ->get(route('admin.discord'))
            ->assertForbidden();
    });

    it('does not expose webhook URL in response', function () {
        DiscordWebhookSetting::factory()->enabled()->create();

        $this->actingAs($this->admin)
            ->get(route('admin.discord'))
            ->assertOk()
            ->assertInertia(fn ($page) => $page
                ->component('admin/discord-webhook')
                ->where('settings.has_webhook_url', true)
                ->where('settings.webhook_url_masked', '••••••••')
            );
    });
});

// ── Settings update ──────────────────────────────────────────────────

describe('Discord webhook settings update', function () {
    it('updates enabled flag', function () {
        DiscordWebhookSetting::factory()->create();

        $this->actingAs($this->admin)
            ->patchJson(route('admin.discord.update'), [
                'enabled' => true,
            ])
            ->assertOk()
            ->assertJson(['message' => 'Discord webhook settings updated']);

        expect(DiscordWebhookSetting::instance()->enabled)->toBeTrue();
    });

    it('updates webhook URL', function () {
        DiscordWebhookSetting::factory()->create();

        $this->actingAs($this->admin)
            ->patchJson(route('admin.discord.update'), [
                'webhook_url' => 'https://discord.com/api/webhooks/999/new-token',
            ])
            ->assertOk();

        expect(DiscordWebhookSetting::instance()->webhook_url)
            ->toBe('https://discord.com/api/webhooks/999/new-token');
    });

    it('updates enabled events', function () {
        DiscordWebhookSetting::factory()->create();

        $events = ['server.start', 'server.stop', 'player.kick'];

        $this->actingAs($this->admin)
            ->patchJson(route('admin.discord.update'), [
                'enabled_events' => $events,
            ])
            ->assertOk();

        expect(DiscordWebhookSetting::instance()->enabled_events)->toBe($events);
    });

    it('allows partial updates without re-entering URL', function () {
        DiscordWebhookSetting::factory()->enabled()->withEvents(['server.start'])->create();

        $this->actingAs($this->admin)
            ->patchJson(route('admin.discord.update'), [
                'enabled' => false,
            ])
            ->assertOk();

        $settings = DiscordWebhookSetting::instance();
        expect($settings->enabled)->toBeFalse();
        expect($settings->webhook_url)->not->toBeNull();
    });

    it('creates audit log on update', function () {
        DiscordWebhookSetting::factory()->create();

        $this->actingAs($this->admin)
            ->patchJson(route('admin.discord.update'), [
                'enabled' => true,
            ])
            ->assertOk();

        expect(AuditLog::where('action', 'discord.webhook.update')->exists())->toBeTrue();
    });
});

// ── Validation ───────────────────────────────────────────────────────

describe('Discord webhook validation', function () {
    it('rejects invalid webhook URL', function () {
        $this->actingAs($this->admin)
            ->patchJson(route('admin.discord.update'), [
                'webhook_url' => 'https://example.com/not-discord',
            ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('webhook_url');
    });

    it('rejects non-URL string', function () {
        $this->actingAs($this->admin)
            ->patchJson(route('admin.discord.update'), [
                'webhook_url' => 'not-a-url',
            ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('webhook_url');
    });

    it('rejects unknown event types', function () {
        $this->actingAs($this->admin)
            ->patchJson(route('admin.discord.update'), [
                'enabled_events' => ['server.start', 'invalid.event'],
            ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('enabled_events.1');
    });
});

// ── Test webhook ─────────────────────────────────────────────────────

describe('Discord webhook test', function () {
    it('sends test message when URL is configured', function () {
        DiscordWebhookSetting::factory()->enabled()->create();

        $service = Mockery::mock(DiscordWebhookService::class);
        $service->shouldReceive('sendTestMessage')
            ->once()
            ->andReturn(['success' => true]);
        app()->instance(DiscordWebhookService::class, $service);

        $this->actingAs($this->admin)
            ->postJson(route('admin.discord.test'))
            ->assertOk()
            ->assertJson(['success' => true]);
    });

    it('returns error when no URL configured', function () {
        // Ensure no webhook URL
        DiscordWebhookSetting::factory()->create(['webhook_url' => null]);

        $this->actingAs($this->admin)
            ->postJson(route('admin.discord.test'))
            ->assertUnprocessable()
            ->assertJson(['success' => false]);
    });

    it('returns error when webhook delivery fails', function () {
        DiscordWebhookSetting::factory()->enabled()->create();

        $service = Mockery::mock(DiscordWebhookService::class);
        $service->shouldReceive('sendTestMessage')
            ->once()
            ->andReturn(['success' => false, 'error' => 'Discord returned HTTP 401']);
        app()->instance(DiscordWebhookService::class, $service);

        $this->actingAs($this->admin)
            ->postJson(route('admin.discord.test'))
            ->assertOk()
            ->assertJson(['success' => false, 'error' => 'Discord returned HTTP 401']);
    });
});

// ── Observer dispatch ────────────────────────────────────────────────

describe('AuditLog observer', function () {
    it('dispatches job when action is enabled', function () {
        Queue::fake();

        DiscordWebhookSetting::factory()
            ->enabled()
            ->withEvents(['server.start'])
            ->create();

        AuditLog::factory()->create(['action' => 'server.start']);

        Queue::assertPushed(SendDiscordWebhookNotification::class);
    });

    it('does not dispatch when notifications are disabled', function () {
        Queue::fake();

        DiscordWebhookSetting::factory()
            ->withEvents(['server.start'])
            ->create(['enabled' => false]);

        AuditLog::factory()->create(['action' => 'server.start']);

        Queue::assertNotPushed(SendDiscordWebhookNotification::class);
    });

    it('does not dispatch for non-enabled events', function () {
        Queue::fake();

        DiscordWebhookSetting::factory()
            ->enabled()
            ->withEvents(['server.start'])
            ->create();

        AuditLog::factory()->create(['action' => 'server.stop']);

        Queue::assertNotPushed(SendDiscordWebhookNotification::class);
    });

    it('does not dispatch when no webhook URL is set', function () {
        Queue::fake();

        DiscordWebhookSetting::factory()
            ->create([
                'enabled' => true,
                'enabled_events' => ['server.start'],
                'webhook_url' => null,
            ]);

        AuditLog::factory()->create(['action' => 'server.start']);

        Queue::assertNotPushed(SendDiscordWebhookNotification::class);
    });

    it('does not dispatch for discord.webhook.update action', function () {
        Queue::fake();

        // Even if someone manually added it to events, it's not in availableEvents
        DiscordWebhookSetting::factory()
            ->enabled()
            ->withEvents(['discord.webhook.update'])
            ->create();

        AuditLog::factory()->create(['action' => 'discord.webhook.update']);

        Queue::assertNotPushed(SendDiscordWebhookNotification::class);
    });
});

// ── Discord embed building ───────────────────────────────────────────

describe('Discord embed building', function () {
    it('builds correct embed for server start', function () {
        Http::fake(['*' => Http::response(null, 204)]);

        $auditLog = AuditLog::factory()->create([
            'action' => 'server.start',
            'actor' => 'admin',
        ]);

        app(DiscordWebhookService::class)->sendNotification(
            'https://discord.com/api/webhooks/123/token',
            $auditLog,
        );

        Http::assertSent(function ($request) {
            $embed = $request->data()['embeds'][0] ?? [];

            return str_contains($embed['title'] ?? '', 'Server Started')
                && $embed['color'] === 0x2ECC71;
        });
    });

    it('builds correct embed for player ban with details', function () {
        Http::fake(['*' => Http::response(null, 204)]);

        $auditLog = AuditLog::factory()->create([
            'action' => 'player.ban',
            'target' => 'cheater123',
            'details' => ['reason' => 'Cheating'],
        ]);

        app(DiscordWebhookService::class)->sendNotification(
            'https://discord.com/api/webhooks/123/token',
            $auditLog,
        );

        Http::assertSent(function ($request) {
            $embed = $request->data()['embeds'][0] ?? [];
            $fieldNames = array_column($embed['fields'] ?? [], 'name');

            return str_contains($embed['title'] ?? '', 'Player Banned')
                && $embed['color'] === 0xE74C3C
                && in_array('Target', $fieldNames)
                && in_array('Reason', $fieldNames);
        });
    });

    it('builds correct embed for restart completed', function () {
        Http::fake(['*' => Http::response(null, 204)]);

        $auditLog = AuditLog::factory()->create([
            'action' => 'server.restart.completed',
            'actor' => 'admin',
        ]);

        app(DiscordWebhookService::class)->sendNotification(
            'https://discord.com/api/webhooks/123/token',
            $auditLog,
        );

        Http::assertSent(function ($request) {
            $embed = $request->data()['embeds'][0] ?? [];

            return str_contains($embed['title'] ?? '', 'Server Ready')
                && $embed['color'] === 0x2ECC71;
        });
    });

    it('builds correct embed for start completed', function () {
        Http::fake(['*' => Http::response(null, 204)]);

        $auditLog = AuditLog::factory()->create([
            'action' => 'server.start.completed',
            'actor' => 'admin',
        ]);

        app(DiscordWebhookService::class)->sendNotification(
            'https://discord.com/api/webhooks/123/token',
            $auditLog,
        );

        Http::assertSent(function ($request) {
            $embed = $request->data()['embeds'][0] ?? [];

            return str_contains($embed['title'] ?? '', 'Server Ready')
                && $embed['color'] === 0x2ECC71;
        });
    });

    it('includes countdown in scheduled action embed', function () {
        Http::fake(['*' => Http::response(null, 204)]);

        $auditLog = AuditLog::factory()->create([
            'action' => 'server.restart.scheduled',
            'details' => ['countdown' => 60],
        ]);

        app(DiscordWebhookService::class)->sendNotification(
            'https://discord.com/api/webhooks/123/token',
            $auditLog,
        );

        Http::assertSent(function ($request) {
            $fields = $request->data()['embeds'][0]['fields'] ?? [];
            $countdownField = collect($fields)->firstWhere('name', 'Countdown');

            return $countdownField && $countdownField['value'] === '60 seconds';
        });
    });

    it('includes file size in backup embed', function () {
        Http::fake(['*' => Http::response(null, 204)]);

        $auditLog = AuditLog::factory()->create([
            'action' => 'backup.created',
            'target' => 'backup-2026.tar.gz',
            'details' => ['size_bytes' => 52428800],
        ]);

        app(DiscordWebhookService::class)->sendNotification(
            'https://discord.com/api/webhooks/123/token',
            $auditLog,
        );

        Http::assertSent(function ($request) {
            $fields = $request->data()['embeds'][0]['fields'] ?? [];
            $sizeField = collect($fields)->firstWhere('name', 'Size');

            return $sizeField && str_contains($sizeField['value'], 'MB');
        });
    });

    it('skips unknown actions', function () {
        Http::fake();

        $auditLog = AuditLog::factory()->create([
            'action' => 'unknown.action',
        ]);

        app(DiscordWebhookService::class)->sendNotification(
            'https://discord.com/api/webhooks/123/token',
            $auditLog,
        );

        Http::assertNothingSent();
    });

    it('returns success on test message delivery', function () {
        Http::fake(['*' => Http::response(null, 204)]);

        $result = app(DiscordWebhookService::class)
            ->sendTestMessage('https://discord.com/api/webhooks/123/token');

        expect($result['success'])->toBeTrue();
    });

    it('returns error on failed test message delivery', function () {
        Http::fake(['*' => Http::response('Unauthorized', 401)]);

        $result = app(DiscordWebhookService::class)
            ->sendTestMessage('https://discord.com/api/webhooks/123/token');

        expect($result['success'])->toBeFalse();
        expect($result['error'])->toContain('401');
    });
});
