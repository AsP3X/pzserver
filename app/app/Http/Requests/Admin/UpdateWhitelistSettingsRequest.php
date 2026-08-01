<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;

class UpdateWhitelistSettingsRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'open' => ['sometimes', 'boolean'],
            'auto_create_user_in_whitelist' => ['sometimes', 'boolean'],
        ];
    }
}
