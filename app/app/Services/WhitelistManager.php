<?php

namespace App\Services;

use App\Models\WhitelistEntry;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class WhitelistManager
{
    /**
     * List all whitelisted users from PZ's SQLite database.
     *
     * @return array<int, array{username: string, password_hash: string}>
     */
    public function list(): array
    {
        $rows = DB::connection('pz_sqlite')
            ->table('whitelist')
            ->select('username', 'password as password_hash')
            ->orderBy('username')
            ->get();

        return $rows->map(fn ($row) => [
            'username' => $row->username,
            'password_hash' => $row->password_hash,
        ])->all();
    }

    /**
     * Add a user to PZ's whitelist SQLite database.
     *
     * PZ expects bcrypt-hashed password, world name, role, and authType fields.
     */
    public function add(string $username, string $password): bool
    {
        if ($this->exists($username)) {
            return false;
        }

        $hashedPassword = password_hash($password, PASSWORD_BCRYPT);

        $this->insertToSqlite($username, $hashedPassword);

        // Track in PostgreSQL (store bcrypt hash for future restore)
        WhitelistEntry::updateOrCreate(
            ['pz_username' => $username],
            [
                'pz_password_hash' => $hashedPassword,
                'active' => true,
                'synced_at' => now(),
            ],
        );

        return true;
    }

    /**
     * Restore a previously removed user using their stored bcrypt hash from PostgreSQL.
     *
     * Returns false if no stored hash exists or user is already whitelisted.
     */
    public function restore(string $username): bool
    {
        if ($this->exists($username)) {
            return false;
        }

        $entry = WhitelistEntry::where('pz_username', $username)
            ->whereNotNull('pz_password_hash')
            ->first();

        if (! $entry) {
            return false;
        }

        $this->insertToSqlite($username, $entry->pz_password_hash);

        $entry->update([
            'active' => true,
            'synced_at' => now(),
        ]);

        return true;
    }

    /**
     * Remove a user from PZ's whitelist SQLite database.
     *
     * Preserves the bcrypt hash in PostgreSQL so the user can be restored later
     * without needing to re-enter their password.
     */
    public function remove(string $username): bool
    {
        // Grab the bcrypt hash from SQLite before deleting
        $row = DB::connection('pz_sqlite')
            ->table('whitelist')
            ->where('username', $username)
            ->first();

        if (! $row) {
            return false;
        }

        DB::connection('pz_sqlite')
            ->table('whitelist')
            ->where('username', $username)
            ->delete();

        // Store the hash and mark inactive in PostgreSQL
        WhitelistEntry::updateOrCreate(
            ['pz_username' => $username],
            [
                'pz_password_hash' => $row->password,
                'active' => false,
                'synced_at' => now(),
            ],
        );

        return true;
    }

    /**
     * Check if a user exists in PZ's whitelist.
     */
    public function exists(string $username): bool
    {
        return DB::connection('pz_sqlite')
            ->table('whitelist')
            ->where('username', $username)
            ->exists();
    }

    /**
     * Check if a stored bcrypt hash exists in PostgreSQL for the given user.
     */
    public function hasStoredHash(string $username): bool
    {
        return WhitelistEntry::where('pz_username', $username)
            ->whereNotNull('pz_password_hash')
            ->exists();
    }

    /**
     * Sync PostgreSQL whitelist_entries with PZ's SQLite state.
     *
     * @return array{added: string[], removed: string[], mismatches: int}
     */
    public function syncWithPostgres(): array
    {
        $sqliteUsers = collect($this->list())->pluck('username')->all();
        $pgEntries = WhitelistEntry::where('active', true)->pluck('pz_username')->all();

        $added = [];
        $removed = [];

        // Users in SQLite but not tracked in PG
        $inSqliteOnly = array_diff($sqliteUsers, $pgEntries);
        foreach ($inSqliteOnly as $username) {
            WhitelistEntry::create([
                'pz_username' => $username,
                'active' => true,
                'synced_at' => now(),
            ]);
            $added[] = $username;
        }

        // Users tracked as active in PG but not in SQLite
        $inPgOnly = array_diff($pgEntries, $sqliteUsers);
        foreach ($inPgOnly as $username) {
            WhitelistEntry::where('pz_username', $username)
                ->update(['active' => false, 'synced_at' => now()]);
            $removed[] = $username;
        }

        // Update sync timestamp for all matched entries
        WhitelistEntry::whereIn('pz_username', array_intersect($sqliteUsers, $pgEntries))
            ->update(['synced_at' => now()]);

        $mismatches = count($added) + count($removed);

        Log::info('Whitelist sync completed', [
            'added' => $added,
            'removed' => $removed,
            'mismatches' => $mismatches,
        ]);

        return [
            'added' => $added,
            'removed' => $removed,
            'mismatches' => $mismatches,
        ];
    }

    /**
     * Insert a user into PZ's SQLite whitelist table with a pre-hashed password.
     */
    private function insertToSqlite(string $username, string $hashedPassword): void
    {
        $world = config('zomboid.server_name', 'ZomboidServer');

        DB::connection('pz_sqlite')
            ->table('whitelist')
            ->insert([
                'username' => $username,
                'password' => $hashedPassword,
                'world' => $world,
                'role' => 2,
                'authType' => 1,
            ]);
    }
}
