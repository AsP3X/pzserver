<?php

namespace App\Console\Commands;

use App\Services\WorldMapVectorBuilder;
use Illuminate\Console\Command;

class BuildWorldMapVector extends Command
{
    protected $signature = 'zomboid:build-worldmap-vector
        {--xml= : Path to worldmap.xml (defaults to config / common locations)}
        {--annotations= : Path to worldmap-annotations.lua}
        {--labels= : Path to Translate/EN/MapLabel.json}
        {--output= : Output JSON path (default: public/map-vector/vanilla/map.json)}
        {--source=vanilla : Source tag written into the asset}
        {--pretty : Pretty-print JSON}';

    protected $description = 'Bake a compact vector basemap from Project Zomboid worldmap.xml (no tile render)';

    public function handle(WorldMapVectorBuilder $builder): int
    {
        $xml = $this->option('xml') ?: $this->discoverWorldmapXml();
        if ($xml === null) {
            $this->error('Could not find worldmap.xml. Pass --xml=/path/to/worldmap.xml');

            return self::FAILURE;
        }

        $annotations = $this->option('annotations')
            ?: $this->sibling($xml, 'worldmap-annotations.lua');
        $labels = $this->option('labels')
            ?: $this->discoverMapLabels($xml);

        $output = $this->option('output')
            ?: public_path('map-vector/vanilla/map.json');

        $this->info("Reading: {$xml}");
        if ($annotations) {
            $this->line("Annotations: {$annotations}");
        }
        if ($labels) {
            $this->line("Labels: {$labels}");
        }

        try {
            $data = $builder->buildFromFiles(
                worldmapXmlPath: $xml,
                annotationsLuaPath: $annotations,
                mapLabelJsonPath: $labels,
                source: (string) $this->option('source'),
            );
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
                ['Features', (string) $stats['features']],
                ['Cells', (string) $stats['cells']],
                ['Points', (string) $stats['points']],
                ['Labels', (string) $stats['labels']],
                ['Bounds', implode(', ', $data['bounds'])],
            ],
        );

        return self::SUCCESS;
    }

    private function discoverWorldmapXml(): ?string
    {
        $candidates = array_filter([
            config('zomboid.map.worldmap_xml'),
            env('PZ_WORLDMAP_XML'),
            // Dedicated server common layouts
            '/home/steam/pz-dedicated/media/maps/Muldraugh, KY/worldmap.xml',
            '/opt/pzserver/media/maps/Muldraugh, KY/worldmap.xml',
            // Local macOS Steam install (dev hosts)
            $_SERVER['HOME'].'/Library/Application Support/Steam/steamapps/common/ProjectZomboid/Project Zomboid.app/Contents/Java/media/maps/Muldraugh, KY/worldmap.xml',
            $_SERVER['HOME'].'/.steam/steam/steamapps/common/ProjectZomboid/media/maps/Muldraugh, KY/worldmap.xml',
            // Host-mounted game media inside app container (optional)
            '/game-media/maps/Muldraugh, KY/worldmap.xml',
        ]);

        foreach ($candidates as $path) {
            if (is_string($path) && is_file($path)) {
                return $path;
            }
        }

        return null;
    }

    private function discoverMapLabels(string $worldmapXml): ?string
    {
        // .../media/maps/Muldraugh, KY/worldmap.xml → .../media/lua/shared/Translate/EN/MapLabel.json
        $mapsDir = dirname($worldmapXml, 2); // media/maps
        $mediaDir = dirname($mapsDir); // media
        $candidate = $mediaDir.'/lua/shared/Translate/EN/MapLabel.json';

        return is_file($candidate) ? $candidate : null;
    }

    private function sibling(string $path, string $name): ?string
    {
        $candidate = dirname($path).DIRECTORY_SEPARATOR.$name;

        return is_file($candidate) ? $candidate : null;
    }
}
