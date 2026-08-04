<?php

namespace App\Http\Controllers;

use App\Enums\ReportStatus;
use App\Http\Requests\StorePlayerReportRequest;
use App\Models\PlayerReport;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Players reporting other players, and asking the team for help.
 *
 * A player only ever sees their own submissions — a report names someone, and
 * publishing that would make the feature a harassment tool.
 */
class PlayerReportController extends Controller
{
    public function index(Request $request): Response
    {
        $reports = PlayerReport::query()
            ->where('user_id', $request->user()->id)
            ->latest()
            ->limit(50)
            ->get()
            ->map(fn (PlayerReport $report) => [
                'id' => $report->id,
                'kind' => $report->kind->value,
                'subject' => $report->subject,
                'body' => $report->body,
                'accused' => $report->accused,
                'status' => $report->status->value,
                'resolution' => $report->resolution,
                'created_at' => $report->created_at?->toIso8601String(),
                'handled_at' => $report->handled_at?->toIso8601String(),
            ]);

        return Inertia::render('portal/reports', [
            'reports' => $reports,
        ]);
    }

    public function store(StorePlayerReportRequest $request): JsonResponse
    {
        $validated = $request->validated();

        $report = PlayerReport::query()->create([
            ...$validated,
            'user_id' => $request->user()->id,
            'status' => ReportStatus::Open,
        ]);

        return response()->json([
            'message' => 'Report submitted',
            'report' => $report,
        ], 201);
    }
}
