<?php

use App\Jobs\WaitForServerReady;
use App\Models\AuditLog;
use App\Services\RconClient;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

it('creates audit log when RCON connects on start completed', function () {
    $rcon = Mockery::mock(RconClient::class);
    $rcon->shouldReceive('reconnect')->once();
    app()->instance(RconClient::class, $rcon);

    $job = new WaitForServerReady('server.start.completed', 'admin', '127.0.0.1');
    $job->handle($rcon);

    $log = AuditLog::where('action', 'server.start.completed')->first();
    expect($log)->not->toBeNull();
    expect($log->actor)->toBe('admin');
    expect($log->ip_address)->toBe('127.0.0.1');
});

it('creates audit log when RCON connects on restart completed', function () {
    $rcon = Mockery::mock(RconClient::class);
    $rcon->shouldReceive('reconnect')->once();
    app()->instance(RconClient::class, $rcon);

    $job = new WaitForServerReady('server.restart.completed', 'system', '192.168.1.1');
    $job->handle($rcon);

    $log = AuditLog::where('action', 'server.restart.completed')->first();
    expect($log)->not->toBeNull();
    expect($log->actor)->toBe('system');
});
