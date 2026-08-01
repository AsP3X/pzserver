<?php

use App\Services\LuaBridgeHealthService;
use App\Support\LuaBridgeFile;

it('reports healthy bridge when path is writable', function () {
    $dir = sys_get_temp_dir().'/pz_bridge_health_'.getmypid();
    @mkdir($dir.'/inventory', 0777, true);
    config(['zomboid.lua_bridge.path' => $dir]);

    LuaBridgeFile::writeJsonAtomic($dir.'/deposit_results.json', ['version' => 1, 'results' => []]);

    $status = app(LuaBridgeHealthService::class)->status();

    expect($status['path'])->toBe($dir)
        ->and($status['writable'])->toBeTrue();

    // cleanup
    @unlink($dir.'/deposit_results.json');
    @unlink($dir.'/.bridge_health_probe');
    @rmdir($dir.'/inventory');
    @rmdir($dir);
});
