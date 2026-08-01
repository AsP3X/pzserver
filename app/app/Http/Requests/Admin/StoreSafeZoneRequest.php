<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;

class StoreSafeZoneRequest extends FormRequest
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
            'id' => ['required', 'string', 'max:50'],
            'name' => ['required', 'string', 'max:100'],
            'x1' => ['required', 'integer'],
            'y1' => ['required', 'integer'],
            'x2' => ['required', 'integer'],
            'y2' => ['required', 'integer'],
        ];
    }
}
