<?php

namespace App\Console\Commands;

use App\Services\WorldMapSourceLocator;
use App\Services\WorldMapVectorBuilder;
use Illuminate\Console\Command;

class BuildWorldMapVector extends Command
{
    protected $signature = 'zomboid:build-worldmap-vector
        {--xml= : Single worldmap.xml path (skips Map= discovery)}
        {--annotations= : Path to worldmap-annotations.lua (with --xml)}
        {--labels= : Path to Translate/EN/MapLabel.json (with --xml)}
        {--output= : Output JSON path (default: public/map-vector/vanilla/map.json)}
        {--source= : Source tag written into the asset (default: auto)}
        {--ini= : server.ini path for Map= discovery (default: config zomboid.paths.server_ini)}
        {--server-path= : Dedicated server install root (default: config zomboid.game_server_path)}
        {--scan-workshop : Also include workshop maps that have worldmap.xml but are not on Map=}
        {--list-only : Print discovered map sources and exit without baking}
        {--pretty : Pretty-print JSON}';

    protected $description = 'Bake a compact vector basemap from vanilla + Map= / workshop worldmap.xml packs';

    public function handle(WorldMapVectorBuilder $builder, WorldMapSourceLocator $locator): int
    {
        $output = $this->option('output')
            ?: storage_path('app/map-vector/vanilla/map.json');

        $sources = $this->resolveSources($locator);
        if ($sources === []) {
            $this->error('No worldmap.xml sources found. Pass --xml=... or ensure Map= folders exist under the game install / Workshop.');

            return self::FAILURE;
        }

        $this->table(
            ['Map folder', 'Origin', 'worldmap.xml'],
            array_map(static fn (array $s): array => [
                $s['name'],
                $s['origin'],
                $s['xml'],
            ], $sources),
        );

        if ($this->option('list-only')) {
            return self::SUCCESS;
        }

        $sourceTag = $this->option('source') ?: 'merged';

        try {
            $data = $builder->buildFromSources($sources, (string) $sourceTag);
        } catch (\Throwable $e) {
            $this->error($e->getMessage());

            return self::FAILURE;
        }

        $builder->writeJson($data, $output, (bool) $this->option('pretty'));

        $stats = $data['stats'];
        $size = is_file($output) ? filesize($output) : 0;
        $this->info("Wrote {$output} (".number_format($size).' bytes)');
        $this->table(
            ['Metric', 'Value'],
            [
                ['Sources', (string) ($stats['sources'] ?? count($sources))],
                ['Features', (string) $stats['features']],
                ['Cells', (string) $stats['cells']],
                ['Points', (string) $stats['points']],
                ['Labels', (string) $stats['labels']],
                ['Bounds', implode(', ', $data['bounds'])],
                ['Source tag', (string) $data['source']],
            ],
        );

        return self::SUCCESS;
    }

    /**
     * @return list<array{name: string, xml: string, annotations: string|null, labels: string|null, origin: string}>
     */
    private function resolveSources(WorldMapSourceLocator $locator): array
    {
        $xml = $this->option('xml');
        if (is_string($xml) && $xml !== '') {
            if (! is_file($xml)) {
                $this->error("File not found: {$xml}");

                return [];
            }

            $annotations = $this->option('annotations')
                ?: $this->sibling($xml, 'worldmap-annotations.lua');
            $labels = $this->option('labels')
                ?: $this->discoverMapLabels($xml);

            return [[
                'name' => basename(dirname($xml)),
                'xml' => $xml,
                'annotations' => is_string($annotations) && is_file($annotations) ? $annotations : null,
                'labels' => is_string($labels) && is_file($labels) ? $labels : null,
                'origin' => 'cli-xml',
            ]];
        }

        $ini = $this->option('ini') ?: null;
        $serverPath = $this->option('server-path') ?: null;

        $sources = $locator->locateForServer(
            iniPath: is_string($ini) ? $ini : null,
            serverPath: is_string($serverPath) ? $serverPath : null,
            includeOrphanWorkshopMaps: (bool) $this->option('scan-workshop'),
        );

        // Fall back to single vanilla discovery when Map= resolution finds nothing
        // (e.g. fresh host without /pz-server mounted).
        if ($sources === []) {
            $fallback = $this->discoverWorldmapXml();
            if ($fallback !== null) {
                $annotations = $this->sibling($fallback, 'worldmap-annotations.lua');
                $labels = $this->discoverMapLabels($fallback);
                $sources[] = [
                    'name' => basename(dirname($fallback)),
                    'xml' => $fallback,
                    'annotations' => $annotations,
                    'labels' => $labels,
                    'origin' => 'fallback-discover',
                ];
            }
        }

        $missing = [];
        $iniPath = is_string($ini) && $ini !== '' ? $ini : (string) config('zomboid.paths.server_ini');
        foreach ($locator->mapFoldersFromIni($iniPath) as $folder) {
            $found = false;
            foreach ($sources as $source) {
                if ($source['name'] === $folder) {
                    $found = true;
                    break;
                }
            }
            if (! $found) {
                $missing[] = $folder;
            }
        }
        if ($missing !== []) {
            $this->warn('Map= folders without worldmap.xml (skipped): '.implode('; ', $missing));
        }

        return $sources;
    }

    private function discoverWorldmapXml(): ?string
    {
        $serverPath = rtrim((string) config('zomboid.game_server_path', '/pz-server'), '/');

        $candidates = array_filter([
            config('zomboid.map.worldmap_xml'),
            $serverPath.'/media/maps/Muldraugh, KY/worldmap.xml',
            '/home/steam/pz-dedicated/media/maps/Muldraugh, KY/worldmap.xml',
            '/opt/pzserver/media/maps/Muldraugh, KY/worldmap.xml',
            ($_SERVER['HOME'] ?? '').'/Library/Application Support/Steam/steamapps/common/ProjectZomboid/Project Zomboid.app/Contents/Java/media/maps/Muldraugh, KY/worldmap.xml',
            ($_SERVER['HOME'] ?? '').'/.steam/steam/steamapps/common/ProjectZomboid/media/maps/Muldraugh, KY/worldmap.xml',
            '/game-media/maps/Muldraugh, KY/worldmap.xml',
        ]);

        foreach ($candidates as $path) {
            if (is_string($path) && $path !== '' && is_file($path)) {
                return $path;
            }
        }

        return null;
    }

    private function discoverMapLabels(string $worldmapXml): ?string
    {
        $mapsDir = dirname($worldmapXml, 2);
        $mediaDir = dirname($mapsDir);
        $candidate = $mediaDir.'/lua/shared/Translate/EN/MapLabel.json';

        return is_file($candidate) ? $candidate : null;
    }

    private function sibling(string $path, string $name): ?string
    {
        $candidate = dirname($path).DIRECTORY_SEPARATOR.$name;

        return is_file($candidate) ? $candidate : null;
    }
}
