<?php

namespace App\Http\Requests\Admin;

use App\Models\DiscordWebhookSetting;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class UpdateDiscordWebhookRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        $availableEvents = array_keys(DiscordWebhookSetting::availableEvents());

        return [
            'webhook_url' => ['sometimes', 'nullable', 'url', 'regex:/^https:\/\/discord\.com\/api\/webhooks\//'],
            'enabled' => ['sometimes', 'boolean'],
            'enabled_events' => ['sometimes', 'array'],
            'enabled_events.*' => ['string', Rule::in($availableEvents)],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'webhook_url.regex' => 'The webhook URL must be a valid Discord webhook URL.',
        ];
    }
}
