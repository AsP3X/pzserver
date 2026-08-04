<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;

class UpdateNewsPostRequest extends FormRequest
{
    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'title' => ['sometimes', 'string', 'min:3', 'max:150'],
            'excerpt' => ['nullable', 'string', 'max:250'],
            'body' => ['sometimes', 'string', 'max:20000'],
            'pinned' => ['boolean'],
            'published_at' => ['nullable', 'date'],
        ];
    }
}
