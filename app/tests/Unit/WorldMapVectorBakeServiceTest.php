<?php

use App\Services\WorldMapVectorBakeService;

uses(Tests\TestCase::class);

beforeEach(function () {
    $this->root = sys_get_temp_dir().'/pz_vector_bake_'.getmypid().'_'.bin2hex(random_bytes(4));
    $this->server = $this->root.'/server';
    $this->data = $this->root.'/data';
    $this->out = $this->root.'/map.json';
    $this->fixture = base_path('tests/Fixtures/worldmap/sample-worldmap.xml');

    mkdir($this->server.'/media/maps/Muldraugh, KY', 0755, true);
    mkdir($this->data.'/Server', 0755, true);
    copy($this->fixture, $this->server.'/media/maps/Muldraugh, KY/worldmap.xml');
    file_put_contents($this->data.'/Server/ZomboidServer.ini', "Map=Muldraugh, KY\n");

    config([
        'zomboid.game_server_path' => $this->server,
        'zomboid.paths.server_ini' => $this->data.'/Server/ZomboidServer.ini',
        'zomboid.map.vector_path' => $this->out,
        'zomboid.map.vector_url' => '/map-vector/vanilla/map.json',
        'zomboid.map.extra_media_roots' => [],
    ]);

    $this->service = new WorldMapVectorBakeService;
});

afterEach(function () {
    $root = $this->root;
    if (! is_dir($root)) {
        return;
    }
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, RecursiveDirectoryIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST,
    );
    foreach ($iterator as $file) {
        $file->isDir() ? @rmdir($file->getPathname()) : @unlink($file->getPathname());
    }
    @rmdir($root);

    @unlink(storage_path('app/map-vector-bake.json'));
});

it('lists resolved Map= sources', function () {
    $sources = $this->service->listSources();

    expect($sources)->toHaveCount(1)
        ->and($sources[0]['name'])->toBe('Muldraugh, KY')
        ->and($sources[0]['missing'] ?? false)->toBeFalse();
});

it('bakes a vector pack to the configured output path', function () {
    $result = $this->service->bake();

    expect($result['ok'])->toBeTrue()
        ->and(is_file($this->out))->toBeTrue()
        ->and($result['bytes'])->toBeGreaterThan(100)
        ->and($this->service->assetStatus()['exists'])->toBeTrue()
        ->and($this->service->lastResult()['ok'] ?? false)->toBeTrue();
});

it('reports failure when no sources exist', function () {
    config(['zomboid.game_server_path' => $this->root.'/empty-server']);
    mkdir($this->root.'/empty-server', 0755, true);
    file_put_contents($this->data.'/Server/ZomboidServer.ini', "Map=Missing Town\n");

    $result = $this->service->bake();

    expect($result['ok'])->toBeFalse()
        ->and($result['message'])->toContain('No worldmap.xml');
});
