<?php

use App\Enums\UserRole;
use App\Models\AuditLog;
use App\Models\User;
use App\Models\WhitelistEntry;
use App\Services\ServerIniParser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Inertia\Testing\AssertableInertia as Assert;

uses(RefreshDatabase::class);

beforeEach(function () {
    $this->withoutVite();
    $this->admin = User::factory()->admin()->create();
    $this->dbPath = setupAdminPzSqlite();
});

afterEach(function () {
    DB::connection('pz_sqlite')->disconnect();
    @unlink($this->dbPath);

    if (isset($this->playersDbPath)) {
        DB::connection('pz_players')->disconnect();
        @unlink($this->playersDbPath);
    }
});

function setupAdminPzSqlite(): string
{
    $dbPath = sys_get_temp_dir().'/pz_test_admin_wl_'.uniqid().'.db';
    touch($dbPath);

    config(['database.connections.pz_sqlite.database' => $dbPath]);
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

function setupAdminPlayersDb(): string
{
    $dbPath = sys_get_temp_dir().'/pz_test_admin_players_'.uniqid().'.db';
    touch($dbPath);

    config(['database.connections.pz_players.database' => $dbPath]);
    DB::purge('pz_players');

    DB::connection('pz_players')->statement('
        CREATE TABLE IF NOT EXISTS networkPlayers (
            username TEXT PRIMARY KEY,
            name TEXT,
            x REAL DEFAULT 0,
            y REAL DEFAULT 0,
            z REAL DEFAULT 0,
            isDead INTEGER DEFAULT 0
        )
    ');

    return $dbPath;
}

// ── Index page shows all players ───────────────────────────────────

describe('Whitelist index page', function () {
    it('shows all web users with whitelist status', function () {
        User::factory()->create(['username' => 'wl_player']);
        User::factory()->create(['username' => 'normal_player']);

        DB::connection('pz_sqlite')->table('whitelist')->insert([
            'username' => 'wl_player',
            'password' => 'hashed',
        ]);

        $response = $this->actingAs($this->admin)
            ->get(route('admin.whitelist'));

        $response->assertOk();

        $players = $response->original->getData()['page']['props']['players'];
        expect(count($players))->toBe(3); // admin + 2 players

        $wlPlayer = collect($players)->firstWhere('username', 'wl_player');
        $normalPlayer = collect($players)->firstWhere('username', 'normal_player');

        expect($wlPlayer)->not->toBeNull();
        expect($wlPlayer['whitelisted'])->toBeTrue();

        expect($normalPlayer)->not->toBeNull();
        expect($normalPlayer['whitelisted'])->toBeFalse();
    });

    it('includes character names from players.db', function () {
        $this->playersDbPath = setupAdminPlayersDb();

        $user = User::factory()->create(['username' => 'char_player']);

        DB::connection('pz_players')->table('networkPlayers')->insert([
            'username' => 'char_player',
            'name' => 'Survivor Bob',
        ]);

        $this->actingAs($this->admin)
            ->get(route('admin.whitelist'))
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->where('players.0.username', function ($value) {
                    return true; // admin may come first alphabetically
                }),
            );

        // Find the char_player in the response
        $response = $this->actingAs($this->admin)->get(route('admin.whitelist'));
        $players = $response->original->getData()['page']['props']['players'];
        $charPlayer = collect($players)->firstWhere('username', 'char_player');

        expect($charPlayer)->not->toBeNull();
        expect($charPlayer['character_name'])->toBe('Survivor Bob');
    });

    it('handles missing players.db gracefully', function () {
        $user = User::factory()->create(['username' => 'solo_player']);

        $this->actingAs($this->admin)
            ->get(route('admin.whitelist'))
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->has('players', 2), // admin + solo_player
            );
    });
});

// ── Toggle endpoint ─────────────────────────────────────────────────

describe('Whitelist toggle', function () {
    it('adds player to whitelist with password', function () {
        $player = User::factory()->create(['username' => 'toggle_add']);

        $this->actingAs($this->admin)
            ->postJson(route('admin.whitelist.toggle', 'toggle_add'), [
                'password' => 'secret123',
            ])
            ->assertOk()
            ->assertJson([
                'whitelisted' => true,
                'message' => 'User added to whitelist',
            ]);

        // Verify in PZ SQLite
        $exists = DB::connection('pz_sqlite')
            ->table('whitelist')
            ->where('username', 'toggle_add')
            ->exists();
        expect($exists)->toBeTrue();

        // Verify password is bcrypt-hashed in PZ SQLite
        $pzEntry = DB::connection('pz_sqlite')
            ->table('whitelist')
            ->where('username', 'toggle_add')
            ->first();
        expect(str_starts_with($pzEntry->password, '$2y$'))->toBeTrue();

        // Verify in PostgreSQL
        expect(WhitelistEntry::where('pz_username', 'toggle_add')->where('active', true)->exists())->toBeTrue();

        // Verify audit log
        expect(AuditLog::where('action', 'whitelist.add')->where('target', 'toggle_add')->exists())->toBeTrue();
    });

    it('removes player from whitelist', function () {
        $player = User::factory()->create(['username' => 'toggle_remove']);

        DB::connection('pz_sqlite')->table('whitelist')->insert([
            'username' => 'toggle_remove',
            'password' => 'hashed_pass',
        ]);
        WhitelistEntry::create([
            'pz_username' => 'toggle_remove',
            'pz_password_hash' => 'hashed_pass',
            'active' => true,
            'synced_at' => now(),
        ]);

        $this->actingAs($this->admin)
            ->postJson(route('admin.whitelist.toggle', 'toggle_remove'))
            ->assertOk()
            ->assertJson([
                'whitelisted' => false,
                'message' => 'User removed from whitelist',
            ]);

        // Verify removed from PZ SQLite
        $exists = DB::connection('pz_sqlite')
            ->table('whitelist')
            ->where('username', 'toggle_remove')
            ->exists();
        expect($exists)->toBeFalse();

        // Verify marked inactive in PostgreSQL
        expect(WhitelistEntry::where('pz_username', 'toggle_remove')->where('active', false)->exists())->toBeTrue();

        // Verify audit log
        expect(AuditLog::where('action', 'whitelist.remove')->where('target', 'toggle_remove')->exists())->toBeTrue();
    });

    it('requires password when adding to whitelist', function () {
        $player = User::factory()->create(['username' => 'no_pass']);

        $this->actingAs($this->admin)
            ->postJson(route('admin.whitelist.toggle', 'no_pass'))
            ->assertUnprocessable()
            ->assertJsonValidationErrors('password');
    });

    it('validates password minimum length', function () {
        $player = User::factory()->create(['username' => 'short_pass']);

        $this->actingAs($this->admin)
            ->postJson(route('admin.whitelist.toggle', 'short_pass'), [
                'password' => 'abc',
            ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('password');
    });

    it('does not require password when removing from whitelist', function () {
        DB::connection('pz_sqlite')->table('whitelist')->insert([
            'username' => 'remove_no_pass',
            'password' => 'hashed',
        ]);
        WhitelistEntry::create([
            'pz_username' => 'remove_no_pass',
            'pz_password_hash' => 'hashed',
            'active' => true,
        ]);

        $this->actingAs($this->admin)
            ->postJson(route('admin.whitelist.toggle', 'remove_no_pass'))
            ->assertOk()
            ->assertJson(['whitelisted' => false]);
    });

    it('requires admin authentication', function () {
        $player = User::factory()->create(['role' => UserRole::Player]);

        $this->actingAs($player)
            ->postJson(route('admin.whitelist.toggle', 'someone'))
            ->assertForbidden();
    });
});

// ── NetworkPlayers sync ────────────────────────────────────────────

describe('NetworkPlayers sync in pz:sync-accounts', function () {
    it('creates users from networkPlayers table', function () {
        $this->playersDbPath = setupAdminPlayersDb();

        // Also need PZ whitelist SQLite (already set up in beforeEach)

        DB::connection('pz_players')->table('networkPlayers')->insert([
            'username' => 'net_player1',
            'name' => 'Survivor One',
        ]);
        DB::connection('pz_players')->table('networkPlayers')->insert([
            'username' => 'net_player2',
            'name' => 'Survivor Two',
        ]);

        $this->artisan('pz:sync-accounts')
            ->assertSuccessful()
            ->expectsOutputToContain('2 new players discovered');

        $user1 = User::where('username', 'net_player1')->first();
        $user2 = User::where('username', 'net_player2')->first();

        expect($user1)->not->toBeNull();
        expect($user1->name)->toBe('Survivor One');
        expect($user1->role)->toBe(UserRole::Player);

        expect($user2)->not->toBeNull();
        expect($user2->name)->toBe('Survivor Two');
    });

    it('skips networkPlayers already in users table', function () {
        $this->playersDbPath = setupAdminPlayersDb();

        User::factory()->create(['username' => 'existing_net']);

        DB::connection('pz_players')->table('networkPlayers')->insert([
            'username' => 'existing_net',
            'name' => 'Already Here',
        ]);

        $this->artisan('pz:sync-accounts')
            ->assertSuccessful()
            ->expectsOutputToContain('0 new players discovered');

        expect(User::where('username', 'existing_net')->count())->toBe(1);
    });

    it('does not create whitelist entries for networkPlayers', function () {
        $this->playersDbPath = setupAdminPlayersDb();

        DB::connection('pz_players')->table('networkPlayers')->insert([
            'username' => 'unwl_player',
            'name' => 'No Whitelist',
        ]);

        $this->artisan('pz:sync-accounts')
            ->assertSuccessful();

        expect(WhitelistEntry::where('pz_username', 'unwl_player')->exists())->toBeFalse();
    });

    it('handles missing players.db gracefully', function () {
        // pz_players is not configured to a valid DB — command should still succeed
        config(['database.connections.pz_players.database' => '/nonexistent/path/players.db']);
        DB::purge('pz_players');

        $this->artisan('pz:sync-accounts')
            ->assertSuccessful()
            ->expectsOutputToContain('Could not read players.db');
    });
});

// ── Whitelist settings ─────────────────────────────────────────────

function createTempIni(array $settings = []): string
{
    $defaults = [
        'Open' => 'true',
        'AutoCreateUserInWhiteList' => 'true',
        'MaxPlayers' => '16',
    ];

    $merged = array_merge($defaults, $settings);
    $lines = [];

    foreach ($merged as $key => $value) {
        $lines[] = "{$key}={$value}";
    }

    $path = sys_get_temp_dir().'/pz_test_ini_'.uniqid().'.ini';
    file_put_contents($path, implode("\n", $lines)."\n");

    return $path;
}

describe('Whitelist settings', function () {
    it('index page includes whitelist_settings prop with correct values', function () {
        $iniPath = createTempIni(['Open' => 'false', 'AutoCreateUserInWhiteList' => 'true']);
        config(['zomboid.paths.server_ini' => $iniPath]);

        $this->actingAs($this->admin)
            ->get(route('admin.whitelist'))
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->has('whitelist_settings')
                ->where('whitelist_settings.open', false)
                ->where('whitelist_settings.auto_create_user_in_whitelist', true),
            );

        @unlink($iniPath);
    });

    it('PATCH endpoint updates server.ini and returns restart_required', function () {
        $iniPath = createTempIni(['Open' => 'true', 'AutoCreateUserInWhiteList' => 'true']);
        config(['zomboid.paths.server_ini' => $iniPath]);

        $this->actingAs($this->admin)
            ->patchJson(route('admin.whitelist.settings'), [
                'open' => false,
                'auto_create_user_in_whitelist' => false,
            ])
            ->assertOk()
            ->assertJson([
                'message' => 'Whitelist settings updated',
                'restart_required' => true,
            ]);

        $parser = new ServerIniParser;
        $ini = $parser->read($iniPath);

        expect($ini['Open'])->toBe('false');
        expect($ini['AutoCreateUserInWhiteList'])->toBe('false');

        // Verify audit log
        expect(AuditLog::where('action', 'whitelist.settings.update')->exists())->toBeTrue();

        @unlink($iniPath);
    });

    it('rejects non-boolean values', function () {
        $iniPath = createTempIni();
        config(['zomboid.paths.server_ini' => $iniPath]);

        $this->actingAs($this->admin)
            ->patchJson(route('admin.whitelist.settings'), [
                'open' => 'not-a-bool',
            ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('open');

        @unlink($iniPath);
    });

    it('non-admin users get 403', function () {
        $player = User::factory()->create(['role' => UserRole::Player]);

        $this->actingAs($player)
            ->patchJson(route('admin.whitelist.settings'), [
                'open' => false,
            ])
            ->assertForbidden();
    });

    it('missing server.ini defaults gracefully on index', function () {
        config(['zomboid.paths.server_ini' => '/nonexistent/path/server.ini']);

        $this->actingAs($this->admin)
            ->get(route('admin.whitelist'))
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->where('whitelist_settings.open', true)
                ->where('whitelist_settings.auto_create_user_in_whitelist', true),
            );
    });
});
