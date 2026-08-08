<?php

use App\Services\WorldWipeService;

uses(Tests\TestCase::class);

beforeEach(function () {
    $this->root = sys_get_temp_dir().'/pz_wipe_'.getmypid().'_'.bin2hex(random_bytes(4));
    $this->data = $this->root.'/zomboid';
    $server = 'ZomboidServer';

    mkdir($this->data."/Saves/Multiplayer/{$server}/map", 0755, true);
    mkdir($this->data.'/Saves/Multiplayer/OtherWorld/map', 0755, true);
    mkdir($this->data.'/Server', 0755, true);
    mkdir($this->data.'/db', 0755, true);
    mkdir($this->data.'/backups/startup', 0755, true);
    mkdir($this->data.'/backups/version', 0755, true);
    mkdir($this->data.'/Lua/inventory', 0755, true);

    file_put_contents($this->data."/Saves/Multiplayer/{$server}/map/chunk.bin", 'world');
    file_put_contents($this->data."/Saves/Multiplayer/{$server}/players.db", 'players');
    file_put_contents($this->data.'/Saves/Multiplayer/OtherWorld/map/chunk.bin', 'other');
    file_put_contents($this->data."/db/{$server}.db", 'accounts');
    file_put_contents($this->data."/db/{$server}.db-wal", 'wal');
    file_put_contents($this->data.'/backups/startup/backup_1.zip', 'zip');
    file_put_contents($this->data.'/backups/version/backup_1.zip', 'zip');
    file_put_contents($this->data.'/Lua/players_live.json', '{"x":1}');
    file_put_contents($this->data.'/Lua/inventory/Alice.json', '{}');

    // Config to preserve
    file_put_contents($this->data."/Server/{$server}.ini", 'PublicName=ZomboidServer');
    file_put_contents($this->data."/Server/{$server}_SandboxVars.lua", 'SandboxVars = {}');
    file_put_contents($this->data."/Server/{$server}_spawnpoints.lua", 'spawnpoints = {}');
    file_put_contents($this->data."/Server/{$server}_spawnregions.lua", 'spawnregions = {}');
    file_put_contents($this->data.'/Server/.mod_state', 'Mods=');

    config([
        'zomboid.paths.data' => $this->data,
        'zomboid.server_name' => $server,
    ]);

    $this->service = new WorldWipeService;
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

it('deletes save worlds and player databases', function () {
    $result = $this->service->wipeSaveData();

    expect($result['ok'])->toBeTrue()
        ->and(is_dir($this->data.'/Saves/Multiplayer/ZomboidServer'))->toBeFalse()
        ->and(is_dir($this->data.'/Saves/Multiplayer/OtherWorld'))->toBeFalse()
        ->and(file_exists($this->data.'/db/ZomboidServer.db'))->toBeFalse()
        ->and(file_exists($this->data.'/backups/startup/backup_1.zip'))->toBeFalse()
        ->and(file_exists($this->data.'/backups/version/backup_1.zip'))->toBeFalse()
        ->and(file_get_contents($this->data.'/Lua/players_live.json'))->toBe('')
        ->and(file_exists($this->data.'/Lua/inventory/Alice.json'))->toBeFalse();
});

it('preserves sandbox, spawn, and server.ini configuration', function () {
    $result = $this->service->wipeSaveData();

    expect($result['ok'])->toBeTrue()
        ->and(file_exists($this->data.'/Server/ZomboidServer.ini'))->toBeTrue()
        ->and(file_exists($this->data.'/Server/ZomboidServer_SandboxVars.lua'))->toBeTrue()
        ->and(file_exists($this->data.'/Server/ZomboidServer_spawnpoints.lua'))->toBeTrue()
        ->and(file_exists($this->data.'/Server/ZomboidServer_spawnregions.lua'))->toBeTrue()
        ->and(file_exists($this->data.'/Server/.mod_state'))->toBeTrue()
        ->and(file_get_contents($this->data.'/Server/ZomboidServer_SandboxVars.lua'))->toBe('SandboxVars = {}')
        ->and($result['preserved'])->not->toBeEmpty();
});
