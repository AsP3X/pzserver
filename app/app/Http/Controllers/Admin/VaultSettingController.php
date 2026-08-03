<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\UpdateVaultSettingsRequest;
use App\Models\VaultSetting;
use App\Services\AuditLogger;
use Illuminate\Http\RedirectResponse;
use Inertia\Inertia;
use Inertia\Response;

class VaultSettingController extends Controller
{
    public function __construct(private readonly AuditLogger $auditLogger) {}

    public function index(): Response
    {
        return Inertia::render('admin/vault-settings', [
            'settings' => VaultSetting::instance(),
        ]);
    }

    public function update(UpdateVaultSettingsRequest $request): RedirectResponse
    {
        $validated = $request->validated();

        $settings = VaultSetting::instance();
        $settings->fill($validated);
        $settings->save();

        $this->auditLogger->log(
            actor: $request->user()->username ?? 'admin',
            action: 'vault.settings.update',
            target: 'vault_settings',
            details: $validated,
            ip: $request->ip(),
        );

        return back();
    }
}
