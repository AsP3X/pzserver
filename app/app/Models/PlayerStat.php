<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class PlayerStat extends Model
{
    protected $primaryKey = 'username';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'username',
        'zombie_kills',
        'hours_survived',
        'profession',
        'skills',
        'traits',
        'vitals',
        'is_dead',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'zombie_kills' => 'integer',
            'hours_survived' => 'float',
            'skills' => 'array',
            'traits' => 'array',
            'vitals' => 'array',
            'is_dead' => 'boolean',
        ];
    }
}
