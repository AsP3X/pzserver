<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\UpdateServerSettingRequest;
use App\Models\ServerSetting;
use App\Services\AuditLogger;
use Illuminate\Http\JsonResponse;

class ServerSettingController extends Controller
{
    public function __construct(
        private readonly AuditLogger $auditLogger,
    ) {}

    public function update(UpdateServerSettingRequest $request): JsonResponse
    {
        $settings = ServerSetting::instance();
        $settings->update($request->validated());

        $this->auditLogger->log(
            actor: $request->user()->username,
            action: 'server_settings.update',
            details: $request->validated(),
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Connection settings saved']);
    }
}
