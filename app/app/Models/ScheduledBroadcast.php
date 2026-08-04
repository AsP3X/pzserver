<?php

namespace App\Models;

use App\Enums\BroadcastCadence;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class ScheduledBroadcast extends Model
{
    use HasFactory;

    protected $fillable = [
        'message',
        'cadence',
        'interval_minutes',
        'time',
        'timezone',
        'enabled',
        'last_sent_at',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'cadence' => BroadcastCadence::class,
            'interval_minutes' => 'integer',
            'enabled' => 'boolean',
            'last_sent_at' => 'datetime',
        ];
    }

    /**
     * Is this line due to go out?
     *
     * `$now` is injected so the decision stays a pure function of time — the
     * scheduler runs every minute and must never fire the same line twice.
     */
    public function isDue(CarbonImmutable $now): bool
    {
        if (! $this->enabled) {
            return false;
        }

        return match ($this->cadence) {
            BroadcastCadence::Interval => $this->intervalIsDue($now),
            BroadcastCadence::Daily => $this->dailyIsDue($now),
        };
    }

    /**
     * Every N minutes, counted from the last send. A line that has never been
     * sent goes out on the next tick.
     */
    private function intervalIsDue(CarbonImmutable $now): bool
    {
        $minutes = $this->interval_minutes;

        if ($minutes === null || $minutes < 1) {
            return false;
        }

        if ($this->last_sent_at === null) {
            return true;
        }

        return $this->last_sent_at->clone()->addMinutes($minutes)->lessThanOrEqualTo($now);
    }

    /**
     * Once per day at a wall-clock time, in this broadcast's own timezone.
     *
     * The window is the whole minute rather than an instant, because the
     * scheduler's tick will not land exactly on the second.
     */
    private function dailyIsDue(CarbonImmutable $now): bool
    {
        if ($this->time === null) {
            return false;
        }

        $local = $now->setTimezone($this->timezone ?: config('app.timezone'));

        if ($local->format('H:i') !== $this->time) {
            return false;
        }

        return $this->last_sent_at === null
            || $this->last_sent_at->clone()->setTimezone($this->timezone ?: config('app.timezone'))
                ->format('Y-m-d H:i') !== $local->format('Y-m-d H:i');
    }
}
