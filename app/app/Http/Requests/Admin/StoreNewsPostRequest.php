<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;

class StoreNewsPostRequest extends FormRequest
{
    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'title' => ['required', 'string', 'min:3', 'max:150'],
            'excerpt' => ['nullable', 'string', 'max:250'],
            'body' => ['required', 'string', 'max:20000'],
            'pinned' => ['boolean'],
            'published_at' => ['nullable', 'date'],
            'broadcast' => ['boolean'],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'title.required' => 'A news post needs a title.',
            'body.required' => 'A news post needs something to say.',
        ];
    }
}
