<?php

use App\Services\WorldMapVectorBuilder;

uses(Tests\TestCase::class);

beforeEach(function () {
    $this->builder = new WorldMapVectorBuilder;
    $this->fixtureDir = base_path('tests/Fixtures/worldmap');
});

it('parses worldmap.xml into absolute world-square geometry', function () {
    $geometry = $this->builder->parseWorldmapXml($this->fixtureDir.'/sample-worldmap.xml');

    expect($geometry['feature_count'])->toBe(4) // place-only feature has no drawable layer
        ->and($geometry['cells'])->toHaveKeys(['35,32', '36,32']);

    // Cell 35,32 residential building: base (35*300, 32*300) + (10,10)
    $features = $geometry['cells']['35,32'];
    $residential = collect($features)->first(fn ($f) => $f[0] === 'building-Residential');
    expect($residential)->not->toBeNull()
        ->and($residential[1][0])->toBe(35 * 300 + 10)
        ->and($residential[1][1])->toBe(32 * 300 + 10);

    // Water in cell 36,32
    $water = collect($geometry['cells']['36,32'])->first(fn ($f) => $f[0] === 'water');
    expect($water)->not->toBeNull()
        ->and($water[1][0])->toBe(36 * 300)
        ->and($water[1][1])->toBe(32 * 300);
});

it('maps property types to vanilla-style layer ids', function () {
    expect($this->builder->resolveLayer(['water' => 'river']))->toBe('water')
        ->and($this->builder->resolveLayer(['highway' => 'primary']))->toBe('road-primary')
        ->and($this->builder->resolveLayer(['highway' => 'trail']))->toBe('road-trail')
        ->and($this->builder->resolveLayer(['building' => 'Medical']))->toBe('building-Medical')
        ->and($this->builder->resolveLayer(['building' => 'yes']))->toBe('building')
        ->and($this->builder->resolveLayer(['natural' => 'wood']))->toBe('natural-wood')
        ->and($this->builder->resolveLayer(['place' => 'town']))->toBeNull();
});

it('builds a full asset with annotations and label translations', function () {
    $data = $this->builder->buildFromFiles(
        worldmapXmlPath: $this->fixtureDir.'/sample-worldmap.xml',
        annotationsLuaPath: $this->fixtureDir.'/sample-annotations.lua',
        mapLabelJsonPath: $this->fixtureDir.'/MapLabel.json',
        source: 'test',
    );

    expect($data['v'])->toBe(WorldMapVectorBuilder::FORMAT_VERSION)
        ->and($data['source'])->toBe('test')
        ->and($data['bg'])->toBe([219, 215, 192])
        ->and($data['styles'])->toHaveKey('water')
        ->and($data['stats']['features'])->toBe(4)
        ->and($data['stats']['labels'])->toBeGreaterThanOrEqual(2);

    $texts = collect($data['labels'])->pluck('t')->all();
    expect($texts)->toContain('SALT RIVER')
        ->and($texts)->toContain('MULDRAUGH')
        ->and($texts)->toContain('TESTVILLE');
});

it('writes JSON without stats metadata', function () {
    $data = $this->builder->buildFromFiles(
        worldmapXmlPath: $this->fixtureDir.'/sample-worldmap.xml',
        source: 'test',
    );

    $out = sys_get_temp_dir().'/pz_vector_'.getmypid().'.json';
    try {
        $this->builder->writeJson($data, $out);
        $decoded = json_decode(file_get_contents($out), true, 512, JSON_THROW_ON_ERROR);

        expect($decoded)->not->toHaveKey('stats')
            ->and($decoded['cells'])->toHaveKey('35,32')
            ->and($decoded['bounds'][0])->toBeInt();
    } finally {
        @unlink($out);
    }
});

it('merges mod + vanilla maps with first Map= entry winning cell overlaps', function () {
    $data = $this->builder->buildFromSources([
        [
            'name' => 'Mod Town',
            'xml' => $this->fixtureDir.'/mod-town-worldmap.xml',
            'origin' => 'workshop:1',
        ],
        [
            'name' => 'Muldraugh, KY',
            'xml' => $this->fixtureDir.'/sample-worldmap.xml',
            'annotations' => $this->fixtureDir.'/sample-annotations.lua',
            'labels' => $this->fixtureDir.'/MapLabel.json',
            'origin' => 'server-media',
        ],
    ]);

    expect($data['stats']['sources'])->toBe(2)
        ->and($data['maps'])->toHaveCount(2)
        ->and($data['cells'])->toHaveKey('80,80') // mod-only town
        ->and($data['cells'])->toHaveKey('35,32')
        ->and($data['cells'])->toHaveKey('36,32');

    // Overlap cell: mod pack wins (Industrial), not vanilla Residential
    $layers = collect($data['cells']['35,32'])->pluck(0)->all();
    expect($layers)->toContain('building-Industrial')
        ->and($layers)->not->toContain('building-Residential');

    $texts = collect($data['labels'])->pluck('t')->all();
    expect($texts)->toContain('MODVILLE')
        ->and($texts)->toContain('MULDRAUGH');
});
