<?php

use App\Services\WorldMapSourceLocator;

uses(Tests\TestCase::class);

beforeEach(function () {
    $this->root = sys_get_temp_dir().'/pz_map_src_'.getmypid().'_'.bin2hex(random_bytes(4));
    $this->server = $this->root.'/server';
    $this->data = $this->root.'/data';
    mkdir($this->server.'/media/maps/Muldraugh, KY', 0755, true);
    mkdir($this->data.'/Server', 0755, true);

    file_put_contents($this->server.'/media/maps/Muldraugh, KY/worldmap.xml', '<world/>');
    file_put_contents(
        $this->server.'/media/maps/Muldraugh, KY/worldmap-annotations.lua',
        'return function() end',
    );

    // Workshop map mod layout (B42)
    $modMaps = $this->server.'/steamapps/workshop/content/108600/999001/mods/CoolTown/42/media/maps/Cool Town';
    mkdir($modMaps, 0755, true);
    file_put_contents($modMaps.'/worldmap.xml', '<world/>');

    $this->iniPath = $this->data.'/Server/ZomboidServer.ini';
    file_put_contents($this->iniPath, "Map=Cool Town;Muldraugh, KY\nWorkshopItems=999001\nMods=CoolTown\n");

    config([
        'zomboid.game_server_path' => $this->server,
        'zomboid.paths.server_ini' => $this->iniPath,
        'zomboid.map.extra_media_roots' => [],
    ]);

    $this->locator = new WorldMapSourceLocator;
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
});

it('reads Map= folders from server.ini', function () {
    expect($this->locator->mapFoldersFromIni($this->iniPath))
        ->toBe(['Cool Town', 'Muldraugh, KY']);
});

it('resolves vanilla and workshop map folders for the active Map= list', function () {
    $sources = $this->locator->locateForServer(
        iniPath: $this->iniPath,
        serverPath: $this->server,
    );

    expect($sources)->toHaveCount(2)
        ->and($sources[0]['name'])->toBe('Cool Town')
        ->and($sources[0]['origin'])->toStartWith('workshop:')
        ->and($sources[0]['xml'])->toEndWith('Cool Town/worldmap.xml')
        ->and($sources[1]['name'])->toBe('Muldraugh, KY')
        ->and($sources[1]['origin'])->toBe('server-media')
        ->and($sources[1]['annotations'])->not->toBeNull();
});

it('can scan orphan workshop maps not listed on Map=', function () {
    file_put_contents($this->iniPath, "Map=Muldraugh, KY\n");

    $sources = $this->locator->locateForServer(
        iniPath: $this->iniPath,
        serverPath: $this->server,
        includeOrphanWorkshopMaps: true,
    );

    $names = array_column($sources, 'name');
    expect($names)->toContain('Muldraugh, KY')
        ->and($names)->toContain('Cool Town');
});
