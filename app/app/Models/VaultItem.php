<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class VaultItem extends Model
{
    use HasFactory, HasUuids;

    protected $fillable = ['vault_id', 'full_type', 'name', 'category', 'condition', 'count'];

    protected function casts(): array
    {
        return ['condition' => 'float', 'count' => 'integer'];
    }

    /**
     * @return BelongsTo<Vault, $this>
     */
    public function vault(): BelongsTo
    {
        return $this->belongsTo(Vault::class);
    }
}
