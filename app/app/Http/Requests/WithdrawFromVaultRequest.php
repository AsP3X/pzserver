<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class WithdrawFromVaultRequest extends FormRequest
{
    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'full_type' => ['required', 'string', 'max:255'],
            'condition' => ['required', 'numeric', 'min:0', 'max:1'],
            'count' => ['required', 'integer', 'min:1', 'max:100'],
        ];
    }
}
