<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class ServerStatusSample extends Model
{
    use HasFactory;

    public $timestamps = false;

    protected $fillable = [
        'online',
        'player_count',
        'game_status',
        'sampled_at',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'online' => 'boolean',
            'player_count' => 'integer',
            'sampled_at' => 'datetime',
        ];
    }
}
