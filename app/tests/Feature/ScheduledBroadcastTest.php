<?php

use App\Jobs\BroadcastMessage;
use App\Models\ScheduledBroadcast;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->withoutVite();
    Queue::fake();
});

it('sends an interval broadcast that has never been sent', function () {
    ScheduledBroadcast::factory()->create(['interval_minutes' => 60, 'last_sent_at' => null]);

    $this->artisan('zomboid:send-broadcasts')->assertSuccessful();

    Queue::assertPushed(BroadcastMessage::class, 1);
});

it('waits out the interval before sending again', function () {
    ScheduledBroadcast::factory()->create([
        'interval_minutes' => 60,
        'last_sent_at' => now()->subMinutes(30),
    ]);

    $this->artisan('zomboid:send-broadcasts')->assertSuccessful();

    Queue::assertNothingPushed();
});

it('sends again once the interval has passed', function () {
    ScheduledBroadcast::factory()->create([
        'interval_minutes' => 60,
        'last_sent_at' => now()->subMinutes(61),
    ]);

    $this->artisan('zomboid:send-broadcasts')->assertSuccessful();

    Queue::assertPushed(BroadcastMessage::class, 1);
});

it('skips disabled broadcasts', function () {
    ScheduledBroadcast::factory()->disabled()->create(['interval_minutes' => 5]);

    $this->artisan('zomboid:send-broadcasts')->assertSuccessful();

    Queue::assertNothingPushed();
});

it('stamps last_sent_at on dispatch', function () {
    $broadcast = ScheduledBroadcast::factory()->create(['interval_minutes' => 60]);

    $this->artisan('zomboid:send-broadcasts')->assertSuccessful();

    expect($broadcast->fresh()->last_sent_at)->not->toBeNull();
});

it('fires a daily broadcast only inside its minute', function () {
    $broadcast = ScheduledBroadcast::factory()->daily('18:00')->create(['timezone' => 'UTC']);

    expect($broadcast->isDue(CarbonImmutable::parse('2026-08-04 18:00:30', 'UTC')))->toBeTrue()
        ->and($broadcast->isDue(CarbonImmutable::parse('2026-08-04 18:01:00', 'UTC')))->toBeFalse()
        ->and($broadcast->isDue(CarbonImmutable::parse('2026-08-04 17:59:59', 'UTC')))->toBeFalse();
});

it('does not repeat a daily broadcast within the same minute', function () {
    $broadcast = ScheduledBroadcast::factory()->daily('18:00')->create([
        'timezone' => 'UTC',
        'last_sent_at' => CarbonImmutable::parse('2026-08-04 18:00:05', 'UTC'),
    ]);

    expect($broadcast->isDue(CarbonImmutable::parse('2026-08-04 18:00:45', 'UTC')))->toBeFalse();
});

it('sends a daily broadcast again the next day', function () {
    $broadcast = ScheduledBroadcast::factory()->daily('18:00')->create([
        'timezone' => 'UTC',
        'last_sent_at' => CarbonImmutable::parse('2026-08-03 18:00:05', 'UTC'),
    ]);

    expect($broadcast->isDue(CarbonImmutable::parse('2026-08-04 18:00:05', 'UTC')))->toBeTrue();
});

it('reads the daily time in the broadcast own timezone', function () {
    $broadcast = ScheduledBroadcast::factory()->daily('18:00')->create(['timezone' => 'Asia/Tbilisi']);

    /** 14:00 UTC is 18:00 in Tbilisi (UTC+4). */
    expect($broadcast->isDue(CarbonImmutable::parse('2026-08-04 14:00:10', 'UTC')))->toBeTrue()
        ->and($broadcast->isDue(CarbonImmutable::parse('2026-08-04 18:00:10', 'UTC')))->toBeFalse();
});

it('creates a broadcast from the admin page', function () {
    $this->actingAs(User::factory()->admin()->create())
        ->postJson('/admin/broadcasts', [
            'message' => 'Join our Discord',
            'cadence' => 'interval',
            'interval_minutes' => 30,
        ])
        ->assertCreated();

    expect(ScheduledBroadcast::query()->count())->toBe(1);
});

it('rejects an interval below five minutes', function () {
    $this->actingAs(User::factory()->admin()->create())
        ->postJson('/admin/broadcasts', [
            'message' => 'Spam',
            'cadence' => 'interval',
            'interval_minutes' => 1,
        ])
        ->assertStatus(422);
});

it('requires a time for the daily cadence', function () {
    $this->actingAs(User::factory()->admin()->create())
        ->postJson('/admin/broadcasts', ['message' => 'Nightly', 'cadence' => 'daily'])
        ->assertStatus(422);
});

it('sends one on demand without touching its schedule', function () {
    $broadcast = ScheduledBroadcast::factory()->create(['last_sent_at' => null]);

    $this->actingAs(User::factory()->admin()->create())
        ->postJson("/admin/broadcasts/{$broadcast->id}/send")
        ->assertOk();

    Queue::assertPushed(BroadcastMessage::class, 1);
    expect($broadcast->fresh()->last_sent_at)->toBeNull();
});

it('toggles a broadcast off and on', function () {
    $broadcast = ScheduledBroadcast::factory()->create(['enabled' => true]);
    $admin = User::factory()->admin()->create();

    $this->actingAs($admin)->postJson("/admin/broadcasts/{$broadcast->id}/toggle")->assertOk();
    expect($broadcast->fresh()->enabled)->toBeFalse();

    $this->actingAs($admin)->postJson("/admin/broadcasts/{$broadcast->id}/toggle")->assertOk();
    expect($broadcast->fresh()->enabled)->toBeTrue();
});

it('keeps broadcast management away from players', function () {
    $broadcast = ScheduledBroadcast::factory()->create();

    $this->actingAs(User::factory()->create())
        ->postJson("/admin/broadcasts/{$broadcast->id}/send")
        ->assertForbidden();
});
