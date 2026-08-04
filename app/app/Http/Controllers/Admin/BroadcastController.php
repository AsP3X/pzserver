<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\StoreScheduledBroadcastRequest;
use App\Jobs\BroadcastMessage;
use App\Models\ScheduledBroadcast;
use App\Services\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class BroadcastController extends Controller
{
    public function __construct(
        private readonly AuditLogger $auditLogger,
    ) {}

    public function store(StoreScheduledBroadcastRequest $request): JsonResponse
    {
        $validated = $request->validated();

        $broadcast = ScheduledBroadcast::query()->create([
            ...$validated,
            'timezone' => $validated['timezone'] ?? config('app.timezone'),
        ]);

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'broadcast.create',
            target: $broadcast->message,
            details: [
                'broadcast_id' => $broadcast->id,
                'cadence' => $broadcast->cadence->value,
            ],
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Broadcast scheduled', 'broadcast' => $broadcast], 201);
    }

    /**
     * Flip a broadcast on or off without losing how it was set up.
     */
    public function toggle(Request $request, ScheduledBroadcast $broadcast): JsonResponse
    {
        $broadcast->update(['enabled' => ! $broadcast->enabled]);

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'broadcast.toggle',
            target: $broadcast->message,
            details: ['broadcast_id' => $broadcast->id, 'enabled' => $broadcast->enabled],
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Broadcast updated', 'broadcast' => $broadcast]);
    }

    /**
     * Send one now, without disturbing its schedule.
     */
    public function sendNow(Request $request, ScheduledBroadcast $broadcast): JsonResponse
    {
        BroadcastMessage::dispatch($broadcast->message);

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'broadcast.send',
            target: $broadcast->message,
            details: ['broadcast_id' => $broadcast->id],
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Broadcast sent']);
    }

    public function destroy(Request $request, ScheduledBroadcast $broadcast): JsonResponse
    {
        $message = $broadcast->message;
        $broadcast->delete();

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'broadcast.delete',
            target: $message,
            details: [],
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Broadcast deleted']);
    }
}
