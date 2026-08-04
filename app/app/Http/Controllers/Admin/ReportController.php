<?php

namespace App\Http\Controllers\Admin;

use App\Enums\ReportStatus;
use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\ResolveReportRequest;
use App\Models\PlayerReport;
use App\Services\AuditLogger;
use Illuminate\Http\JsonResponse;
use Inertia\Inertia;
use Inertia\Response;

class ReportController extends Controller
{
    public function __construct(
        private readonly AuditLogger $auditLogger,
    ) {}

    public function index(): Response
    {
        $reports = PlayerReport::query()
            ->with(['author:id,name,username', 'handler:id,name,username'])
            ->orderByRaw("CASE WHEN status IN ('open', 'investigating') THEN 0 ELSE 1 END")
            ->latest()
            ->limit(200)
            ->get()
            ->map(fn (PlayerReport $report) => [
                'id' => $report->id,
                'kind' => $report->kind->value,
                'subject' => $report->subject,
                'body' => $report->body,
                'accused' => $report->accused,
                'status' => $report->status->value,
                'resolution' => $report->resolution,
                'author' => $report->author?->username ?? $report->author?->name,
                'handler' => $report->handler?->username ?? $report->handler?->name,
                'created_at' => $report->created_at?->toIso8601String(),
                'handled_at' => $report->handled_at?->toIso8601String(),
            ]);

        return Inertia::render('admin/reports', [
            'reports' => $reports,
            'open_count' => PlayerReport::query()->unresolved()->count(),
        ]);
    }

    public function update(ResolveReportRequest $request, PlayerReport $report): JsonResponse
    {
        $validated = $request->validated();
        $status = ReportStatus::from($validated['status']);

        $report->update([
            'status' => $status,
            'resolution' => $validated['resolution'] ?? $report->resolution,
            'handled_by' => $request->user()->id,
            /** Reopening clears the stamp: it is no longer a handled report. */
            'handled_at' => in_array($status, [ReportStatus::Resolved, ReportStatus::Rejected], true)
                ? now()
                : null,
        ]);

        $this->auditLogger->log(
            actor: $request->user()->name ?? 'admin',
            action: 'report.'.$status->value,
            target: $report->subject,
            details: ['report_id' => $report->id, 'accused' => $report->accused],
            ip: $request->ip(),
        );

        return response()->json(['message' => 'Report updated', 'report' => $report->fresh()]);
    }
}
