<?php

namespace App\Console\Commands;

use App\Models\AuditLog;
use App\Services\AuditLogger;
use App\Services\DiscordWebhookService;
use App\Services\SafeZoneManager;
use Illuminate\Console\Command;

class ImportPvpViolations extends Command
{
    protected $signature = 'zomboid:import-pvp-violations';

    protected $description = 'Import PvP safe zone violations from Lua bridge JSON to the database';

    public function handle(SafeZoneManager $manager, AuditLogger $auditLogger, DiscordWebhookService $discord): int
    {
        $count = $manager->importViolations();

        if ($count === 0) {
            return self::SUCCESS;
        }

        $this->info("Imported {$count} PvP violation(s).");

        $auditLog = $auditLogger->log(
            actor: 'system',
            action: 'safezone.violation.detected',
            target: null,
            details: ['count' => $count],
        );

        $webhookUrl = config('services.discord.webhook_url');
        if ($webhookUrl) {
            $discord->sendNotification($webhookUrl, $auditLog);
        }

        return self::SUCCESS;
    }
}
