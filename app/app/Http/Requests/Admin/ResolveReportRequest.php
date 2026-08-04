<?php

namespace App\Http\Requests\Admin;

use App\Enums\ReportStatus;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class ResolveReportRequest extends FormRequest
{
    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'status' => ['required', Rule::enum(ReportStatus::class)],
            'resolution' => ['nullable', 'string', 'max:2000'],
        ];
    }
}
