<?php

namespace App\Http\Requests\Admin;

use App\Services\WorldActionManager;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class TriggerWorldActionRequest extends FormRequest
{
    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'action' => ['required', Rule::in(['storm', 'clear_weather'])],
            'duration_hours' => ['nullable', 'integer', 'min:1', 'max:'.WorldActionManager::MAX_STORM_HOURS],
        ];
    }
}
