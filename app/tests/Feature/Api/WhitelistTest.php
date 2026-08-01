<?php

use App\Models\AuditLog;
use App\Models\WhitelistEntry;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;

uses(RefreshDatabase::class);

function whitelistApiHeaders(): array
{
    return ['X-API-Key' => 'test-key-12345'];
}

function setupPzSqlite(): string
{
    $dbPath = sys_get_temp_dir().'/pz_test_whitelist_'.uniqid().'.db';
    touch($dbPath);

    config(['database.connections.pz_sqlite.database' => $dbPath]);

    // Purge cached connection so it picks up the new path
    DB::purge('pz_sqlite');

    DB::connection('pz_sqlite')->statement('
        CREATE TABLE IF NOT EXISTS whitelist (
            username TEXT PRIMARY KEY,
            password TEXT,
            world TEXT DEFAULT NULL,
            role INTEGER DEFAULT 2,
            authType INTEGER DEFAULT 1
        )
    ');

    return $dbPath;
}

beforeEach(function () {
    config(['zomboid.api_key' => 'test-key-12345']);
    $this->dbPath = setupPzSqlite();
});

afterEach(function () {
    DB::connection('pz_sqlite')->disconnect();
    @unlink($this->dbPath);
});

// ── GET /api/whitelist ───────────────────────────────────────────────

it('returns empty whitelist', function () {
    $this->getJson('/api/whitelist', whitelistApiHeaders())
        ->assertOk()
        ->assertJson(['entries' => [], 'count' => 0]);
});

it('returns whitelist entries', function () {
    DB::connection('pz_sqlite')->table('whitelist')->insert([
        ['username' => 'player1', 'password' => 'pass1'],
        ['username' => 'player2', 'password' => 'pass2'],
    ]);

    $response = $this->getJson('/api/whitelist', whitelistApiHeaders())
        ->assertOk();

    expect($response->json('count'))->toBe(2)
        ->and($response->json('entries.0.username'))->toBe('player1')
        ->and($response->json('entries.1.username'))->toBe('player2');
});

// ── POST /api/whitelist ──────────────────────────────────────────────

it('adds a user to whitelist', function () {
    $this->postJson('/api/whitelist', [
        'username' => 'newplayer',
        'password' => 'secret123',
    ], whitelistApiHeaders())
        ->assertCreated()
        ->assertJson([
            'message' => 'User added to whitelist',
            'username' => 'newplayer',
        ]);

    // Verify in SQLite
    $exists = DB::connection('pz_sqlite')
        ->table('whitelist')
        ->where('username', 'newplayer')
        ->exists();
    expect($exists)->toBeTrue();

    // Verify in PostgreSQL
    expect(WhitelistEntry::where('pz_username', 'newplayer')->where('active', true)->exists())->toBeTrue();

    // Verify audit log
    expect(AuditLog::where('action', 'whitelist.add')->exists())->toBeTrue();
});

it('rejects duplicate username', function () {
    DB::connection('pz_sqlite')->table('whitelist')->insert([
        'username' => 'existing',
        'password' => 'pass',
    ]);

    $this->postJson('/api/whitelist', [
        'username' => 'existing',
        'password' => 'newpass',
    ], whitelistApiHeaders())
        ->assertStatus(409)
        ->assertJson(['error' => 'User already whitelisted']);
});

it('validates required fields', function () {
    $this->postJson('/api/whitelist', [], whitelistApiHeaders())
        ->assertUnprocessable()
        ->assertJsonValidationErrors(['username', 'password']);
});

it('validates username length', function () {
    $this->postJson('/api/whitelist', [
        'username' => 'ab',
        'password' => 'password',
    ], whitelistApiHeaders())
        ->assertUnprocessable()
        ->assertJsonValidationErrors('username');
});

it('validates password length', function () {
    $this->postJson('/api/whitelist', [
        'username' => 'testuser',
        'password' => 'abc',
    ], whitelistApiHeaders())
        ->assertUnprocessable()
        ->assertJsonValidationErrors('password');
});

// ── DELETE /api/whitelist/{username} ─────────────────────────────────

it('removes a user from whitelist', function () {
    DB::connection('pz_sqlite')->table('whitelist')->insert([
        'username' => 'removeme',
        'password' => 'pass',
    ]);
    WhitelistEntry::create([
        'pz_username' => 'removeme',
        'pz_password_hash' => 'pass',
        'active' => true,
    ]);

    $this->deleteJson('/api/whitelist/removeme', [], whitelistApiHeaders())
        ->assertOk()
        ->assertJson([
            'message' => 'User removed from whitelist',
            'username' => 'removeme',
        ]);

    // Verify removed from SQLite
    $exists = DB::connection('pz_sqlite')
        ->table('whitelist')
        ->where('username', 'removeme')
        ->exists();
    expect($exists)->toBeFalse();

    // Verify marked inactive in PG
    expect(WhitelistEntry::where('pz_username', 'removeme')->where('active', false)->exists())->toBeTrue();

    // Verify audit log
    expect(AuditLog::where('action', 'whitelist.remove')->exists())->toBeTrue();
});

it('returns 404 when removing nonexistent user', function () {
    $this->deleteJson('/api/whitelist/noone', [], whitelistApiHeaders())
        ->assertNotFound();
});

// ── GET /api/whitelist/{username}/status ──────────────────────────────

it('returns whitelisted true for existing user', function () {
    DB::connection('pz_sqlite')->table('whitelist')->insert([
        'username' => 'checkme',
        'password' => 'pass',
    ]);

    $this->getJson('/api/whitelist/checkme/status', whitelistApiHeaders())
        ->assertOk()
        ->assertJson([
            'username' => 'checkme',
            'whitelisted' => true,
        ]);
});

it('returns whitelisted false for nonexistent user', function () {
    $this->getJson('/api/whitelist/nobody/status', whitelistApiHeaders())
        ->assertOk()
        ->assertJson([
            'username' => 'nobody',
            'whitelisted' => false,
        ]);
});

// ── POST /api/whitelist/sync ─────────────────────────────────────────

it('syncs whitelist and detects additions', function () {
    // User exists in SQLite but not tracked in PG
    DB::connection('pz_sqlite')->table('whitelist')->insert([
        'username' => 'untracked',
        'password' => 'pass',
    ]);

    $response = $this->postJson('/api/whitelist/sync', [], whitelistApiHeaders())
        ->assertOk();

    expect($response->json('added'))->toContain('untracked')
        ->and($response->json('mismatches'))->toBe(1);

    // Verify tracked in PG now
    expect(WhitelistEntry::where('pz_username', 'untracked')->where('active', true)->exists())->toBeTrue();

    // Verify audit log
    expect(AuditLog::where('action', 'whitelist.sync')->exists())->toBeTrue();
});

it('syncs whitelist and detects removals', function () {
    // User tracked in PG but not in SQLite
    WhitelistEntry::create([
        'pz_username' => 'ghost',
        'active' => true,
    ]);

    $response = $this->postJson('/api/whitelist/sync', [], whitelistApiHeaders())
        ->assertOk();

    expect($response->json('removed'))->toContain('ghost')
        ->and($response->json('mismatches'))->toBe(1);

    // Verify marked inactive
    expect(WhitelistEntry::where('pz_username', 'ghost')->where('active', false)->exists())->toBeTrue();
});

it('reports zero mismatches when in sync', function () {
    DB::connection('pz_sqlite')->table('whitelist')->insert([
        'username' => 'synced_user',
        'password' => 'pass',
    ]);
    WhitelistEntry::create([
        'pz_username' => 'synced_user',
        'active' => true,
    ]);

    $response = $this->postJson('/api/whitelist/sync', [], whitelistApiHeaders())
        ->assertOk();

    expect($response->json('mismatches'))->toBe(0)
        ->and($response->json('added'))->toBe([])
        ->and($response->json('removed'))->toBe([]);
});

// ── Auth ─────────────────────────────────────────────────────────────

it('requires auth for whitelist endpoints', function () {
    config(['zomboid.api_key' => 'real-key-here']);

    $this->getJson('/api/whitelist')->assertUnauthorized();
    $this->postJson('/api/whitelist')->assertUnauthorized();
    $this->deleteJson('/api/whitelist/testuser')->assertUnauthorized();
    $this->getJson('/api/whitelist/testuser/status')->assertUnauthorized();
    $this->postJson('/api/whitelist/sync')->assertUnauthorized();
});
