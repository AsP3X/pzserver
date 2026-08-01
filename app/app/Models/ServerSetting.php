<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class ServerSetting extends Model
{
    protected $fillable = [
        'server_ip',
        'server_port',
    ];

    /**
     * Get the singleton settings instance, creating one if none exists.
     */
    public static function instance(): static
    {
        return static::query()->firstOrCreate([], [
            'server_ip' => '',
            'server_port' => '16261',
        ]);
    }
}
