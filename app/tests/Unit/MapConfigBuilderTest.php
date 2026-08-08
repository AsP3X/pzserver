<?php

use App\Services\MapConfigBuilder;
use App\Services\MapTileProgress;
use App\Services\MapTileStore;

uses(Tests\TestCase::class);

beforeEach(function () {
    $this->tempDir = sys_get_temp_dir().'/pz_map_cfg_'.getmypid().'_'.bin2hex(random_bytes(4));
    mkdir($this->tempDir, 0755, true);
    $this->vectorDir = $this->tempDir.'/vector';
    mkdir($this->vectorDir, 0755, true);
    $this->vectorPath = $this->vectorDir.'/map.json';
    file_put_contents($this->vectorPath, json_encode([
        'v' => 1,
        'bounds' => [0, 0, 19800, 15696],
        'cells' => new stdClass,
        'styles' => new stdClass,
        'labels' => [],
        'bg' => [219, 215, 192],
        'cellSize' => 300,
    ]));

    $this->store = new MapTileStore($this->tempDir);
    $this->builder = new MapConfigBuilder($this->store);

    config([
        'zomboid.map.tiles_path' => $this->tempDir,
        'zomboid.map.tile_size' => 256,
        'zomboid.map.min_zoom' => 13,
        'zomboid.map.max_zoom' => 17,
        'zomboid.map.default_zoom' => 13,
        'zomboid.map.center_x' => 10500.0,
        'zomboid.map.center_y' => 9800.0,
        'zomboid.map.basemap' => 'auto',
        'zomboid.map.vector_path' => $this->vectorPath,
        'zomboid.map.vector_url' => '/map-vector/vanilla/map.json',
        'zomboid.map.vector_min_zoom' => -4,
        'zomboid.map.vector_max_zoom' => 4,
        'zomboid.map.vector_default_zoom' => -1.5,
        'zomboid.map.proxy_url' => 'https://example.test/{z}/{x}_{y}.jpg',
        'zomboid.map.proxy_tile_size' => 1024,
        'zomboid.map.proxy_dzi' => [
            'width' => 1000,
            'height' => 2000,
            'x0' => 1,
            'y0' => 2,
            'sqr' => 128,
        ],
    ]);
});

afterEach(function () {
    $root = $this->tempDir;
    if (! is_dir($root)) {
        return;
    }

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, RecursiveDirectoryIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST,
    );

    foreach ($iterator as $file) {
        if ($file->isDir()) {
            @rmdir($file->getPathname());
        } else {
            @unlink($file->getPathname());
        }
    }

    @rmdir($root);
});

it('prefers vector basemap in auto mode', function () {
    $config = $this->builder->build();

    expect($config['source'])->toBe('vector')
        ->and($config['hasBasemap'])->toBeTrue()
        ->and($config['vectorUrl'])->toBe('/map-vector/vanilla/map.json')
        ->and($config['tileUrl'])->toBeNull()
        ->and($config['dzi'])->toBeNull()
        ->and($config['bounds'])->toBe([0, 0, 19800, 15696])
        ->and($config['minZoom'])->toBe(-4.0)
        ->and($this->builder->hasVectorBasemap())->toBeTrue();
});

it('falls back to proxy when vector is missing and no local tiles', function () {
    config(['zomboid.map.vector_path' => $this->tempDir.'/missing.json']);

    $config = $this->builder->build();

    expect($config['source'])->toBe('proxy')
        ->and($config['local_ready'])->toBeFalse()
        ->and($config['tileUrl'])->toBe('https://example.test/{z}/{x}_{y}.jpg')
        ->and($config['hasBasemap'])->toBeTrue()
        ->and($this->builder->hasLocalTiles())->toBeFalse();
});

it('keeps the proxy basemap while a render is still writing loose tiles when basemap is local', function () {
    config([
        'zomboid.map.basemap' => 'local',
        'zomboid.map.vector_path' => $this->tempDir.'/missing.json',
    ]);

    $layer = $this->tempDir.'/html/map_data/base/layer0_files/14';
    mkdir($layer, 0755, true);
    file_put_contents($layer.'/900_900.jpg', 'PARTIAL');
    file_put_contents($this->tempDir.'/html/map_data/base/map_info.json', json_encode([
        'w' => 4096,
        'h' => 4096,
        'x0' => 0,
        'y0' => 0,
        'sqr' => 1,
    ]));

    $progress = new MapTileProgress;
    $progress->start(['stage' => 'render', 'message' => 'Rendering tiles…']);

    try {
        // local mode with incomplete loose tiles → empty (not usable mid-render)
        expect($this->builder->build()['source'])->toBe('none');

        $progress->finish(true, 'done');

        expect($this->builder->build()['source'])->toBe('local');
    } finally {
        $progress->clear();
    }
});

it('prefers packed local tiles when basemap is forced to local', function () {
    config(['zomboid.map.basemap' => 'local']);

    $layer = $this->tempDir.'/html/map_data/base/layer0_files/0';
    mkdir($layer, 0755, true);
    file_put_contents($layer.'/1_2.webp', 'TILE');
    file_put_contents($this->tempDir.'/html/map_data/base/map_info.json', json_encode([
        'w' => 4096,
        'h' => 4096,
        'x0' => 0,
        'y0' => 0,
        'sqr' => 1,
    ]));

    $this->store->packLooseTiles();

    $config = $this->builder->build();

    expect($config['source'])->toBe('local')
        ->and($config['local_ready'])->toBeTrue()
        ->and($config['tileUrl'])->toBe('/map-tiles/{z}/{x}_{y}')
        ->and($config['dzi']['width'])->toBe(4096)
        ->and($this->builder->hasLocalTiles())->toBeTrue();
});

it('can force proxy over available vector', function () {
    config(['zomboid.map.basemap' => 'proxy']);

    $config = $this->builder->build();

    expect($config['source'])->toBe('proxy')
        ->and($config['vectorUrl'])->toBeNull();
});
