<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class MoneyDeposit extends Model
{
    use HasUuids;

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id',
        'username',
        'user_id',
        'status',
        'money_count',
        'bundle_count',
        'total_coins',
        'message',
        'source',
        'dry_run',
        'credited',
        'processed_at',
        'credited_at',
        'meta',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'dry_run' => 'boolean',
            'credited' => 'boolean',
            'processed_at' => 'datetime',
            'credited_at' => 'datetime',
            'meta' => 'array',
            'money_count' => 'integer',
            'bundle_count' => 'integer',
            'total_coins' => 'integer',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function isPending(): bool
    {
        return $this->status === 'pending';
    }
}
