<?php

namespace App\Models;

use App\Enums\ReportKind;
use App\Enums\ReportStatus;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class PlayerReport extends Model
{
    use HasFactory;

    protected $fillable = [
        'user_id',
        'kind',
        'subject',
        'body',
        'accused',
        'status',
        'resolution',
        'handled_by',
        'handled_at',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'kind' => ReportKind::class,
            'status' => ReportStatus::class,
            'handled_at' => 'datetime',
        ];
    }

    public function author(): BelongsTo
    {
        return $this->belongsTo(User::class, 'user_id');
    }

    public function handler(): BelongsTo
    {
        return $this->belongsTo(User::class, 'handled_by');
    }

    /** Still needs someone to look at it. */
    public function scopeUnresolved(Builder $query): Builder
    {
        return $query->whereIn('status', [ReportStatus::Open->value, ReportStatus::Investigating->value]);
    }

    public function isClosed(): bool
    {
        return in_array($this->status, [ReportStatus::Resolved, ReportStatus::Rejected], true);
    }
}
