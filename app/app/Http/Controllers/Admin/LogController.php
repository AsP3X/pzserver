<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Services\DockerManager;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

class LogController extends Controller
{
    public function __construct(
        private readonly DockerManager $docker,
    ) {}

    public function index(): Response
    {
        $lines = [];

        try {
            $lines = $this->docker->getContainerLogs(100);
        } catch (\Throwable) {
            // Container not available
        }

        return Inertia::render('admin/logs', [
            'lines' => $lines,
        ]);
    }

    public function fetch(Request $request): JsonResponse
    {
        $tail = min((int) $request->query('tail', 100), 500);

        try {
            $lines = $this->docker->getContainerLogs($tail);
        } catch (\Throwable $e) {
            return response()->json([
                'error' => 'Failed to fetch logs: '.$e->getMessage(),
                'lines' => [],
            ], 503);
        }

        return response()->json([
            'lines' => $lines,
            'count' => count($lines),
        ]);
    }
}
