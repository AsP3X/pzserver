<?php

namespace App\Http\Controllers;

use App\Services\MapConfigBuilder;
use App\Services\WorldMapVectorBakeService;
use Symfony\Component\HttpFoundation\Response;

/**
 * Serve the vector basemap JSON from a writable runtime path (storage),
 * falling back to the packaged public/ copy.
 */
class MapVectorController extends Controller
{
    public function __invoke(
        WorldMapVectorBakeService $bake,
        MapConfigBuilder $mapConfig,
    ): Response {
        $path = $bake->resolveReadablePath();
        if ($path === null) {
            abort(404, 'Vector basemap not found. Run Rebuild vector basemap or zomboid:build-worldmap-vector.');
        }

        return response()->file($path, [
            'Content-Type' => 'application/json; charset=UTF-8',
            'Cache-Control' => 'public, max-age=60',
        ]);
    }
}
