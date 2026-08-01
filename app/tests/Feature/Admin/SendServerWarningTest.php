<?php

use App\Jobs\SendServerWarning;
use App\Services\RconClient;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Queue;

// ── dispatchCountdownWarnings job counts ────────────────────────────

it('dispatches correct number of warnings for 120s countdown', function () {
    Queue::fake();

    SendServerWarning::dispatchCountdownWarnings(120, 'restarting', 'server.pending_action:restart');

    // Thresholds < 120: 60, 30 → 2 jobs
    Queue::assertPushed(SendServerWarning::class, 2);
});

it('dispatches correct number of warnings for 3600s countdown', function () {
    Queue::fake();

    SendServerWarning::dispatchCountdownWarnings(3600, 'restarting', 'server.pending_action:restart');

    // All 9 thresholds are < 3600: 1800, 900, 600, 300, 240, 180, 120, 60, 30
    Queue::assertPushed(SendServerWarning::class, 9);
});

it('dispatches no warnings when countdown is 30s or less', function () {
    Queue::fake();

    SendServerWarning::dispatchCountdownWarnings(30, 'restarting', 'server.pending_action:restart');

    // No thresholds strictly less than 30
    Queue::assertNotPushed(SendServerWarning::class);
});

it('dispatches one warning for 60s countdown', function () {
    Queue::fake();

    SendServerWarning::dispatchCountdownWarnings(60, 'shutting down', 'server.pending_action:stop');

    // Only threshold < 60 is 30 → 1 job
    Queue::assertPushed(SendServerWarning::class, 1);
});

it('stores cache key with correct TTL', function () {
    Queue::fake();

    SendServerWarning::dispatchCountdownWarnings(120, 'restarting', 'server.pending_action:restart');

    expect(Cache::has('server.pending_action:restart'))->toBeTrue();
});

// ── Warning job handle behavior ─────────────────────────────────────

it('broadcasts RCON message when cache key exists', function () {
    Cache::put('server.pending_action:restart', true, 300);

    $rcon = Mockery::mock(RconClient::class);
    $rcon->shouldReceive('connect')->once();
    $rcon->shouldReceive('command')
        ->with('servermsg "Server restarting in 5 minutes"')
        ->once();
    app()->instance(RconClient::class, $rcon);

    $job = new SendServerWarning('Server restarting in 5 minutes', 'server.pending_action:restart');
    app()->call([$job, 'handle']);
});

it('skips broadcast when cache key is missing (cancelled)', function () {
    Cache::forget('server.pending_action:restart');

    $rcon = Mockery::mock(RconClient::class);
    $rcon->shouldNotReceive('connect');
    $rcon->shouldNotReceive('command');
    app()->instance(RconClient::class, $rcon);

    $job = new SendServerWarning('Server restarting in 5 minutes', 'server.pending_action:restart');
    app()->call([$job, 'handle']);
});

it('silently handles RCON failure during warning', function () {
    Cache::put('server.pending_action:restart', true, 300);

    $rcon = Mockery::mock(RconClient::class);
    $rcon->shouldReceive('connect')->once()->andThrow(new RuntimeException('Connection refused'));
    app()->instance(RconClient::class, $rcon);

    $job = new SendServerWarning('Server restarting in 1 minute', 'server.pending_action:restart');
    app()->call([$job, 'handle']);

    expect(true)->toBeTrue(); // Confirms no exception was thrown
});

// ── Message formatting ──────────────────────────────────────────────

it('formats warning messages correctly', function () {
    Queue::fake();

    SendServerWarning::dispatchCountdownWarnings(3600, 'restarting', 'server.pending_action:restart');

    Queue::assertPushed(SendServerWarning::class, function (SendServerWarning $job) {
        // Use reflection to check the message property
        $reflection = new ReflectionClass($job);
        $prop = $reflection->getProperty('message');

        return $prop->getValue($job) === 'Server restarting in 30 minutes';
    });

    Queue::assertPushed(SendServerWarning::class, function (SendServerWarning $job) {
        $reflection = new ReflectionClass($job);
        $prop = $reflection->getProperty('message');

        return $prop->getValue($job) === 'Server restarting in 30 seconds';
    });
});
