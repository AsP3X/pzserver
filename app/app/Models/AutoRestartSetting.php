<?php

namespace App\Models;

use Carbon\Carbon;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class AutoRestartSetting extends Model
{
    use HasFactory;

    protected $fillable = [
        'enabled',
        'warning_minutes',
        'warning_message',
        'timezone',
        'discord_reminder_minutes',
    ];

    protected function casts(): array
    {
        return [
            'enabled' => 'boolean',
            'warning_minutes' => 'integer',
            'discord_reminder_minutes' => 'integer',
        ];
    }

    /**
     * Get the singleton settings instance, creating one if none exists.
     */
    public static function instance(): static
    {
        return static::query()->firstOrCreate([], [
            'enabled' => false,
            'warning_minutes' => 5,
            'timezone' => 'Asia/Tbilisi',
            'discord_reminder_minutes' => 30,
        ]);
    }

    /**
     * Compute the next upcoming restart time from scheduled times.
     */
    public function getNextRestartTime(): ?Carbon
    {
        $times = ScheduledRestartTime::query()
            ->where('enabled', true)
            ->orderBy('time')
            ->pluck('time');

        if ($times->isEmpty()) {
            return null;
        }

        $tz = $this->timezone ?? 'Asia/Tbilisi';
        $nowInTz = now($tz);

        // Find first time today that hasn't passed
        foreach ($times as $time) {
            $candidate = Carbon::createFromFormat('H:i', $time, $tz)->setDateFrom($nowInTz);
            if ($candidate->gt($nowInTz)) {
                return $candidate->utc();
            }
        }

        // All times passed today — return first time tomorrow
        $firstTime = $times->first();

        return Carbon::createFromFormat('H:i', $firstTime, $tz)
            ->setDateFrom($nowInTz)
            ->addDay()
            ->utc();
    }
}
