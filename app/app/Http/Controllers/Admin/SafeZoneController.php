<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\ResolveViolationRequest;
use App\Http\Requests\Admin\StoreSafeZoneRequest;
use App\Http\Requests\Admin\UpdateSafeZoneConfigRequest;
use App\Models\PvpViolation;
use App\Services\AuditLogger;
use App\Services\MapConfigBuilder;
use App\Services\SafeZoneManager;
use Illuminate\Http\JsonResponse;
use Inertia\Inertia;
use Inertia\Response;

class SafeZoneController extends Controller
{
    public function __construct(
        private readonly SafeZoneManager $safeZoneManager,
        private readonly AuditLogger $auditLogger,
        private readonly MapConfigBuilder $mapConfigBuilder,
    ) {}

    public function index(): Response
    {
        // Import any pending violations from Lua on page load
        $this->safeZoneManager->importViolations();

        $config = $this->safeZoneManager->getConfig();
        $violations = PvpViolation::query()
            ->orderByDesc('occurred_at')
            ->limit(100)
            ->get();

        $mapConfig = $this->mapConfigBuilder->build();

        return Inertia::render('admin/safe-zones', [
            'config' => $config,
            'violations' => $violations,
            'mapConfig' => $mapConfig,
            'hasTiles' => $mapConfig['tileUrl'] !== null,
        ]);
    }

    public function updateConfig(UpdateSafeZoneConfigRequest $request): JsonResponse
    {
        $enabled = $request->boolean('enabled');
        $before = $this->safeZoneManager->getConfig();

        $this->safeZoneManager->updateConfig($enabled);

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'safezone.config.update',
            target: 'safezone_config',
            details: [
                'before' => ['enabled' => $before['enabled']],
                'after' => ['enabled' => $enabled],
            ],
            ip: $request->ip(),
        );

        return response()->json([
            'message' => $enabled ? 'Safe zones enabled' : 'Safe zones disabled',
            'config' => $this->safeZoneManager->getConfig(),
        ]);
    }

    public function store(StoreSafeZoneRequest $request): JsonResponse
    {
        $zone = $request->validated();

        $this->safeZoneManager->addZone($zone);

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'safezone.zone.create',
            target: $zone['name'],
            details: $zone,
            ip: $request->ip(),
        );

        return response()->json([
            'message' => "Safe zone '{$zone['name']}' created",
            'config' => $this->safeZoneManager->getConfig(),
        ]);
    }

    public function destroy(string $zoneId, \Illuminate\Http\Request $request): JsonResponse
    {
        $config = $this->safeZoneManager->getConfig();
        $zone = collect($config['zones'])->firstWhere('id', $zoneId);

        $this->safeZoneManager->removeZone($zoneId);

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'safezone.zone.delete',
            target: $zone['name'] ?? $zoneId,
            details: ['zone_id' => $zoneId],
            ip: $request->ip(),
        );

        return response()->json([
            'message' => 'Safe zone removed',
            'config' => $this->safeZoneManager->getConfig(),
        ]);
    }

    public function resolveViolation(int $id, ResolveViolationRequest $request): JsonResponse
    {
        $status = $request->validated('status');
        $note = $request->validated('note');
        $resolvedBy = $request->user()->name ?? 'admin';

        $violation = $this->safeZoneManager->resolveViolation($id, $status, $note, $resolvedBy);

        if (! $violation) {
            return response()->json(['error' => 'Violation not found'], 404);
        }

        $this->auditLogger->log(
            actor: $resolvedBy,
            action: "safezone.violation.{$status}",
            target: $violation->attacker,
            details: [
                'violation_id' => $id,
                'victim' => $violation->victim,
                'zone' => $violation->zone_name,
                'strike' => $violation->strike_number,
                'note' => $note,
            ],
            ip: $request->ip(),
        );

        return response()->json([
            'message' => "Violation {$status}",
            'violation' => $violation,
        ]);
    }
}
