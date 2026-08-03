<?php

namespace App\Services;

class MapConfigBuilder
{
    public function __construct(
        private readonly MapTileStore $tileStore = new MapTileStore,
    ) {}

    /**
     * Build map configuration, preferring local tiles then falling back to proxy.
     *
     * @return array{
     *     tileUrl: string|null,
     *     tileSize: int,
     *     minZoom: int,
     *     maxZoom: int,
     *     defaultZoom: int,
     *     center: array{x: float|int, y: float|int},
     *     dzi: array|null,
     *     source: string,
     *     local_ready: bool,
     *     tiles_path: string
     * }
     */
    public function build(): array
    {
        $tilesPath = $this->tileStore->rootPath();
        $localDzi = $this->tileStore->getDziConfig();
        $localReady = $this->tileStore->hasTiles();

        if ($localReady && $localDzi !== null) {
            // Relative URL so tiles work behind NPM/Caddy regardless of APP_URL.
            return [
                'tileUrl' => '/admin/map-tiles/{z}/{x}_{y}',
                'tileSize' => (int) config('zomboid.map.tile_size'),
                'minZoom' => (int) config('zomboid.map.min_zoom'),
                'maxZoom' => (int) config('zomboid.map.max_zoom'),
                'defaultZoom' => (int) config('zomboid.map.default_zoom'),
                'center' => [
                    'x' => config('zomboid.map.center_x'),
                    'y' => config('zomboid.map.center_y'),
                ],
                'dzi' => $localDzi,
                'source' => 'local',
                'local_ready' => true,
                'tiles_path' => $tilesPath,
            ];
        }

        // Fall back to proxy tiles from map.projectzomboid.com
        $proxyDzi = config('zomboid.map.proxy_dzi');
        $w = (int) $proxyDzi['width'];
        $h = (int) $proxyDzi['height'];
        $sqr = (int) $proxyDzi['sqr'];
        $maxNativeZoom = (int) ceil(log(max($w, $h), 2));

        return [
            'tileUrl' => config('zomboid.map.proxy_url'),
            'tileSize' => (int) config('zomboid.map.proxy_tile_size'),
            'minZoom' => (int) config('zomboid.map.min_zoom'),
            'maxZoom' => (int) config('zomboid.map.max_zoom'),
            'defaultZoom' => (int) config('zomboid.map.default_zoom'),
            'center' => [
                'x' => config('zomboid.map.center_x'),
                'y' => config('zomboid.map.center_y'),
            ],
            'dzi' => [
                'width' => $w,
                'height' => $h,
                'x0' => (int) $proxyDzi['x0'],
                'y0' => (int) $proxyDzi['y0'],
                'sqr' => $sqr,
                'maxNativeZoom' => $maxNativeZoom,
                'isometric' => true,
            ],
            'source' => 'proxy',
            'local_ready' => false,
            'tiles_path' => $tilesPath,
        ];
    }

    /**
     * Whether a usable local tile set exists on disk (packed or legacy loose).
     */
    public function hasLocalTiles(): bool
    {
        return $this->tileStore->hasTiles();
    }
}
