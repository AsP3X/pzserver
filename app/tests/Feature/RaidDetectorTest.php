<?php

use App\Models\AuditLog;
use App\Models\GameEvent;
use App\Services\HoldingsReader;
use App\Services\PlayerPositionReader;
use App\Services\RaidDetector;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;

uses(RefreshDatabase::class);

beforeEach(function () {
    Cache::flush();
});

function mockRaidPositions(array $players): void
{
    $reader = Mockery::mock(PlayerPositionReader::class);
    $reader->shouldReceive('getLivePositions')->andReturn(['players' => $players])->byDefault();
    app()->instance(PlayerPositionReader::class, $reader);
}

function mockRaidClaims(array $safehouses): void
{
    $reader = Mockery::mock(HoldingsReader::class)->makePartial();
    $reader->shouldReceive('read')->andReturn([
        'timestamp' => null,
        'safehouses' => $safehouses,
        'factions' => [],
    ])->byDefault();
    app()->instance(HoldingsReader::class, $reader);
}

function theMall(array $overrides = []): array
{
    return [
        'title' => 'The Mall',
        'owner' => 'Alice',
        'members' => ['Bob'],
        'x' => 100, 'y' => 200, 'x2' => 110, 'y2' => 210,
        ...$overrides,
    ];
}

function standingAt(string $username, float $x, float $y, bool $dead = false): array
{
    return ['username' => $username, 'x' => $x, 'y' => $y, 'z' => 0, 'is_dead' => $dead];
}

it('alerts on a stranger inside a claim', function () {
    mockRaidClaims([theMall()]);
    mockRaidPositions([standingAt('Mallory', 105, 205)]);

    $alerts = app(RaidDetector::class)->scan();

    expect($alerts)->toHaveCount(1);

    $event = GameEvent::query()->sole();

    expect($event->event_type)->toBe('raid_alert')
        ->and($event->player)->toBe('Mallory')
        ->and($event->target)->toBe('Alice')
        ->and($event->details['safehouse'])->toBe('The Mall');
});

it('stays quiet for the owner', function () {
    mockRaidClaims([theMall()]);
    mockRaidPositions([standingAt('Alice', 105, 205)]);

    expect(app(RaidDetector::class)->scan())->toBe([]);
    expect(GameEvent::query()->count())->toBe(0);
});

it('stays quiet for a member', function () {
    mockRaidClaims([theMall()]);
    mockRaidPositions([standingAt('Bob', 105, 205)]);

    expect(app(RaidDetector::class)->scan())->toBe([]);
});

it('stays quiet for someone outside every claim', function () {
    mockRaidClaims([theMall()]);
    mockRaidPositions([standingAt('Mallory', 500, 500)]);

    expect(app(RaidDetector::class)->scan())->toBe([]);
});

it('ignores a corpse lying in someone else base', function () {
    mockRaidClaims([theMall()]);
    mockRaidPositions([standingAt('Mallory', 105, 205, dead: true)]);

    expect(app(RaidDetector::class)->scan())->toBe([]);
});

it('raises one alert per intruder per cooldown, not one per scan', function () {
    mockRaidClaims([theMall()]);
    mockRaidPositions([standingAt('Mallory', 105, 205)]);

    $detector = app(RaidDetector::class);

    $detector->scan();
    $detector->scan();
    $detector->scan();

    expect(GameEvent::query()->count())->toBe(1);
});

it('alerts again once the cooldown has expired', function () {
    mockRaidClaims([theMall()]);
    mockRaidPositions([standingAt('Mallory', 105, 205)]);

    app(RaidDetector::class)->scan();

    $this->travel(RaidDetector::COOLDOWN_MINUTES + 1)->minutes();

    app(RaidDetector::class)->scan();

    expect(GameEvent::query()->count())->toBe(2);
});

it('treats two intruders in the same claim as separate incidents', function () {
    mockRaidClaims([theMall()]);
    mockRaidPositions([standingAt('Mallory', 105, 205), standingAt('Eve', 106, 206)]);

    app(RaidDetector::class)->scan();

    expect(GameEvent::query()->count())->toBe(2);
});

it('writes an audit entry so the alert reaches Discord', function () {
    mockRaidClaims([theMall()]);
    mockRaidPositions([standingAt('Mallory', 105, 205)]);

    app(RaidDetector::class)->scan();

    $audit = AuditLog::query()->where('action', 'raid.alert.detected')->sole();

    expect($audit->target)->toBe('The Mall')
        ->and($audit->details['intruder'])->toBe('Mallory');
});

it('does nothing when no claims exist', function () {
    mockRaidClaims([]);
    mockRaidPositions([standingAt('Mallory', 105, 205)]);

    expect(app(RaidDetector::class)->scan())->toBe([]);
});

it('does nothing when nobody is online', function () {
    mockRaidClaims([theMall()]);
    mockRaidPositions([]);

    expect(app(RaidDetector::class)->scan())->toBe([]);
});

it('runs from the scheduled command', function () {
    mockRaidClaims([theMall()]);
    mockRaidPositions([standingAt('Mallory', 105, 205)]);

    $this->artisan('zomboid:detect-raids')->assertSuccessful();

    expect(GameEvent::query()->count())->toBe(1);
});
