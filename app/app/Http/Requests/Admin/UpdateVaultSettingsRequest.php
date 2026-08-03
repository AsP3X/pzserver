<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;

class UpdateVaultSettingsRequest extends FormRequest
{
    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'default_slots' => ['required', 'integer', 'min:1', 'max:10000'],
            'max_slots' => ['required', 'integer', 'min:1', 'max:10000'],
            'slot_upgrade_increment' => ['required', 'integer', 'min:1', 'max:1000'],
            'slot_upgrade_cost' => ['required', 'numeric', 'min:0', 'max:1000000'],
            'withdraw_fee_flat' => ['required', 'numeric', 'min:0', 'max:1000000'],
            'withdraw_fee_per_item' => ['required', 'numeric', 'min:0', 'max:1000000'],
            'enabled' => ['required', 'boolean'],
        ];
    }
}
