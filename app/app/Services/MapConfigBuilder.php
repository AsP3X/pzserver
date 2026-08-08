<?php

namespace App\Services;

class MapConfigBuilder
{
    public function __construct(
        private readonly MapTileStore $tileStore = new MapTileStore,
        private readonly MapTileProgress $progress = new MapTileProgress,
    ) {}

    /**
     * Build map configuration.
     *
     * Preference (when basemap=auto):
     *   1. Vector worldmap (default — no tile generation)
     *   2. Local packed/loose isometric tiles
     *   3. Public proxy tiles
     *
     * Force with config zomboid.map.basemap = vector|local|proxy|auto
     *
     * @return array<string, mixed>
     */
    public function build(): array
    {
        $mode = strtolower((string) config('zomboid.map.basemap', 'auto'));
        $tilesPath = $this->tileStore->rootPath();

        if ($mode === 'vector') {
            $vector = $this->vectorConfig();
            if ($vector !== null) {
                return $vector;
            }

            return $this->emptyConfig($tilesPath);
        }

        if ($mode === 'local') {
            $local = $this->localTileConfig();
            if ($local !== null) {
                return $local;
            }

            return $this->emptyConfig($tilesPath);
        }

        if ($mode === 'proxy') {
            return $this->proxyConfig();
        }

        // auto: vector → local → proxy
        $vector = $this->vectorConfig();
        if ($vector !== null) {
            return $vector;
        }

        $local = $this->localTileConfig();
        if ($local !== null) {
            return $local;
        }

        return $this->proxyConfig();
    }

    /**
     * Dual basemap modes for the map UI toggle.
     *
     * - vector: schematic worldmap (efficient, default)
     * - isometric: game-like 3D/iso tiles — local pack when ready, else live CDN proxy
     *   so the site always has something to render without waiting on generation
     *
     * @return array{
     *     default: string,
     *     vector: array<string, mixed>|null,
     *     isometric: array<string, mixed>,
     *     isometric_local_ready: bool,
     *     isometric_generating: bool
     * }
     */
    public function buildModes(): array
    {
        $vector = $this->vectorConfig();
        $local = $this->localTileConfig();
        $proxy = $this->proxyConfig();
        $isometric = $local ?? $proxy;
        $generating = $this->progress->isRunning();

        $default = 'vector';
        $forced = strtolower((string) config('zomboid.map.basemap', 'auto'));
        if (in_array($forced, ['local', 'proxy'], true)) {
            $default = 'isometric';
        } elseif ($forced === 'vector' || ($vector !== null && $vector['hasBasemap'])) {
            $default = 'vector';
        } elseif ($isometric['hasBasemap'] ?? false) {
            $default = 'isometric';
        }

        return [
            'default' => $default,
            'vector' => $vector,
            'isometric' => $isometric,
            'isometric_local_ready' => $local !== null,
            'isometric_generating' => $generating,
        ];
    }

    /**
     * Whether a usable basemap exists (vector, local tiles, or proxy URL).
     */
    public function hasBasemap(): bool
    {
        return (bool) ($this->build()['hasBasemap'] ?? false);
    }

    /**
     * Whether a usable local tile set exists on disk (packed or legacy loose).
     */
    public function hasLocalTiles(): bool
    {
        return $this->localTilesUsable();
    }

    /**
     * Whether the vector basemap asset is present and readable.
     */
    public function hasVectorBasemap(): bool
    {
        return $this->vectorAssetPath() !== null;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function vectorConfig(): ?array
    {
        $path = $this->vectorAssetPath();
        if ($path === null) {
            return null;
        }

        $meta = $this->readVectorMeta($path);
        $bounds = $meta['bounds'] ?? null;
        $url = (string) config('zomboid.map.vector_url', '/map-vector/data');

        return [
            'tileUrl' => null,
            'tileSize' => (int) config('zomboid.map.tile_size', 256),
            'minZoom' => (float) config('zomboid.map.vector_min_zoom', -4),
            'maxZoom' => (float) config('zomboid.map.vector_max_zoom', 4),
            // Slightly closer than whole-map overview so towns are readable by default
            'defaultZoom' => (float) config('zomboid.map.vector_default_zoom', -1.25),
            'center' => [
                'x' => config('zomboid.map.center_x'),
                'y' => config('zomboid.map.center_y'),
            ],
            'dzi' => null,
            'source' => 'vector',
            'sourceTag' => $meta['source'] ?? null,
            'maps' => $meta['maps'] ?? null,
            'local_ready' => false,
            'tiles_path' => $this->tileStore->rootPath(),
            'vectorUrl' => $url,
            'bounds' => $bounds,
            'hasBasemap' => true,
        ];
    }

    /**
     * @return array<string, mixed>|null
     */
    private function localTileConfig(): ?array
    {
        if (! $this->localTilesUsable()) {
            return null;
        }

        $localDzi = $this->tileStore->getDziConfig();
        if ($localDzi === null) {
            return null;
        }

        return [
            'tileUrl' => '/map-tiles/{z}/{x}_{y}',
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
            'sourceTag' => null,
            'maps' => null,
            'local_ready' => true,
            'tiles_path' => $this->tileStore->rootPath(),
            'vectorUrl' => null,
            'bounds' => null,
            'hasBasemap' => true,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function proxyConfig(): array
    {
        $proxyDzi = config('zomboid.map.proxy_dzi');
        $w = (int) $proxyDzi['width'];
        $h = (int) $proxyDzi['height'];
        $sqr = (int) $proxyDzi['sqr'];
        $maxNativeZoom = (int) ceil(log(max($w, $h), 2));
        $tileUrl = config('zomboid.map.proxy_url');

        return [
            'tileUrl' => $tileUrl,
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
            'sourceTag' => null,
            'maps' => null,
            'local_ready' => false,
            'tiles_path' => $this->tileStore->rootPath(),
            'vectorUrl' => null,
            'bounds' => null,
            'hasBasemap' => $tileUrl !== null && $tileUrl !== '',
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function emptyConfig(string $tilesPath): array
    {
        return [
            'tileUrl' => null,
            'tileSize' => (int) config('zomboid.map.tile_size', 256),
            'minZoom' => (float) config('zomboid.map.vector_min_zoom', -4),
            'maxZoom' => (float) config('zomboid.map.vector_max_zoom', 4),
            'defaultZoom' => (float) config('zomboid.map.vector_default_zoom', -1.5),
            'center' => [
                'x' => config('zomboid.map.center_x'),
                'y' => config('zomboid.map.center_y'),
            ],
            'dzi' => null,
            'source' => 'none',
            'sourceTag' => null,
            'maps' => null,
            'local_ready' => false,
            'tiles_path' => $tilesPath,
            'vectorUrl' => null,
            'bounds' => null,
            'hasBasemap' => false,
        ];
    }

    private function vectorAssetPath(): ?string
    {
        $configured = config('zomboid.map.vector_path');

        // Explicit path: use only that file (do not silently fall back).
        if (is_string($configured) && $configured !== '') {
            return is_file($configured) && is_readable($configured) ? $configured : null;
        }

        // Prefer runtime storage bake (www-data writable), then packaged public seed.
        $candidates = [
            storage_path('app/map-vector/vanilla/map.json'),
            public_path('map-vector/vanilla/map.json'),
            base_path('public/map-vector/vanilla/map.json'),
        ];

        foreach ($candidates as $path) {
            if (is_file($path) && is_readable($path)) {
                return $path;
            }
        }

        return null;
    }

    /**
     * @return array{
     *     bounds?: array{0: int, 1: int, 2: int, 3: int},
     *     source?: string,
     *     maps?: list<array{name: string, origin: string}>
     * }
     */
    private function readVectorMeta(string $path): array
    {
        // Header is small (source, maps, bounds) before the large "cells" payload.
        $fh = fopen($path, 'rb');
        if ($fh === false) {
            return [];
        }

        $chunk = fread($fh, 65536) ?: '';
        fclose($fh);

        $meta = [];

        if (preg_match('/"bounds"\s*:\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/', $chunk, $m)) {
            $meta['bounds'] = [(int) $m[1], (int) $m[2], (int) $m[3], (int) $m[4]];
        }

        if (preg_match('/"source"\s*:\s*"([^"]+)"/', $chunk, $m)) {
            $meta['source'] = $m[1];
        }

        // "maps":[{"name":"…","origin":"…"},…]
        if (preg_match('/"maps"\s*:\s*(\[[^\]]*\])/', $chunk, $m)) {
            try {
                /** @var list<array{name?: string, origin?: string}>|null $maps */
                $maps = json_decode($m[1], true, 16, JSON_THROW_ON_ERROR);
                if (is_array($maps)) {
                    $meta['maps'] = array_values(array_filter(array_map(
                        static function (array $row): ?array {
                            $name = isset($row['name']) ? (string) $row['name'] : '';
                            if ($name === '') {
                                return null;
                            }

                            return [
                                'name' => $name,
                                'origin' => isset($row['origin']) ? (string) $row['origin'] : '',
                            ];
                        },
                        $maps,
                    )));
                }
            } catch (\JsonException) {
                // ignore malformed header fragment
            }
        }

        return $meta;
    }

    /**
     * Whether local tiles are complete enough to serve as the basemap.
     *
     * A packed tiles.sqlite always is. A loose pyramid only counts when no
     * render is in flight: pzmap2dzi builds bottom-up, so mid-render the zoom
     * levels the map actually requests are still empty and switching away from
     * the proxy would blank the map for hours.
     */
    private function localTilesUsable(): bool
    {
        if ($this->tileStore->hasPackedTiles()) {
            return true;
        }

        return $this->tileStore->hasLooseTiles() && ! $this->progress->isRunning();
    }
}
