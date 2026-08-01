<?php

use App\Support\LuaBridgeFile;

beforeEach(function () {
    $this->tempDir = sys_get_temp_dir().'/pz_lua_bridge_'.getmypid().'_'.bin2hex(random_bytes(3));
    mkdir($this->tempDir, 0777, true);
});

afterEach(function () {
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($this->tempDir, RecursiveDirectoryIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($iterator as $item) {
        $item->isDir() ? @rmdir($item->getPathname()) : @unlink($item->getPathname());
    }
    @rmdir($this->tempDir);
});

it('writes json atomically as world-writable', function () {
    $path = $this->tempDir.'/export_requests.json';

    expect(LuaBridgeFile::writeJsonAtomic($path, ['usernames' => ['AsP3X']]))->toBeTrue()
        ->and(file_exists($path))->toBeTrue()
        ->and(json_decode(file_get_contents($path), true)['usernames'])->toBe(['AsP3X']);

    $perms = fileperms($path) & 0777;
    // On Windows perms may not stick; on Unix expect world-writable
    if (PHP_OS_FAMILY !== 'Windows') {
        expect($perms & 0002)->not->toBe(0);
    }
});

it('creates nested directories as world-writable', function () {
    $path = $this->tempDir.'/inventory/nested/player.json';

    expect(LuaBridgeFile::writeJsonAtomic($path, ['ok' => true]))->toBeTrue()
        ->and(is_dir(dirname($path)))->toBeTrue();

    if (PHP_OS_FAMILY !== 'Windows') {
        $dirPerms = fileperms(dirname($path)) & 0777;
        expect($dirPerms & 0002)->not->toBe(0);
    }
});

it('overwrites existing files', function () {
    $path = $this->tempDir.'/game_state.json';
    LuaBridgeFile::writeJsonAtomic($path, ['v' => 1]);
    LuaBridgeFile::writeJsonAtomic($path, ['v' => 2]);

    expect(json_decode(file_get_contents($path), true)['v'])->toBe(2);
});
