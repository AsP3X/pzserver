<?php

namespace App\Services;

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class PzPasswordSyncService
{
    /**
     * Sync a plain-text password to PZ SQLite and update the tracked hash in PostgreSQL.
     */
    public function sync(string $username, string $plainPassword): void
    {
        try {
            $pzHash = PzAccountAuthenticator::hashForPz($plainPassword);

            DB::connection('pz_sqlite')
                ->table('whitelist')
                ->where('username', $username)
                ->update(['password' => $pzHash]);

            // Also update the tracked hash in PostgreSQL
            $user = User::where('username', $username)->first();
            if ($user) {
                $user->whitelistEntries()
                    ->where('pz_username', $username)
                    ->update([
                        'pz_password_hash' => $pzHash,
                        'synced_at' => now(),
                    ]);
            }
        } catch (\Exception $e) {
            Log::warning('Failed to sync password to PZ SQLite', [
                'username' => $username,
                'error' => $e->getMessage(),
            ]);
        }
    }
}
