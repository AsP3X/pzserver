<?php

namespace App\Console\Commands;

use App\Services\LogExtenderParser;
use Illuminate\Console\Command;

class ParseGameEvents extends Command
{
    protected $signature = 'zomboid:parse-game-events';

    protected $description = 'Parse Log Extender files into game events database';

    public function handle(LogExtenderParser $parser): int
    {
        if (! $parser->isInstalled()) {
            $this->info('Log Extender not detected (no log files found).');

            return self::SUCCESS;
        }

        $count = $parser->parseAll();

        if ($count > 0) {
            $this->info("Parsed {$count} new game event(s).");
        } else {
            $this->info('No new game events to parse.');
        }

        return self::SUCCESS;
    }
}
