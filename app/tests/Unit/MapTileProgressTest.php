<?php

use App\Services\MapTileProgress;

beforeEach(function () {
    $this->progress = new MapTileProgress;
    $this->progress->clear();
});

afterEach(function () {
    $this->progress->clear();
});

it('starts and finishes progress state', function () {
    $this->progress->start(['stage' => 'unpack', 'message' => 'Unpacking…']);

    $data = $this->progress->read();
    expect($data)->not->toBeNull()
        ->and($data['generating'])->toBeTrue()
        ->and($data['stage'])->toBe('unpack')
        ->and($this->progress->isRunning())->toBeTrue();

    $this->progress->finish(true, 'Done');

    $done = $this->progress->read();
    expect($done['generating'])->toBeFalse()
        ->and($done['stage'])->toBe('done')
        ->and($done['percent'])->toBe(100)
        ->and($this->progress->isRunning())->toBeFalse();
});

it('computes overall percent for render stage', function () {
    $this->progress->start();
    $this->progress->update([
        'stage' => 'render',
        'completed' => 50,
        'total' => 100,
    ]);

    $data = $this->progress->read();
    // 8 + 0.5*82 = 49
    expect($data['percent'])->toBe(49);
});

it('parses job progress from pzmap2dzi log tail', function () {
    $log = sys_get_temp_dir().'/pzmap_progress_'.getmypid().'.log';
    // Simulate \r-style updates concatenated in a file
    file_put_contents($log, "Preparing data\nWorking\njob: 10/100 worker: 4/4\rjob: 55/100 worker: 4/4\rjob: 99/100 worker: 2/4 ");

    $parsed = $this->progress->parseJobProgressFromLog($log);

    expect($parsed)->toBe([
        'done' => 99,
        'total' => 100,
    ]);

    @unlink($log);
});

it('returns null when log has no job lines', function () {
    $log = sys_get_temp_dir().'/pzmap_progress_empty_'.getmypid().'.log';
    file_put_contents($log, "Unpacking textures...\nDone\n");

    expect($this->progress->parseJobProgressFromLog($log))->toBeNull();

    @unlink($log);
});
