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
     * Default values, mirrored from the migration.
     *
     * Passed explicitly on create so the returned model always has them
     * populated — relying on database defaults leaves the in-memory
     * attributes null until the row is re-read.
     *
     * @var array<string, int|float|bool>
     */
    private const DEFAULTS = [
        'default_slots' => 50,
        'max_slots' => 500,
        'slot_upgrade_increment' => 10,
        'slot_upgrade_cost' => 100,
        'withdraw_fee_flat' => 5,
        'withdraw_fee_per_item' => 0,
        'enabled' => true,
    ];

    /**
     * Get the singleton settings row, creating it with defaults if absent.
     */
    public static function instance(): static
    {
        return static::query()->firstOrCreate([], self::DEFAULTS);
    }
}
