<?php

namespace App\Console\Commands;

use App\Jobs\BroadcastMessage;
use App\Models\ScheduledBroadcast;
use Carbon\CarbonImmutable;
use Illuminate\Console\Command;

class SendScheduledBroadcasts extends Command
{
    protected $signature = 'zomboid:send-broadcasts';

    protected $description = 'Send any recurring server broadcasts that are due';

    public function handle(): int
    {
        $now = CarbonImmutable::now();
        $sent = 0;

        foreach (ScheduledBroadcast::query()->where('enabled', true)->get() as $broadcast) {
            if (! $broadcast->isDue($now)) {
                continue;
            }

            BroadcastMessage::dispatch($broadcast->message);

            /**
             * Stamped on dispatch, not on delivery. If RCON is down the line is
             * dropped rather than queued up to arrive in a burst when the server
             * comes back — nobody wants six hours of hourly reminders at once.
             */
            $broadcast->forceFill(['last_sent_at' => $now])->save();

            $sent++;
        }

        if ($sent > 0) {
            $this->info("Dispatched {$sent} broadcast(s).");
        }

        return self::SUCCESS;
    }
}
