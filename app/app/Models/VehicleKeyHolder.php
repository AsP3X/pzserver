<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class VehicleKeyHolder extends Model
{
    use HasFactory;

    protected $fillable = [
        'vehicle_id',
        'key_id',
        'username',
        'last_seen_at',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'vehicle_id' => 'integer',
            'key_id' => 'integer',
            'last_seen_at' => 'datetime',
        ];
    }
}
