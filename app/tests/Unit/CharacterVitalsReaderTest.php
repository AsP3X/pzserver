<?php

use App\Services\CharacterVitalsReader;
use App\Services\GameStateReader;

beforeEach(function () {
    $this->luaRoot = sys_get_temp_dir().'/kr_vitals_test_'.uniqid();
    $this->vitalsDir = $this->luaRoot.'/vitals';
    mkdir($this->vitalsDir, 0777, true);

    $this->gameStatePath = $this->luaRoot.'/game_state.json';

    $this->service = new CharacterVitalsReader(
        new GameStateReader($this->gameStatePath),
        $this->vitalsDir,
    );

    $this->writeHeartbeat = function (string $path, array $data): void {
        file_put_contents($path, json_encode($data));
    };

    $this->writeBridgeVersion = function (?string $version): void {
        file_put_contents($this->gameStatePath, json_encode([
            'time' => ['hour' => 12, 'minute' => 0],
            'mod_version' => $version,
            'exported_at' => '2026-08-10T12:00:00',
        ]));
    };
});

afterEach(function () {
    if (is_dir($this->luaRoot)) {
        exec('rm -rf '.escapeshellarg($this->luaRoot));
    }
});

test('reports unavailable until the bridge exports a version', function () {
    expect($this->service->isAvailable())->toBeFalse();

    ($this->writeBridgeVersion)('1.8');

    expect($this->service->isAvailable())->toBeTrue();
});

test('reports unavailable on a bridge too old to export vitals', function (string $version) {
    ($this->writeBridgeVersion)($version);

    expect($this->service->isAvailable())->toBeFalse();
})->with(['1.2', '1.6', '1.7']);

test('stays available on bridges newer than the one that added vitals', function () {
    ($this->writeBridgeVersion)('1.10');

    expect($this->service->isAvailable())->toBeTrue();
});

test('the vitals directory alone does not mean the mod is running', function () {
    // configure-server.sh creates this on every boot, mod loaded or not.
    expect(is_dir($this->vitalsDir))->toBeTrue()
        ->and($this->service->isAvailable())->toBeFalse();
});

test('returns null when the player has no heartbeat file', function () {
    expect($this->service->heartbeatFor('nobody'))->toBeNull();
});

test('reads a heartbeat from the vitals subdirectory', function () {
    ($this->writeHeartbeat)($this->vitalsDir.'/Bob.json', [
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
    // into vitals/, so removing the directory must not hide it.
    rmdir($this->vitalsDir);
    ($this->writeHeartbeat)($this->luaRoot.'/vitals_Bob.json', ['info' => ['name' => 'Bob']]);

    expect($this->service->heartbeatFor('Bob'))->toBe(['info' => ['name' => 'Bob']]);
});

test('prefers the subdirectory heartbeat over a stale flat one', function () {
    ($this->writeHeartbeat)($this->vitalsDir.'/Bob.json', ['info' => ['name' => 'fresh']]);
    ($this->writeHeartbeat)($this->luaRoot.'/vitals_Bob.json', ['info' => ['name' => 'stale']]);

    expect($this->service->heartbeatFor('Bob'))->toBe(['info' => ['name' => 'fresh']]);
});

test('returns null for malformed JSON rather than throwing', function () {
    file_put_contents($this->vitalsDir.'/Bob.json', '{"info": ');

    expect($this->service->heartbeatFor('Bob'))->toBeNull();
});

test('returns null for an empty heartbeat file', function () {
    file_put_contents($this->vitalsDir.'/Bob.json', '');

    expect($this->service->heartbeatFor('Bob'))->toBeNull();
});

test('rejects the empty array KR_Codec writes for an all-nil heartbeat', function () {
    // KR_Codec encodes an empty Lua table as `[]`, not `{}`.
    file_put_contents($this->vitalsDir.'/Bob.json', '[]');

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
    ($this->writeHeartbeat)($this->vitalsDir.'/Bob.json', ['info' => ['name' => 'Bob']]);
    touch($this->vitalsDir.'/Bob.json', 1_700_000_000);

    expect($this->service->lastSyncedAt('Bob')?->getTimestamp())->toBe(1_700_000_000);
});

test('has no sync time for a player who has never played', function () {
    expect($this->service->lastSyncedAt('Bob'))->toBeNull();
});
