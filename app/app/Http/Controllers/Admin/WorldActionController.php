<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\TriggerWorldActionRequest;
use App\Services\AuditLogger;
use App\Services\WorldActionManager;
use Illuminate\Http\JsonResponse;

class WorldActionController extends Controller
{
    public function __construct(
        private readonly WorldActionManager $worldActions,
        private readonly AuditLogger $auditLogger,
    ) {}

    public function store(TriggerWorldActionRequest $request): JsonResponse
    {
        $validated = $request->validated();

        $entry = match ($validated['action']) {
            'storm' => $this->worldActions->triggerStorm((int) ($validated['duration_hours'] ?? 3)),
            'clear_weather' => $this->worldActions->clearWeather(),
        };

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'world.'.$validated['action'],
            target: 'world',
            details: $entry,
            ip: $request->ip(),
        );

        return response()->json([
            'message' => 'World action queued',
            'entry' => $entry,
        ], 201);
    }
}
