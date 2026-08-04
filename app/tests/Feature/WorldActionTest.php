<?php

use App\Models\AuditLog;
use App\Models\User;
use App\Services\WorldActionManager;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->tempDir = sys_get_temp_dir().'/world_actions_test_'.uniqid();
    mkdir($this->tempDir, 0755, true);
    $this->queuePath = $this->tempDir.'/world_actions.json';
    $this->resultsPath = $this->tempDir.'/world_results.json';

    $this->manager = new WorldActionManager($this->queuePath, $this->resultsPath);
    app()->instance(WorldActionManager::class, $this->manager);
});

afterEach(function () {
    foreach ([$this->queuePath, $this->resultsPath] as $path) {
        if (file_exists($path)) {
            unlink($path);
        }
    }
    if (is_dir($this->tempDir)) {
        rmdir($this->tempDir);
    }
});

it('queues a storm for the mod to pick up', function () {
    $entry = $this->manager->triggerStorm(6);

    expect($entry['action'])->toBe('storm')
        ->and($entry['duration_hours'])->toBe(6)
        ->and($entry['status'])->toBe('pending');

    $queued = json_decode(file_get_contents($this->queuePath), true);

    expect($queued['entries'])->toHaveCount(1)
        ->and($queued['entries'][0]['id'])->toBe($entry['id']);
});

it('clamps a storm to the mod cap', function () {
    expect($this->manager->triggerStorm(999)['duration_hours'])->toBe(WorldActionManager::MAX_STORM_HOURS)
        ->and($this->manager->triggerStorm(0)['duration_hours'])->toBe(1);
});

it('queues a weather clear', function () {
    expect($this->manager->clearWeather()['action'])->toBe('clear_weather');
});

it('keeps several pending entries', function () {
    $this->manager->triggerStorm(3);
    $this->manager->clearWeather();

    expect($this->manager->pending())->toHaveCount(2);
});

it('drops entries the mod has already reported on', function () {
    $entry = $this->manager->triggerStorm(3);

    file_put_contents($this->resultsPath, json_encode([
        'results' => [['id' => $entry['id'], 'status' => 'done', 'processed_at' => '1993-07-09T12:00:00']],
    ]));

    expect($this->manager->pending())->toBe([]);

    /** Queueing again prunes the reported entry rather than letting the inbox grow. */
    $this->manager->clearWeather();

    $queued = json_decode(file_get_contents($this->queuePath), true);

    expect($queued['entries'])->toHaveCount(1)
        ->and($queued['entries'][0]['action'])->toBe('clear_weather');
});

it('reads results newest first', function () {
    file_put_contents($this->resultsPath, json_encode([
        'results' => [
            ['id' => 'a', 'status' => 'done'],
            ['id' => 'b', 'status' => 'failed'],
        ],
    ]));

    expect($this->manager->results()[0]['id'])->toBe('b');
});

it('survives a missing or corrupt queue file', function () {
    file_put_contents($this->queuePath, '{broken');

    expect($this->manager->pending())->toBe([]);
    expect($this->manager->triggerStorm(3)['action'])->toBe('storm');
});

it('queues a storm from the admin endpoint and audits it', function () {
    $this->actingAs(User::factory()->admin()->create())
        ->postJson('/admin/world/actions', ['action' => 'storm', 'duration_hours' => 4])
        ->assertCreated();

    expect($this->manager->pending())->toHaveCount(1)
        ->and(AuditLog::query()->where('action', 'world.storm')->count())->toBe(1);
});

it('rejects an unknown world action', function () {
    $this->actingAs(User::factory()->admin()->create())
        ->postJson('/admin/world/actions', ['action' => 'summon_meteor'])
        ->assertStatus(422);
});

it('rejects a storm longer than the cap', function () {
    $this->actingAs(User::factory()->admin()->create())
        ->postJson('/admin/world/actions', ['action' => 'storm', 'duration_hours' => 100])
        ->assertStatus(422);
});

it('keeps world control away from players', function () {
    $this->actingAs(User::factory()->create())
        ->postJson('/admin/world/actions', ['action' => 'clear_weather'])
        ->assertForbidden();
});
