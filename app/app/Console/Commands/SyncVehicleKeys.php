<?php

namespace App\Console\Commands;

use App\Models\VehicleKeyHolder;
use App\Services\VehicleReader;
use Illuminate\Console\Command;

class SyncVehicleKeys extends Command
{
    protected $signature = 'zomboid:sync-vehicle-keys';

    protected $description = 'Remember who was last seen holding each vehicle key';

    public function handle(VehicleReader $vehicles): int
    {
        $seen = 0;

        foreach ($vehicles->read()['vehicles'] as $vehicle) {
            foreach ($vehicle['key_holders'] as $username) {
                /**
                 * Upserted, never deleted on absence. A holder missing from
                 * this export is almost always a player who logged off, not
                 * one who threw their keys away — dropping the row would make
                 * ownership flicker with the roster.
                 */
                VehicleKeyHolder::query()->updateOrCreate(
                    ['vehicle_id' => $vehicle['id'], 'username' => $username],
                    ['key_id' => $vehicle['key_id'] ?? 0, 'last_seen_at' => now()],
                );

                $seen++;
            }
        }

        if ($seen > 0) {
            $this->info("Recorded {$seen} key holder(s).");
        }

        return self::SUCCESS;
    }
}
