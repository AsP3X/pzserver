<?php

namespace App\Http\Requests\Admin;

use App\Enums\BroadcastCadence;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreScheduledBroadcastRequest extends FormRequest
{
    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'message' => ['required', 'string', 'min:2', 'max:200'],
            'cadence' => ['required', Rule::enum(BroadcastCadence::class)],
            'interval_minutes' => [
                'nullable',
                'integer',
                'min:5',
                'max:1440',
                Rule::requiredIf(fn () => $this->input('cadence') === BroadcastCadence::Interval->value),
            ],
            'time' => [
                'nullable',
                'date_format:H:i',
                Rule::requiredIf(fn () => $this->input('cadence') === BroadcastCadence::Daily->value),
            ],
            'timezone' => ['nullable', 'string', 'timezone'],
            'enabled' => ['boolean'],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'interval_minutes.min' => 'Repeating more often than every 5 minutes would be spam.',
            'time.date_format' => 'Use a 24-hour time such as 18:30.',
        ];
    }
}
