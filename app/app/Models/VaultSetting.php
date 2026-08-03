<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class VaultSetting extends Model
{
    protected $fillable = [
        'default_slots', 'max_slots', 'slot_upgrade_increment',
        'slot_upgrade_cost', 'withdraw_fee_flat', 'withdraw_fee_per_item', 'enabled',
    ];

    protected function casts(): array
    {
        return [
            'default_slots' => 'integer',
            'max_slots' => 'integer',
            'slot_upgrade_increment' => 'integer',
            'slot_upgrade_cost' => 'float',
            'withdraw_fee_flat' => 'float',
            'withdraw_fee_per_item' => 'float',
            'enabled' => 'boolean',
        ];
    }

    /**
     * Get the singleton settings row, creating it with defaults if absent.
     */
    public static function instance(): static
    {
        return static::query()->firstOrCreate([], []);
    }
}
