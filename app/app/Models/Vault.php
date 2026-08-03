<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Vault extends Model
{
    use HasFactory, HasUuids;

    protected $fillable = ['user_id', 'slot_capacity'];

    protected function casts(): array
    {
        return ['slot_capacity' => 'integer'];
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /**
     * @return HasMany<VaultItem, $this>
     */
    public function items(): HasMany
    {
        return $this->hasMany(VaultItem::class);
    }

    /**
     * @return HasMany<VaultTransaction, $this>
     */
    public function transactions(): HasMany
    {
        return $this->hasMany(VaultTransaction::class);
    }
}
