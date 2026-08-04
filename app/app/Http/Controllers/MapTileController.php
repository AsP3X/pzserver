<?php

namespace App\Http\Controllers;

use App\Services\MapTileStore;
use Illuminate\Http\Response;

/**
 * Serves basemap tiles to any signed-in user.
 *
 * The basemap is the same public map anyone can browse on
 * map.projectzomboid.com, so it carries nothing worth gating behind the admin
 * role — and gating it broke every player-facing map the moment a server
 * switched from proxy tiles to locally generated ones.
 */
class MapTileController extends Controller
{
    /** 1x1 transparent PNG, so Leaflet renders a gap instead of a broken image. */
    private const BLANK_TILE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    public function __construct(private readonly MapTileStore $tileStore) {}

    public function __invoke(string $level, string $tile): Response
    {
        $result = $this->tileStore->getTile($level, $tile);

        if ($result === null) {
            return response(base64_decode(self::BLANK_TILE), 200, [
                'Content-Type' => 'image/png',
                'Cache-Control' => 'public, max-age=86400',
            ]);
        }

        return response($result['data'], 200, [
            'Cache-Control' => 'public, max-age=86400',
            'Content-Type' => $result['content_type'],
        ]);
    }
}
