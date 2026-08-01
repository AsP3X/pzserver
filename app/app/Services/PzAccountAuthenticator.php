<?php

namespace App\Services;

use App\Enums\UserRole;
use App\Models\User;
use App\Models\WhitelistEntry;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;

class PzAccountAuthenticator
{
    /**
     * Attempt to authenticate a user, creating a web account from PZ SQLite if needed.
     *
     * 1. Existing web user → Hash::check against stored hash → return user
     * 2. No web user, check PZ SQLite → verify password → auto-create User + WhitelistEntry → return user
     * 3. PZ SQLite unavailable → log warning, return null (normal login failure)
     */
    public function authenticate(Request $request): ?User
    {
        $username = $request->input('username');
        $password = $request->input('password');

        // Step 1: Check existing web user
        $user = User::where('username', $username)->first();

        if ($user) {
            // Try normal Laravel hash first
            if (Hash::check($password, $user->password)) {
                return $user;
            }

            // Web password may be a PZ hash (bcrypt(md5(password))) from the sync command.
            // Verify against PZ SQLite and fix the web password if it matches.
            return $this->revalidateViaPzSqlite($user, $password);
        }

        // Step 2: No web user — try PZ SQLite
        return $this->authenticateViaPzSqlite($username, $password);
    }

    /**
     * Existing web user's password didn't match via Hash::check.
     * Try verifying against PZ SQLite and fix the web password if valid.
     */
    private function revalidateViaPzSqlite(User $user, string $password): ?User
    {
        try {
            $pzAccount = DB::connection('pz_sqlite')
                ->table('whitelist')
                ->where('username', $user->username)
                ->first();
        } catch (\Exception $e) {
            return null;
        }

        if (! $pzAccount || ! $this->verifyPzPassword($password, $pzAccount->password)) {
            return null;
        }

        // PZ password verified — fix the web password to use standard Laravel hashing
        $user->forceFill(['password' => Hash::make($password)])->save();

        Log::info('Fixed web password from PZ hash for existing user', [
            'username' => $user->username,
        ]);

        return $user;
    }

    /**
     * Verify credentials against PZ SQLite and auto-create web account.
     */
    private function authenticateViaPzSqlite(string $username, string $password): ?User
    {
        try {
            $pzAccount = DB::connection('pz_sqlite')
                ->table('whitelist')
                ->where('username', $username)
                ->first();
        } catch (\Exception $e) {
            Log::warning('PZ SQLite unavailable during login attempt', [
                'username' => $username,
                'error' => $e->getMessage(),
            ]);

            return null;
        }

        if (! $pzAccount) {
            return null;
        }

        // Verify the password against PZ's stored value
        if (! $this->verifyPzPassword($password, $pzAccount->password)) {
            return null;
        }

        // Password verified — auto-create web account with the plain password hashed for Laravel
        $user = User::forceCreate([
            'username' => $username,
            'name' => $username,
            'password' => Hash::make($password),
            'role' => UserRole::Player,
        ]);

        WhitelistEntry::create([
            'user_id' => $user->id,
            'pz_username' => $username,
            'pz_password_hash' => $pzAccount->password,
            'active' => true,
            'synced_at' => now(),
        ]);

        Log::info('Auto-created web user from PZ account at login', [
            'username' => $username,
        ]);

        return $user;
    }

    /**
     * Verify a plain-text password against PZ's stored password.
     *
     * PZ uses a two-step hashing scheme: bcrypt(md5(password)) with a fixed salt.
     * We try both the PZ scheme and plain bcrypt for compatibility.
     */
    private function verifyPzPassword(string $password, string $storedPassword): bool
    {
        if (str_starts_with($storedPassword, '$2')) {
            // PZ hashes as bcrypt(md5(password)) with a fixed salt
            if (password_verify(md5($password), $storedPassword)) {
                return true;
            }

            // Fallback: plain bcrypt (e.g. accounts created by the web app)
            return password_verify($password, $storedPassword);
        }

        return $password === $storedPassword;
    }

    /**
     * Hash a plain-text password the way PZ does: bcrypt(md5(password), fixed_salt).
     *
     * Used when writing passwords to PZ SQLite so the game server can verify them.
     */
    public static function hashForPz(string $password): string
    {
        return crypt(md5($password), '$2a$12$O/BFHoDFPrfFaNPAACmWpu');
    }
}
