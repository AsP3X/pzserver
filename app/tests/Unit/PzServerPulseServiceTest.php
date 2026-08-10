<?php

use App\Services\PzServerPulseService;

beforeEach(function () {
    $this->luaRoot = sys_get_temp_dir().'/pzsp_test_'.uniqid();
    $this->pulseDir = $this->luaRoot.'/PZServerPulse';
    mkdir($this->pulseDir, 0777, true);

    $this->service = new PzServerPulseService($this->pulseDir);

    $this->writeHeartbeat = function (string $path, array $data): void {
        file_put_contents($path, json_encode($data));
    };
});

afterEach(function () {
    if (is_dir($this->luaRoot)) {
        exec('rm -rf '.escapeshellarg($this->luaRoot));
    }
});

test('reports unavailable until the mod writes its boot self-test', function () {
    expect($this->service->isAvailable())->toBeFalse();

    file_put_contents($this->luaRoot.'/sp_bridge_selftest.txt', 'ok');

    expect($this->service->isAvailable())->toBeTrue();
});

test('the heartbeat directory alone does not mean the mod is running', function () {
    // configure-server.sh creates this on every boot, mod installed or not.
    expect(is_dir($this->pulseDir))->toBeTrue()
        ->and($this->service->isAvailable())->toBeFalse();
});

test('returns null when the player has no heartbeat file', function () {
    expect($this->service->heartbeatFor('nobody'))->toBeNull();
});

test('reads a heartbeat from the PZServerPulse subdirectory', function () {
    ($this->writeHeartbeat)($this->pulseDir.'/Bob.json', [
        'info' => ['name' => 'Bob', 'kills' => 12],
        'moodles' => ['hunger' => 0.25],
    ]);

    expect($this->service->heartbeatFor('Bob'))->toBe([
        'info' => ['name' => 'Bob', 'kills' => 12],
        'moodles' => ['hunger' => 0.25],
    ]);
});

test('falls back to the flat file when the subdirectory is unusable', function () {
    // The fallback exists precisely for the case where the mod could not write
    // into PZServerPulse/, so removing the directory must not hide it.
    rmdir($this->pulseDir);
    ($this->writeHeartbeat)($this->luaRoot.'/pzsp_Bob.json', ['info' => ['name' => 'Bob']]);

    expect($this->service->heartbeatFor('Bob'))->toBe(['info' => ['name' => 'Bob']]);
});

test('prefers the subdirectory heartbeat over a stale flat one', function () {
    ($this->writeHeartbeat)($this->pulseDir.'/Bob.json', ['info' => ['name' => 'fresh']]);
    ($this->writeHeartbeat)($this->luaRoot.'/pzsp_Bob.json', ['info' => ['name' => 'stale']]);

    expect($this->service->heartbeatFor('Bob'))->toBe(['info' => ['name' => 'fresh']]);
});

test('returns null for malformed JSON rather than throwing', function () {
    file_put_contents($this->pulseDir.'/Bob.json', '{"info": ');

    expect($this->service->heartbeatFor('Bob'))->toBeNull();
});

test('returns null for an empty heartbeat file', function () {
    file_put_contents($this->pulseDir.'/Bob.json', '');

    expect($this->service->heartbeatFor('Bob'))->toBeNull();
});

test('rejects the empty array SP_Codec writes for an all-nil heartbeat', function () {
    // SP_Codec encodes an empty Lua table as `[]`, not `{}`.
    file_put_contents($this->pulseDir.'/Bob.json', '[]');

    expect($this->service->heartbeatFor('Bob'))->toBeNull();
});

test('refuses to resolve a username that escapes the bridge directory', function (string $username) {
    file_put_contents($this->luaRoot.'/secrets.json', json_encode(['leaked' => true]));

    expect($this->service->heartbeatFor($username))->toBeNull()
        ->and($this->service->lastSyncedAt($username))->toBeNull();
})->with([
    '../secrets',
    '..',
    '.',
    '',
    'sub/dir',
    'back\\slash',
]);

test('reports when the heartbeat was last written', function () {
    ($this->writeHeartbeat)($this->pulseDir.'/Bob.json', ['info' => ['name' => 'Bob']]);
    touch($this->pulseDir.'/Bob.json', 1_700_000_000);

    expect($this->service->lastSyncedAt('Bob')?->getTimestamp())->toBe(1_700_000_000);
});

test('has no sync time for a player who has never played', function () {
    expect($this->service->lastSyncedAt('Bob'))->toBeNull();
});
