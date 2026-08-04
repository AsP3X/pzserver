<?php

use App\Services\MapTileGenerator;
use App\Services\MapTileProgress;

uses(Tests\TestCase::class);

it('uses a CLI php binary, not php-fpm', function () {
    $gen = app(MapTileGenerator::class);
    $bin = $gen->phpCliBinary();

    expect($bin)->not->toContain('php-fpm');
});

it('reconciles stale generating progress when no process is running', function () {
    $progress = app(MapTileProgress::class);
    $progress->start([
        'stage' => 'render',
        'message' => 'Ghost job',
    ]);
    // Fake lock with dead PID
    file_put_contents($progress->lockPath(), json_encode([
        'pid' => 99999999,
        'started_at' => now()->toIso8601String(),
    ]));

    $gen = app(MapTileGenerator::class);
    expect($gen->isRunning())->toBeFalse();

    $data = $progress->read();
    expect($data['generating'])->toBeFalse()
        ->and($data['stage'])->toBe('failed')
        ->and(is_file($progress->lockPath()))->toBeFalse();
});
