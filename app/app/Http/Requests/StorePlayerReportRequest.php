<?php

namespace App\Http\Requests;

use App\Enums\ReportKind;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StorePlayerReportRequest extends FormRequest
{
    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'kind' => ['required', Rule::enum(ReportKind::class)],
            'subject' => ['required', 'string', 'min:3', 'max:150'],
            'body' => ['required', 'string', 'min:10', 'max:5000'],
            'accused' => [
                'nullable',
                'string',
                'max:50',
                'regex:/^[a-zA-Z0-9_ -]+$/',
                Rule::requiredIf(fn () => $this->input('kind') === ReportKind::Report->value),
            ],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'accused.required' => 'Say who you are reporting.',
            'body.min' => 'Give the team enough detail to act on.',
        ];
    }
}
