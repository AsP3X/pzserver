<?php

namespace App\Console\Commands;

use App\Enums\UserRole;
use App\Models\User;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

class CreateAdmin extends Command
{
    /** @var string */
    protected $signature = 'zomboid:create-admin
        {--username= : Admin username}
        {--email= : Admin email address}
        {--password= : Admin password}
        {--reset : Overwrite the existing super admin credentials}';

    /** @var string */
    protected $description = 'Create the super admin user (use --reset to overwrite an existing admin)';

    public function handle(): int
    {
        $username = $this->option('username') ?: config('zomboid.admin.username');
        $password = $this->option('password') ?: config('zomboid.admin.password');
        $email = $this->option('email') ?: config('zomboid.admin.email') ?: null;

        if (empty($username) || empty($password)) {
            $this->error('Username and password are required. Provide via --username/--password options or ADMIN_USERNAME/ADMIN_PASSWORD env vars.');

            return self::FAILURE;
        }

        $existing = User::where('role', UserRole::SuperAdmin)->first();

        if ($existing) {
            if (! $this->option('reset')) {
                // Do NOT overwrite credentials — the admin may have changed their
                // password via the web UI.  Overwriting on every container restart
                // silently reverts to the ADMIN_PASSWORD env var and locks the
                // admin out of the account they already control.
                $this->info("Super admin '{$existing->username}' already exists — leaving credentials untouched.");
                $this->info('Pass --reset to overwrite username/email/password.');

                return self::SUCCESS;
            }

            $existing->update([
                'username' => $username,
                'name' => $username,
                'email' => $email,
                'password' => $password,
            ]);

            if ($email) {
                $existing->forceFill(['email_verified_at' => now()])->save();
            }

            Log::info('Super admin user reset', ['username' => $username]);
            $this->info("Super admin '{$username}' reset successfully.");

            return self::SUCCESS;
        }

        $user = User::create([
            'username' => $username,
            'name' => $username,
            'email' => $email,
            'password' => $password,
            'role' => UserRole::SuperAdmin,
        ]);

        if ($email) {
            $user->forceFill(['email_verified_at' => now()])->save();
        }

        Log::info('Super admin user created', ['username' => $username]);
        $this->info("Super admin '{$username}' created successfully.");

        return self::SUCCESS;
    }
}
