<?php

namespace App\Console\Commands;

use App\Services\RaidDetector;
use Illuminate\Console\Command;

class DetectRaids extends Command
{
    protected $signature = 'zomboid:detect-raids';

    protected $description = 'Alert on players standing inside safehouses they do not belong to';

    public function handle(RaidDetector $detector): int
    {
        $alerts = $detector->scan();

        if ($alerts !== []) {
            $this->warn('Raised '.count($alerts).' raid alert(s).');
        }

        return self::SUCCESS;
    }
}
