<?php

namespace App\Console\Commands;

use App\Models\ServerStatusSample;
use App\Services\ServerHistoryService;
use App\Services\ServerStatusResolver;
use Illuminate\Console\Command;

class SampleServerStatus extends Command
{
    protected $signature = 'zomboid:sample-status';

    protected $description = 'Record one server status sample for the uptime history';

    public function handle(ServerStatusResolver $resolver, ServerHistoryService $history): int
    {
        $resolved = $resolver->resolve();

        ServerStatusSample::query()->create([
            'online' => $resolved['online'],
            'player_count' => $resolved['player_count'],
            'game_status' => $resolved['game_status'],
            'sampled_at' => now(),
        ]);

        /**
         * Pruning rides along with the sampler rather than owning a schedule
         * entry: it is cheap, and it cannot then be forgotten separately.
         */
        $pruned = $history->prune();

        if ($pruned > 0) {
            $this->info("Pruned {$pruned} sample(s) past retention.");
        }

        return self::SUCCESS;
    }
}
