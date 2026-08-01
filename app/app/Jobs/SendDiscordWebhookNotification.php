<?php

namespace App\Jobs;

use App\Models\AuditLog;
use App\Services\DiscordWebhookService;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

class SendDiscordWebhookNotification implements ShouldQueue
{
    use Queueable;

    public int $tries = 3;

    public int $backoff = 5;

    public function __construct(
        private readonly string $webhookUrl,
        private readonly string $auditLogId,
    ) {}

    public function handle(DiscordWebhookService $service): void
    {
        $auditLog = AuditLog::find($this->auditLogId);

        if (! $auditLog) {
            return;
        }

        $service->sendNotification($this->webhookUrl, $auditLog);
    }
}
