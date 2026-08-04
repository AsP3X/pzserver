<?php

use App\Services\MapTileStore;

uses(Tests\TestCase::class);

beforeEach(function () {
    $this->tempDir = sys_get_temp_dir().'/pz_map_tiles_'.getmypid().'_'.bin2hex(random_bytes(4));
    mkdir($this->tempDir, 0755, true);
    $this->store = new MapTileStore($this->tempDir);
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

function writeFakeTile(string $root, int $z, int $x, int $y, string $ext, string $bytes): string
{
    $dir = $root.'/html/map_data/base/layer0_files/'.$z;
    if (! is_dir($dir)) {
        mkdir($dir, 0755, true);
    }

    $path = $dir.'/'.$x.'_'.$y.'.'.$ext;
    file_put_contents($path, $bytes);

    return $path;
}

it('reports no tiles when empty', function () {
    expect($this->store->hasTiles())->toBeFalse()
        ->and($this->store->hasPackedTiles())->toBeFalse()
        ->and($this->store->hasLooseTiles())->toBeFalse()
        ->and($this->store->getTile('0', '1_2'))->toBeNull();
});

it('detects and serves legacy loose tiles', function () {
    writeFakeTile($this->tempDir, 2, 10, 20, 'webp', 'WEBP-DATA');

    expect($this->store->hasLooseTiles())->toBeTrue()
        ->and($this->store->hasTiles())->toBeTrue();

    $tile = $this->store->getTile('2', '10_20');

    expect($tile)->not->toBeNull()
        ->and($tile['data'])->toBe('WEBP-DATA')
        ->and($tile['content_type'])->toBe('image/webp');
});

it('detects loose tiles at deep pyramid levels', function () {
    // pzmap2dzi builds bottom-up: mid-render only the deep levels hold images
    writeFakeTile($this->tempDir, 14, 1234, 5678, 'jpg', 'DEEP');

    expect($this->store->hasLooseTiles())->toBeTrue()
        ->and($this->store->hasTiles())->toBeTrue();
});

it('does not count empty sentinels as loose tiles', function () {
    $dir = $this->tempDir.'/html/map_data/base/layer0_files/12';
    mkdir($dir, 0755, true);
    file_put_contents($dir.'/1_1.empty', '');
    file_put_contents($dir.'/1_2.empty', '');

    expect($this->store->hasLooseTiles())->toBeFalse();
});

it('reports per-level image and sentinel counts', function () {
    writeFakeTile($this->tempDir, 10, 1, 1, 'jpg', 'A');
    writeFakeTile($this->tempDir, 10, 1, 2, 'webp', 'B');
    writeFakeTile($this->tempDir, 11, 4, 4, 'jpg', 'C');
    file_put_contents($this->tempDir.'/html/map_data/base/layer0_files/11/5_5.empty', '');

    $stats = $this->store->looseLevelStats();

    expect(array_keys($stats))->toBe([10, 11])
        ->and($stats[10])->toBe(['images' => 2, 'empty' => 0])
        ->and($stats[11])->toBe(['images' => 1, 'empty' => 1]);
});

it('counts tiles in the pack', function () {
    expect($this->store->packedTileCount())->toBeNull();

    writeFakeTile($this->tempDir, 0, 0, 0, 'jpg', 'A');
    writeFakeTile($this->tempDir, 1, 1, 1, 'webp', 'B');
    $this->store->packLooseTiles();

    expect($this->store->packedTileCount())->toBe(2);
});

it('packs loose tiles into a single sqlite file and removes the pyramid', function () {
    writeFakeTile($this->tempDir, 0, 0, 0, 'jpg', 'JPEG0');
    writeFakeTile($this->tempDir, 1, 3, 4, 'webp', 'WEBP1');
    writeFakeTile($this->tempDir, 2, 5, 6, 'webp', 'WEBP2');

    $infoDir = $this->tempDir.'/html/map_data/base';
    file_put_contents($infoDir.'/map_info.json', json_encode([
        'w' => 1024,
        'h' => 2048,
        'x0' => 10,
        'y0' => 20,
        'sqr' => 128,
    ]));

    $result = $this->store->packLooseTiles(removeLoose: true);

    expect($result['tiles'])->toBe(3)
        ->and(is_file($this->store->packPath()))->toBeTrue()
        ->and($this->store->hasPackedTiles())->toBeTrue()
        ->and($this->store->hasLooseTiles())->toBeFalse()
        ->and(is_dir($this->store->looseLayerPath()))->toBeFalse();

    $tile = $this->store->getTile('1', '3_4.webp');
    expect($tile)->not->toBeNull()
        ->and($tile['data'])->toBe('WEBP1')
        ->and($tile['content_type'])->toBe('image/webp');

    $jpg = $this->store->getTile('0', '0_0');
    expect($jpg)->not->toBeNull()
        ->and($jpg['data'])->toBe('JPEG0')
        ->and($jpg['content_type'])->toBe('image/jpeg');

    $dzi = $this->store->getDziConfig();
    expect($dzi)->not->toBeNull()
        ->and($dzi['width'])->toBe(1024)
        ->and($dzi['height'])->toBe(2048)
        ->and($dzi['x0'])->toBe(10)
        ->and($dzi['y0'])->toBe(20)
        ->and($dzi['sqr'])->toBe(128)
        ->and($dzi['isometric'])->toBeTrue();
});

it('rejects path traversal style tile names', function () {
    writeFakeTile($this->tempDir, 0, 1, 1, 'webp', 'OK');
    $this->store->packLooseTiles();

    expect($this->store->getTile('0', '../etc/passwd'))->toBeNull()
        ->and($this->store->getTile('abc', '1_1'))->toBeNull()
        ->and($this->store->getTile('0', 'not_coords'))->toBeNull();
});

it('clearAll removes pack and loose tiles', function () {
    writeFakeTile($this->tempDir, 0, 1, 2, 'webp', 'X');
    $this->store->packLooseTiles(removeLoose: false);

    expect($this->store->hasPackedTiles())->toBeTrue()
        ->and($this->store->hasLooseTiles())->toBeTrue();

    $this->store->clearAll();

    expect($this->store->hasPackedTiles())->toBeFalse()
        ->and($this->store->hasLooseTiles())->toBeFalse()
        ->and(is_file($this->store->packPath()))->toBeFalse();
});
