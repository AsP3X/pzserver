<?php

use App\Services\GameStateReader;
use App\Services\OnlinePlayersReader;
use App\Services\ServerIniParser;
use Illuminate\Support\Sleep;

beforeEach(function () {
    Sleep::fake();

    $this->ini = Mockery::mock(ServerIniParser::class);
    $this->ini->shouldReceive('read')->andReturn(['PauseEmpty' => 'true'])->byDefault();
    app()->instance(ServerIniParser::class, $this->ini);

    $this->players = Mockery::mock(OnlinePlayersReader::class);
    $this->players->shouldReceive('getOnlinePlayers')
        ->andReturn(['usernames' => [], 'source' => 'rcon'])
        ->byDefault();
    app()->instance(OnlinePlayersReader::class, $this->players);

    $this->state = Mockery::mock(GameStateReader::class);
    app()->instance(GameStateReader::class, $this->state);
});

/**
 * A game_state.json payload at a given in-game clock position.
 */
function gameState(int $dayOfYear, int $hour, int $minute): array
{
    return [
        'time' => [
            'year' => 1993,
            'month' => 7,
            'day' => 9,
            'hour' => $hour,
            'minute' => $minute,
            'day_of_year' => $dayOfYear,
            'is_night' => false,
            'formatted' => sprintf('%02d:%02d', $hour, $minute),
            'date' => '1993-07-09',
        ],
        'season' => 'summer',
        'exported_at' => '2026-08-08T12:00:00Z',
    ];
}

// ── Config layer ─────────────────────────────────────────────────────

it('stops when PauseEmpty is disabled', function () {
    $this->ini->shouldReceive('read')->andReturn(['PauseEmpty' => 'false']);

    $this->artisan('zomboid:diagnose-pause')
        ->expectsOutputToContain('PauseEmpty is not enabled')
        ->assertFailed();
});

it('stops when server.ini has no PauseEmpty key', function () {
    $this->ini->shouldReceive('read')->andReturn([]);

    $this->artisan('zomboid:diagnose-pause')
        ->expectsOutputToContain('Could not read server.ini')
        ->assertFailed();
});

// ── Player layer ─────────────────────────────────────────────────────

it('refuses to diagnose while players are connected', function () {
    $this->players->shouldReceive('getOnlinePlayers')
        ->andReturn(['usernames' => ['survivor'], 'source' => 'lua_bridge']);

    $this->artisan('zomboid:diagnose-pause')
        ->expectsOutputToContain('Players are connected')
        ->assertFailed();
});

it('reports when the bridge is not exporting a clock', function () {
    $this->state->shouldReceive('getGameState')->andReturn(null);

    $this->artisan('zomboid:diagnose-pause')
        ->expectsOutputToContain('Knox Relay bridge is not exporting')
        ->assertFailed();
});

// ── Clock layer ──────────────────────────────────────────────────────

it('reports PAUSED when the world clock stands still on an empty server', function () {
    $this->state->shouldReceive('getGameState')->andReturn(gameState(190, 14, 30));

    $this->artisan('zomboid:diagnose-pause')
        ->expectsOutputToContain('PAUSED')
        ->assertSuccessful();
});

it('reports NOT PAUSED when the world clock advances on an empty server', function () {
    $this->state->shouldReceive('getGameState')
        ->andReturn(gameState(190, 14, 30), gameState(190, 15, 0));

    $this->artisan('zomboid:diagnose-pause')
        ->expectsOutputToContain('NOT PAUSED')
        ->expectsOutputToContain('Moved 30 in-game minutes')
        ->expectsOutputToContain('GameServer.Players is not empty')
        ->expectsOutputToContain('has not restarted since PauseEmpty was enabled')
        ->assertFailed();
});

it('counts elapsed minutes across a midnight rollover', function () {
    $this->state->shouldReceive('getGameState')
        ->andReturn(gameState(190, 23, 50), gameState(191, 0, 20));

    $this->artisan('zomboid:diagnose-pause')
        ->expectsOutputToContain('Moved 30 in-game minutes')
        ->assertFailed();
});

it('waits the requested number of seconds between samples', function () {
    $this->state->shouldReceive('getGameState')->andReturn(gameState(190, 14, 30));

    $this->artisan('zomboid:diagnose-pause', ['--seconds' => 200])->assertSuccessful();

    Sleep::assertSlept(fn ($duration) => (int) $duration->totalSeconds === 200);
});
