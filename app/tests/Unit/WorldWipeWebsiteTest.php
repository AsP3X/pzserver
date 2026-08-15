<?php

use App\Enums\UserRole;
use App\Models\User;
use App\Models\Wallet;
use App\Services\WorldWipeService;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;

uses(Tests\TestCase::class);

beforeEach(function () {
    // phpunit.xml forces pgsql@db (Docker). For host unit runs, use in-memory SQLite.
    config([
        'database.default' => 'sqlite',
        'database.connections.sqlite' => [
            'driver' => 'sqlite',
            'database' => ':memory:',
            'prefix' => '',
            'foreign_key_constraints' => true,
        ],
    ]);
    DB::purge();
    DB::reconnect('sqlite');
    Artisan::call('migrate', ['--force' => true]);
});

function makeWipeUser(string $username, UserRole $role): User
{
    return User::query()->create([
        'username' => $username,
        'name' => $username,
        'email' => $username.'@example.test',
        'password' => bcrypt('password'),
        'role' => $role,
    ]);
}

it('deletes every website account and related data, then restores the bootstrap admin', function () {
    config([
        'zomboid.admin.username' => 'bootstrap',
        'zomboid.admin.password' => 'password123',
        'zomboid.admin.email' => 'bootstrap@example.test',
    ]);

    $admin = makeWipeUser('admin1', UserRole::Admin);
    $mod = makeWipeUser('mod1', UserRole::Moderator);
    $player = makeWipeUser('survivor1', UserRole::Player);
    $player2 = makeWipeUser('survivor2', UserRole::Player);

    $wallet = Wallet::query()->create([
        'id' => (string) Str::uuid(),
        'user_id' => $player->id,
        'balance' => 50,
        'total_earned' => 50,
        'total_spent' => 0,
    ]);

    if (Schema::hasTable('whitelist_entries')) {
        DB::table('whitelist_entries')->insert([
            'id' => (string) Str::uuid(),
            'user_id' => $player->id,
            'pz_username' => 'survivor1',
            'active' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    if (Schema::hasTable('player_stats')) {
        DB::table('player_stats')->insert([
            'username' => 'survivor1',
            'zombie_kills' => 10,
            'hours_survived' => 5,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    if (Schema::hasTable('game_events')) {
        DB::table('game_events')->insert([
            'event_type' => 'death',
            'player' => 'survivor1',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    $result = (new WorldWipeService)->wipeWebsitePlayerData();

    expect($result['ok'])->toBeTrue()
        ->and($result['players_deleted'])->toBe(4)
        ->and(User::query()->find($admin->id))->toBeNull()
        ->and(User::query()->find($mod->id))->toBeNull()
        ->and(User::query()->find($player->id))->toBeNull()
        ->and(User::query()->find($player2->id))->toBeNull()
        ->and(Wallet::query()->find($wallet->id))->toBeNull()
        ->and(User::query()->where('username', 'bootstrap')->where('role', UserRole::SuperAdmin)->exists())->toBeTrue();

    if (Schema::hasTable('player_stats')) {
        expect(DB::table('player_stats')->count())->toBe(0);
    }
    if (Schema::hasTable('game_events')) {
        expect(DB::table('game_events')->count())->toBe(0);
    }
    if (Schema::hasTable('whitelist_entries')) {
        expect(DB::table('whitelist_entries')->where('pz_username', 'survivor1')->exists())->toBeFalse();
    }
});
