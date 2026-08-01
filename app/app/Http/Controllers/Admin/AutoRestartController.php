<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\StoreScheduledTimeRequest;
use App\Http\Requests\Admin\UpdateAutoRestartRequest;
use App\Models\AutoRestartSetting;
use App\Models\ScheduledRestartTime;
use App\Services\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Cache;
use Inertia\Inertia;
use Inertia\Response;

class AutoRestartController extends Controller
{
    public function __construct(
        private readonly AuditLogger $auditLogger,
    ) {}

    public function index(): Response
    {
        $settings = AutoRestartSetting::instance();
        $schedule = ScheduledRestartTime::query()->orderBy('time')->get();

        return Inertia::render('admin/auto-restart', [
            'settings' => [
                'enabled' => $settings->enabled,
                'warning_minutes' => $settings->warning_minutes,
                'warning_message' => $settings->warning_message,
                'timezone' => $settings->timezone,
                'discord_reminder_minutes' => $settings->discord_reminder_minutes,
            ],
            'schedule' => $schedule->map(fn (ScheduledRestartTime $t) => [
                'id' => $t->id,
                'time' => $t->time,
                'enabled' => $t->enabled,
            ])->values()->all(),
            'next_restart_at' => $settings->getNextRestartTime()?->toIso8601String(),
        ]);
    }

    public function update(UpdateAutoRestartRequest $request): JsonResponse
    {
        $settings = AutoRestartSetting::instance();
        $validated = $request->validated();

        $wasEnabled = $settings->enabled;

        if (array_key_exists('enabled', $validated)) {
            $settings->enabled = $validated['enabled'];
        }

        if (array_key_exists('warning_minutes', $validated)) {
            $settings->warning_minutes = $validated['warning_minutes'];
        }

        if (array_key_exists('warning_message', $validated)) {
            $settings->warning_message = $validated['warning_message'];
        }

        if (array_key_exists('timezone', $validated)) {
            $settings->timezone = $validated['timezone'];
        }

        if (array_key_exists('discord_reminder_minutes', $validated)) {
            $settings->discord_reminder_minutes = $validated['discord_reminder_minutes'];
        }

        // Handle enable/disable transitions
        if ($settings->enabled && ! $wasEnabled) {
            Cache::forget('server.auto_restart.pending');
        } elseif (! $settings->enabled && $wasEnabled) {
            Cache::forget('server.auto_restart.pending');
            Cache::forget('server.pending_action:restart');
        }

        $settings->save();

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'autorestart.settings.update',
            details: [
                'enabled' => $settings->enabled,
                'warning_minutes' => $settings->warning_minutes,
                'timezone' => $settings->timezone,
                'discord_reminder_minutes' => $settings->discord_reminder_minutes,
            ],
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Auto-restart settings updated']);
    }

    public function storeTime(StoreScheduledTimeRequest $request): JsonResponse
    {
        $count = ScheduledRestartTime::query()->count();

        if ($count >= 5) {
            return response()->json(['message' => 'Maximum of 5 scheduled times allowed'], 422);
        }

        ScheduledRestartTime::create($request->validated());

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'autorestart.time.added',
            details: ['time' => $request->validated('time')],
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Restart time added']);
    }

    public function destroyTime(ScheduledRestartTime $time): JsonResponse
    {
        $time->delete();

        return response()->json(['message' => 'Restart time removed']);
    }

    public function toggleTime(ScheduledRestartTime $time): JsonResponse
    {
        $time->enabled = ! $time->enabled;
        $time->save();

        return response()->json([
            'message' => $time->enabled ? 'Restart time enabled' : 'Restart time disabled',
            'enabled' => $time->enabled,
        ]);
    }
}
