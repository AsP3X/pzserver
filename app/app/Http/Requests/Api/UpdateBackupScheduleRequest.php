<?php

namespace App\Http\Requests\Api;

use Illuminate\Foundation\Http\FormRequest;

class UpdateBackupScheduleRequest extends FormRequest
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
            'hourly_enabled' => ['sometimes', 'boolean'],
            'daily_enabled' => ['sometimes', 'boolean'],
            'daily_time' => ['sometimes', 'string', 'date_format:H:i'],
            'retention_manual' => ['sometimes', 'integer', 'min:1', 'max:100'],
            'retention_scheduled' => ['sometimes', 'integer', 'min:1', 'max:100'],
            'retention_daily' => ['sometimes', 'integer', 'min:1', 'max:100'],
            'retention_pre_rollback' => ['sometimes', 'integer', 'min:1', 'max:100'],
            'retention_pre_update' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ];
    }
}
