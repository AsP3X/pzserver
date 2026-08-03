<?php

namespace App\Models;

use App\Enums\VaultDirection;
use App\Enums\VaultTransactionStatus;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class VaultTransaction extends Model
{
    use HasFactory, HasUuids;

    protected $fillable = [
        'vault_id', 'direction', 'status', 'full_type', 'condition',
        'requested_count', 'actual_count', 'fee_charged',
        'wallet_transaction_id', 'delivery_id', 'message',
    ];

    protected function casts(): array
    {
        return [
            'direction' => VaultDirection::class,
            'status' => VaultTransactionStatus::class,
            'condition' => 'float',
            'requested_count' => 'integer',
            'actual_count' => 'integer',
            'fee_charged' => 'decimal:2',
        ];
    }

    /**
     * @return BelongsTo<Vault, $this>
     */
    public function vault(): BelongsTo
    {
        return $this->belongsTo(Vault::class);
    }
}
