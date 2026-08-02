<?php

namespace App\Services;

class MapConfigBuilder
{
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
        $tilesPath = (string) config('zomboid.map.tiles_path');
        $localDzi = $this->getLocalDziConfig();

        if ($localDzi) {
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
     * Whether a usable local tile set exists on disk.
     */
    public function hasLocalTiles(): bool
    {
        return $this->getLocalDziConfig() !== null;
    }

    /**
     * Get DZI config from locally generated tiles, or null if not available.
     *
     * @return array{width: int, height: int, x0: int, y0: int, sqr: int, maxNativeZoom: int, isometric: bool}|null
     */
    private function getLocalDziConfig(): ?array
    {
        $base = rtrim((string) config('zomboid.map.tiles_path'), '/');
        $dziPath = $base.'/html/map_data/base/layer0_files';

        // Accept either level 0 or common omit_levels layout (level folders present)
        $levelDir = null;
        foreach (['0', '1', '2', '3'] as $level) {
            if (is_dir($dziPath.'/'.$level)) {
                $levelDir = $dziPath.'/'.$level;
                break;
            }
        }

        if ($levelDir === null) {
            return null;
        }

        $webp = glob($levelDir.'/*.webp') ?: [];
        $jpg = glob($levelDir.'/*.jpg') ?: [];

        if ($webp === [] && $jpg === []) {
            return null;
        }

        $infoPath = $base.'/html/map_data/base/map_info.json';

        if (! is_file($infoPath)) {
            // Minimal defaults so a partial render can still show tiles
            return [
                'width' => 65536,
                'height' => 65536,
                'x0' => 0,
                'y0' => 0,
                'sqr' => 1,
                'maxNativeZoom' => 16,
                'isometric' => false,
            ];
        }

        $mapInfo = json_decode((string) file_get_contents($infoPath), true);
        if (! is_array($mapInfo) || ! isset($mapInfo['w'], $mapInfo['h'])) {
            return null;
        }

        $w = (int) $mapInfo['w'];
        $h = (int) $mapInfo['h'];
        $sqr = (int) ($mapInfo['sqr'] ?? 1);

        return [
            'width' => $w,
            'height' => $h,
            'x0' => (int) ($mapInfo['x0'] ?? 0),
            'y0' => (int) ($mapInfo['y0'] ?? 0),
            'sqr' => $sqr,
            'maxNativeZoom' => (int) ceil(log(max($w, $h), 2)),
            'isometric' => $sqr > 2,
        ];
    }
}
