<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class PvpViolation extends Model
{
    /** @use HasFactory<\Database\Factories\PvpViolationFactory> */
    use HasFactory;

    protected $fillable = [
        'attacker',
        'victim',
        'zone_id',
        'zone_name',
        'attacker_x',
        'attacker_y',
        'strike_number',
        'status',
        'resolution_note',
        'resolved_by',
        'occurred_at',
        'resolved_at',
    ];

    protected function casts(): array
    {
        return [
            'strike_number' => 'integer',
            'attacker_x' => 'integer',
            'attacker_y' => 'integer',
            'occurred_at' => 'datetime',
            'resolved_at' => 'datetime',
        ];
    }
}
