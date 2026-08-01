<?php

namespace App\Http\Requests\Api;

use Illuminate\Foundation\Http\FormRequest;

class ServerLogsRequest extends FormRequest
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
            'tail' => ['sometimes', 'integer', 'min:1', 'max:1000'],
            'since' => ['sometimes', 'date'],
        ];
    }
}
