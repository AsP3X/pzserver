<?php

namespace App\Jobs;

use App\Services\RconClient;
use App\Services\RconSanitizer;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * Put one line in front of everyone currently playing.
 *
 * Unlike SendServerWarning this carries no cache gate: a broadcast is not part
 * of a countdown that can be cancelled, it is a message someone chose to send.
 */
class BroadcastMessage implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public function __construct(private readonly string $message) {}

    public function handle(RconClient $rcon): void
    {
        try {
            $rcon->connect();
            $rcon->command('servermsg "'.RconSanitizer::message($this->message).'"');
        } catch (\Throwable) {
            /** An offline server is not an error worth retrying a broadcast for. */
        }
    }
}
