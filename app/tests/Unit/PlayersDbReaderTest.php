<?php

use App\Services\PlayersDbReader;
use Illuminate\Support\Facades\DB;

uses(Tests\TestCase::class);

beforeEach(function () {
    $this->dbPath = sys_get_temp_dir().'/pz_players_test_'.uniqid().'.db';

    // Delete leftover file if exists
    @unlink($this->dbPath);

    // Create a temp SQLite DB with networkPlayers schema
    $pdo = new PDO('sqlite:'.$this->dbPath);
    $pdo->exec('
        CREATE TABLE networkPlayers (
            username TEXT PRIMARY KEY,
            name TEXT,
            x REAL DEFAULT 0,
            y REAL DEFAULT 0,
            z INTEGER DEFAULT 0,
            isDead INTEGER DEFAULT 0
        )
    ');
    $pdo->exec("INSERT INTO networkPlayers (username, name, x, y, z, isDead) VALUES ('Alice', 'Alice Smith', 10542.5, 9876.3, 0, 0)");
    $pdo->exec("INSERT INTO networkPlayers (username, name, x, y, z, isDead) VALUES ('Bob', 'Bob Jones', 10800.0, 9500.0, 1, 1)");
    $pdo = null;

    // Configure the pz_players connection to use our temp DB
    config(['database.connections.pz_players' => [
        'driver' => 'sqlite',
        'database' => $this->dbPath,
        'prefix' => '',
        'foreign_key_constraints' => false,
    ]]);

    // Purge so Laravel picks up the new config
    DB::purge('pz_players');

    $this->reader = new PlayersDbReader;
});

afterEach(function () {
    DB::purge('pz_players');
    @unlink($this->dbPath);
});

it('reads all player positions from the database', function () {
    $positions = $this->reader->getAllPlayerPositions();

    expect($positions)->toHaveCount(2)
        ->and($positions[0]['username'])->toBe('Alice')
        ->and($positions[0]['name'])->toBe('Alice Smith')
        ->and($positions[0]['x'])->toBe(10542.5)
        ->and($positions[0]['y'])->toBe(9876.3)
        ->and($positions[0]['z'])->toBe(0)
        ->and($positions[0]['is_dead'])->toBeFalse()
        ->and($positions[1]['username'])->toBe('Bob')
        ->and($positions[1]['is_dead'])->toBeTrue();
});

it('reads a single player position by username', function () {
    $player = $this->reader->getPlayerPosition('Alice');

    expect($player)->not->toBeNull()
        ->and($player['username'])->toBe('Alice')
        ->and($player['name'])->toBe('Alice Smith')
        ->and($player['x'])->toBe(10542.5)
        ->and($player['y'])->toBe(9876.3);
});

it('returns null for unknown player', function () {
    expect($this->reader->getPlayerPosition('Ghost'))->toBeNull();
});

it('returns empty array when database is unavailable', function () {
    config(['database.connections.pz_players' => [
        'driver' => 'sqlite',
        'database' => '/nonexistent/path/players.db',
        'prefix' => '',
    ]]);
    DB::purge('pz_players');

    $reader = new PlayersDbReader;

    expect($reader->getAllPlayerPositions())->toBe([]);
});

it('returns null for single player when database is unavailable', function () {
    config(['database.connections.pz_players' => [
        'driver' => 'sqlite',
        'database' => '/nonexistent/path/players.db',
        'prefix' => '',
    ]]);
    DB::purge('pz_players');

    $reader = new PlayersDbReader;

    expect($reader->getPlayerPosition('Alice'))->toBeNull();
});
