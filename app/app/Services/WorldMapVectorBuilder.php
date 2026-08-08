<?php

namespace App\Services;

use InvalidArgumentException;
use RuntimeException;
use XMLReader;

/**
 * Build a compact, cell-indexed vector basemap from vanilla (or mod) worldmap.xml.
 *
 * Coordinates are absolute world squares: cellX * cellSize + localX.
 * Output is consumed by the Leaflet Canvas basemap (no tile generation).
 */
class WorldMapVectorBuilder
{
    public const FORMAT_VERSION = 1;

    public const DEFAULT_CELL_SIZE = 300;

    /** @var array<string, array{fill: string, minZ: float, order: int}> */
    public const LAYER_STYLES = [
        'water' => ['fill' => '#3b8d95', 'minZ' => -99.0, 'order' => 10],
        'road-trail' => ['fill' => '#b97a57', 'minZ' => 0.0, 'order' => 20],
        'road-tertiary' => ['fill' => '#ab9e8f', 'minZ' => -1.0, 'order' => 21],
        'road-secondary' => ['fill' => '#867d71', 'minZ' => -3.0, 'order' => 22],
        'road-primary' => ['fill' => '#867d71', 'minZ' => -3.0, 'order' => 23],
        'railway' => ['fill' => '#c8bfe7', 'minZ' => 1.0, 'order' => 24],
        'building' => ['fill' => '#d29e69', 'minZ' => 0.0, 'order' => 30],
        'building-Residential' => ['fill' => '#d29e69', 'minZ' => 0.0, 'order' => 31],
        'building-CommunityServices' => ['fill' => '#8b75eb', 'minZ' => 0.0, 'order' => 32],
        'building-Hospitality' => ['fill' => '#7fcee1', 'minZ' => 0.0, 'order' => 33],
        'building-Industrial' => ['fill' => '#383635', 'minZ' => 0.0, 'order' => 34],
        'building-Medical' => ['fill' => '#e58097', 'minZ' => 0.0, 'order' => 35],
        'building-RestaurantsAndEntertainment' => ['fill' => '#f5e13c', 'minZ' => 0.0, 'order' => 36],
        'building-RetailAndCommercial' => ['fill' => '#b8cd54', 'minZ' => 0.0, 'order' => 37],
        'natural-wood' => ['fill' => '#bdc5a3', 'minZ' => -2.0, 'order' => 5],
    ];

    /**
     * @param  array<string, string>  $labelTranslations  MapLabel_* key → display text
     * @return array{
     *     v: int,
     *     source: string,
     *     cellSize: int,
     *     bounds: array{0: int, 1: int, 2: int, 3: int},
     *     bg: array{0: int, 1: int, 2: int},
     *     styles: array<string, array{fill: string, minZ: float, order: int}>,
     *     cells: array<string, list<array{0: string, 1: list<int>}>>,
     *     labels: list<array{t: string, x: float, y: float, k: string, s: float}>,
     *     stats: array{features: int, cells: int, points: int, labels: int}
     * }
     */
    public function buildFromFiles(
        string $worldmapXmlPath,
        ?string $annotationsLuaPath = null,
        ?string $mapLabelJsonPath = null,
        string $source = 'vanilla',
        int $cellSize = self::DEFAULT_CELL_SIZE,
    ): array {
        if (! is_file($worldmapXmlPath)) {
            throw new InvalidArgumentException("worldmap.xml not found: {$worldmapXmlPath}");
        }

        $translations = $this->loadLabelTranslations($mapLabelJsonPath);
        $geometry = $this->parseWorldmapXml($worldmapXmlPath, $cellSize);
        $labels = $this->parseAnnotations($annotationsLuaPath, $translations);

        // Town labels from worldmap place features (name_en)
        foreach ($geometry['place_labels'] as $label) {
            $labels[] = $label;
        }

        $labels = $this->dedupeLabels($labels);

        return [
            'v' => self::FORMAT_VERSION,
            'source' => $source,
            'cellSize' => $cellSize,
            'bounds' => $geometry['bounds'],
            'bg' => [219, 215, 192],
            'styles' => self::LAYER_STYLES,
            'cells' => $geometry['cells'],
            'labels' => $labels,
            'stats' => [
                'features' => $geometry['feature_count'],
                'cells' => count($geometry['cells']),
                'points' => $geometry['point_count'],
                'labels' => count($labels),
            ],
        ];
    }

    /**
     * @param  array<string, mixed>  $data
     */
    public function writeJson(array $data, string $outputPath, bool $pretty = false): void
    {
        $dir = dirname($outputPath);
        if (! is_dir($dir) && ! mkdir($dir, 0755, true) && ! is_dir($dir)) {
            throw new RuntimeException("Failed to create directory: {$dir}");
        }

        // Drop stats from the public asset (keep build-time metadata out of the client payload)
        $payload = $data;
        unset($payload['stats']);

        $json = json_encode(
            $payload,
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | ($pretty ? JSON_PRETTY_PRINT : 0),
        );

        if (file_put_contents($outputPath, $json) === false) {
            throw new RuntimeException("Failed to write: {$outputPath}");
        }
    }

    /**
     * @return array{
     *     cells: array<string, list<array{0: string, 1: list<int>}>>,
     *     bounds: array{0: int, 1: int, 2: int, 3: int},
     *     feature_count: int,
     *     point_count: int,
     *     place_labels: list<array{t: string, x: float, y: float, k: string, s: float}>
     * }
     */
    public function parseWorldmapXml(string $path, int $cellSize = self::DEFAULT_CELL_SIZE): array
    {
        $reader = new XMLReader;
        if (! $reader->open($path, null, LIBXML_NONET | LIBXML_COMPACT)) {
            throw new RuntimeException("Failed to open XML: {$path}");
        }

        /** @var array<string, list<array{0: string, 1: list<int>}>> $cells */
        $cells = [];
        $featureCount = 0;
        $pointCount = 0;
        $minX = PHP_INT_MAX;
        $minY = PHP_INT_MAX;
        $maxX = PHP_INT_MIN;
        $maxY = PHP_INT_MIN;
        /** @var list<array{t: string, x: float, y: float, k: string, s: float}> $placeLabels */
        $placeLabels = [];

        while ($reader->read()) {
            if ($reader->nodeType !== XMLReader::ELEMENT || $reader->localName !== 'cell') {
                continue;
            }

            $cellX = (int) $reader->getAttribute('x');
            $cellY = (int) $reader->getAttribute('y');
            $cellKey = $cellX.','.$cellY;
            $baseX = $cellX * $cellSize;
            $baseY = $cellY * $cellSize;

            $cellXml = $reader->readOuterXml();
            if ($cellXml === '') {
                continue;
            }

            $cell = @simplexml_load_string($cellXml);
            if ($cell === false) {
                continue;
            }

            foreach ($cell->feature as $feature) {
                $props = [];
                if (isset($feature->properties->property)) {
                    foreach ($feature->properties->property as $prop) {
                        $name = (string) $prop['name'];
                        $value = (string) $prop['value'];
                        $props[$name] = $value;
                    }
                }

                $layer = $this->resolveLayer($props);
                if ($layer === null) {
                    // Still collect town place labels even if not drawn as geometry
                    if (($props['place'] ?? null) === 'town' && isset($props['name_en'])) {
                        $centroid = $this->featureCentroid($feature, $baseX, $baseY);
                        if ($centroid !== null) {
                            $placeLabels[] = [
                                't' => mb_strtoupper($props['name_en']),
                                'x' => $centroid[0],
                                'y' => $centroid[1],
                                'k' => 'town',
                                's' => 2.0,
                            ];
                        }
                    }

                    continue;
                }

                $ring = $this->featureRing($feature, $baseX, $baseY);
                if ($ring === null || count($ring) < 6) {
                    continue;
                }

                for ($i = 0, $n = count($ring); $i < $n; $i += 2) {
                    $x = $ring[$i];
                    $y = $ring[$i + 1];
                    $minX = min($minX, $x);
                    $maxX = max($maxX, $x);
                    $minY = min($minY, $y);
                    $maxY = max($maxY, $y);
                }

                $pointCount += intdiv(count($ring), 2);
                $cells[$cellKey][] = [$layer, $ring];
                $featureCount++;

                if (($props['place'] ?? null) === 'town' && isset($props['name_en'])) {
                    $centroid = $this->ringCentroid($ring);
                    $placeLabels[] = [
                        't' => mb_strtoupper($props['name_en']),
                        'x' => $centroid[0],
                        'y' => $centroid[1],
                        'k' => 'town',
                        's' => 2.0,
                    ];
                }
            }
        }

        $reader->close();

        if ($featureCount === 0) {
            throw new RuntimeException("No drawable features found in {$path}");
        }

        ksort($cells, SORT_NATURAL);

        return [
            'cells' => $cells,
            'bounds' => [$minX, $minY, $maxX, $maxY],
            'feature_count' => $featureCount,
            'point_count' => $pointCount,
            'place_labels' => $placeLabels,
        ];
    }

    /**
     * @param  array<string, string>  $translations
     * @return list<array{t: string, x: float, y: float, k: string, s: float}>
     */
    public function parseAnnotations(?string $path, array $translations = []): array
    {
        if ($path === null || ! is_file($path)) {
            return [];
        }

        $text = file_get_contents($path);
        if ($text === false) {
            return [];
        }

        /** @var list<array{t: string, x: float, y: float, k: string, s: float}> $labels */
        $labels = [];

        // symbol = symbolsAPI:addUntranslatedText("MapLabel_SaltRiver", "text-water-nofade", 12511, 6734)
        if (preg_match_all(
            '/addUntranslatedText\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/',
            $text,
            $matches,
            PREG_SET_ORDER,
        ) === false) {
            return [];
        }

        // Capture scale from following setScale when present
        $scaleByPos = [];
        if (preg_match_all(
            '/addUntranslatedText\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)\s*(?:.*?setScale\(([-\d.]+)\))?/s',
            $text,
            $scaleMatches,
            PREG_SET_ORDER,
        )) {
            foreach ($scaleMatches as $m) {
                $key = $m[3].','.$m[4].','.$m[1];
                $scaleByPos[$key] = isset($m[5]) ? (float) $m[5] : 1.0;
            }
        }

        foreach ($matches as $m) {
            $key = $m[1];
            $layer = $m[2];
            $x = (float) $m[3];
            $y = (float) $m[4];
            $display = $translations[$key] ?? $this->humanizeLabelKey($key);
            $kind = $this->labelKind($layer);
            $scaleKey = $m[3].','.$m[4].','.$key;
            $scale = $scaleByPos[$scaleKey] ?? 1.0;

            $labels[] = [
                't' => $display,
                'x' => $x,
                'y' => $y,
                'k' => $kind,
                's' => $scale,
            ];
        }

        return $labels;
    }

    /**
     * @return array<string, string>
     */
    public function loadLabelTranslations(?string $path): array
    {
        if ($path === null || ! is_file($path)) {
            return [];
        }

        $raw = file_get_contents($path);
        if ($raw === false) {
            return [];
        }

        try {
            /** @var array<string, string> $data */
            $data = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return [];
        }

        return $data;
    }

    /**
     * @param  array<string, string>  $props
     */
    public function resolveLayer(array $props): ?string
    {
        if (isset($props['water'])) {
            return 'water';
        }

        if (isset($props['highway'])) {
            return match ($props['highway']) {
                'primary' => 'road-primary',
                'secondary' => 'road-secondary',
                'tertiary' => 'road-tertiary',
                'trail' => 'road-trail',
                default => 'road-secondary',
            };
        }

        if (isset($props['railway'])) {
            return 'railway';
        }

        if (isset($props['building'])) {
            $building = $props['building'];
            if ($building === 'yes' || $building === '') {
                return 'building';
            }

            $key = 'building-'.$building;
            if (isset(self::LAYER_STYLES[$key])) {
                return $key;
            }

            return 'building';
        }

        if (($props['natural'] ?? null) === 'wood' || ($props['natural'] ?? null) === 'forest') {
            return 'natural-wood';
        }

        return null;
    }

    /**
     * @return list<int>|null flat [x,y,x,y,...] absolute integers
     */
    private function featureRing(\SimpleXMLElement $feature, int $baseX, int $baseY): ?array
    {
        if (! isset($feature->geometry->coordinates->point)) {
            return null;
        }

        $ring = [];
        foreach ($feature->geometry->coordinates->point as $point) {
            $ring[] = $baseX + (int) round((float) $point['x']);
            $ring[] = $baseY + (int) round((float) $point['y']);
        }

        // Drop closing duplicate if present (canvas closePath handles it)
        $n = count($ring);
        if ($n >= 8 && $ring[0] === $ring[$n - 2] && $ring[1] === $ring[$n - 1]) {
            array_pop($ring);
            array_pop($ring);
        }

        return $ring;
    }

    /**
     * @return array{0: float, 1: float}|null
     */
    private function featureCentroid(\SimpleXMLElement $feature, int $baseX, int $baseY): ?array
    {
        $ring = $this->featureRing($feature, $baseX, $baseY);
        if ($ring === null || count($ring) < 2) {
            return null;
        }

        return $this->ringCentroid($ring);
    }

    /**
     * @param  list<int>  $ring
     * @return array{0: float, 1: float}
     */
    private function ringCentroid(array $ring): array
    {
        $sx = 0.0;
        $sy = 0.0;
        $n = intdiv(count($ring), 2);
        for ($i = 0; $i < $n; $i++) {
            $sx += $ring[$i * 2];
            $sy += $ring[$i * 2 + 1];
        }

        return [$sx / max(1, $n), $sy / max(1, $n)];
    }

    private function labelKind(string $layer): string
    {
        return match (true) {
            str_contains($layer, 'town') => 'town',
            str_contains($layer, 'water') => 'water',
            str_contains($layer, 'forest') => 'forest',
            str_contains($layer, 'building') => 'building',
            str_contains($layer, 'place') => 'place',
            default => 'place',
        };
    }

    private function humanizeLabelKey(string $key): string
    {
        $key = preg_replace('/^MapLabel_/', '', $key) ?? $key;

        return strtoupper(preg_replace('/([a-z])([A-Z])/', '$1 $2', $key) ?? $key);
    }

    /**
     * @param  list<array{t: string, x: float, y: float, k: string, s: float}>  $labels
     * @return list<array{t: string, x: float, y: float, k: string, s: float}>
     */
    private function dedupeLabels(array $labels): array
    {
        $seen = [];
        $out = [];
        foreach ($labels as $label) {
            $key = $label['t'].'|'.round($label['x']).'|'.round($label['y']).'|'.$label['k'];
            if (isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            $out[] = $label;
        }

        return $out;
    }
}
