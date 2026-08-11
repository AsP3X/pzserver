<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;

class TeleportPlayerRequest extends FormRequest
{
    /**
     * Coordinates are bounded rather than merely numeric: the map hands them
     * over from a click, and a world square outside the map is a dropped
     * player, not a teleport.
     *
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'x' => ['required', 'numeric', 'min:0', 'max:200000'],
            'y' => ['required', 'numeric', 'min:0', 'max:200000'],
            'z' => ['sometimes', 'numeric', 'min:0', 'max:32'],
        ];
    }
}
