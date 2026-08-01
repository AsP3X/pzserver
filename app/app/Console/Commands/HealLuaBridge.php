<?php

namespace App\Console\Commands;

use App\Services\LuaBridgeRepairService;
use Illuminate\Console\Command;

class HealLuaBridge extends Command
{
    protected $signature = 'zomboid:heal-lua-bridge';

    protected $description = 'Self-heal Lua bridge directory permissions and placeholder files';

    public function handle(LuaBridgeRepairService $repair): int
    {
        $result = $repair->repair();

        foreach ($result['actions'] as $action) {
            $this->line("  · {$action}");
        }

        if (! empty($result['errors'])) {
            foreach ($result['errors'] as $error) {
                $this->warn("  ! {$error}");
            }
        }

        if ($result['ok']) {
            $this->info('Lua bridge healthy.');

            return self::SUCCESS;
        }

        $this->error('Lua bridge still has issues — check Admin → Lua Bridge.');

        return self::FAILURE;
    }
}
