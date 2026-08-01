<?php

namespace App\Services;

class MapConfigBuilder
{
    /**
     * Build map configuration, preferring local tiles then falling back to proxy.
     *
     * @return array{tileUrl: string|null, tileSize: int, minZoom: int, maxZoom: int, defaultZoom: int, center: array{x: int, y: int}, dzi: array|null}
     */
    public function build(): array
    {
        $localDzi = $this->getLocalDziConfig();

        if ($localDzi) {
            return [
                'tileUrl' => url('/admin/map-tiles/{z}/{x}_{y}'),
                'tileSize' => config('zomboid.map.tile_size'),
                'minZoom' => config('zomboid.map.min_zoom'),
                'maxZoom' => config('zomboid.map.max_zoom'),
                'defaultZoom' => config('zomboid.map.default_zoom'),
                'center' => [
                    'x' => config('zomboid.map.center_x'),
                    'y' => config('zomboid.map.center_y'),
                ],
                'dzi' => $localDzi,
            ];
        }

        // Fall back to proxy tiles from map.projectzomboid.com
        $proxyDzi = config('zomboid.map.proxy_dzi');
        $w = $proxyDzi['width'];
        $h = $proxyDzi['height'];
        $sqr = $proxyDzi['sqr'];
        $maxNativeZoom = (int) ceil(log(max($w, $h), 2));

        return [
            'tileUrl' => config('zomboid.map.proxy_url'),
            'tileSize' => config('zomboid.map.proxy_tile_size'),
            'minZoom' => config('zomboid.map.min_zoom'),
            'maxZoom' => config('zomboid.map.max_zoom'),
            'defaultZoom' => config('zomboid.map.default_zoom'),
            'center' => [
                'x' => config('zomboid.map.center_x'),
                'y' => config('zomboid.map.center_y'),
            ],
            'dzi' => [
                'width' => $w,
                'height' => $h,
                'x0' => $proxyDzi['x0'],
                'y0' => $proxyDzi['y0'],
                'sqr' => $sqr,
                'maxNativeZoom' => $maxNativeZoom,
                'isometric' => true,
            ],
        ];
    }

    /**
     * Get DZI config from locally generated tiles, or null if not available.
     *
     * @return array{width: int, height: int, x0: int, y0: int, sqr: int, maxNativeZoom: int, isometric: bool}|null
     */
    private function getLocalDziConfig(): ?array
    {
        $dziPath = config('zomboid.map.tiles_path').'/html/map_data/base/layer0_files';

        if (! is_dir($dziPath.'/0')) {
            return null;
        }

        $webp = glob($dziPath.'/0/*.webp');
        $jpg = glob($dziPath.'/0/*.jpg');

        if (empty($webp) && empty($jpg)) {
            return null;
        }

        $infoPath = config('zomboid.map.tiles_path').'/html/map_data/base/map_info.json';

        if (! is_file($infoPath)) {
            return null;
        }

        $mapInfo = json_decode(file_get_contents($infoPath), true);

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
