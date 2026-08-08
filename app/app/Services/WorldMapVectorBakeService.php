<?php

namespace App\Services;

/**
 * List Map= / Workshop worldmap sources and bake the public vector basemap for the admin UI.
 */
class WorldMapVectorBakeService
{
    public function __construct(
        private readonly WorldMapSourceLocator $locator = new WorldMapSourceLocator,
        private readonly WorldMapVectorBuilder $builder = new WorldMapVectorBuilder,
    ) {}

    /**
     * @return list<array{name: string, origin: string, xml: string, has_annotations: bool, missing?: bool}>
     */
    public function listSources(bool $scanWorkshop = false): array
    {
        $resolved = $this->locator->locateForServer(
            includeOrphanWorkshopMaps: $scanWorkshop,
        );

        $byName = [];
        foreach ($resolved as $source) {
            $byName[$source['name']] = [
                'name' => $source['name'],
                'origin' => $source['origin'],
                'xml' => $source['xml'],
                'has_annotations' => $source['annotations'] !== null,
            ];
        }

        $out = array_values($byName);

        // Flag Map= folders that could not be resolved
        foreach ($this->locator->mapFoldersFromIni() as $folder) {
            if (isset($byName[$folder])) {
                continue;
            }
            $out[] = [
                'name' => $folder,
                'origin' => 'unresolved',
                'xml' => '',
                'has_annotations' => false,
                'missing' => true,
            ];
        }

        return $out;
    }

    /**
     * @return array{
     *     ok: bool,
     *     message: string,
     *     output?: string,
     *     bytes?: int,
     *     source?: string,
     *     maps?: list<array{name: string, origin: string}>,
     *     stats?: array<string, int>,
     *     bounds?: list<int>,
     *     finished_at?: string
     * }
     */
    public function bake(bool $scanWorkshop = false): array
    {
        $sources = $this->locator->locateForServer(
            includeOrphanWorkshopMaps: $scanWorkshop,
        );

        if ($sources === []) {
            $result = [
                'ok' => false,
                'message' => 'No worldmap.xml sources found. Ensure the game install is mounted (/pz-server) and Map= folders exist.',
                'finished_at' => now()->toIso8601String(),
            ];
            $this->writeLastResult($result);

            return $result;
        }

        $output = $this->outputPath();

        try {
            @set_time_limit(180);
            $data = $this->builder->buildFromSources($sources, 'merged');
            $this->builder->writeJson($data, $output);
        } catch (\Throwable $e) {
            $result = [
                'ok' => false,
                'message' => 'Bake failed: '.$e->getMessage(),
                'finished_at' => now()->toIso8601String(),
            ];
            $this->writeLastResult($result);
            $this->appendLog('ERROR '.$e->getMessage());

            return $result;
        }

        $bytes = is_file($output) ? (int) filesize($output) : 0;
        $result = [
            'ok' => true,
            'message' => 'Vector basemap rebuilt ('.number_format($bytes).' bytes, '.count($sources).' map pack(s)).',
            'output' => $output,
            'bytes' => $bytes,
            'source' => (string) $data['source'],
            'maps' => $data['maps'],
            'stats' => $data['stats'],
            'bounds' => $data['bounds'],
            'finished_at' => now()->toIso8601String(),
        ];
        $this->writeLastResult($result);
        $this->appendLog(sprintf(
            'OK bytes=%d sources=%d features=%d',
            $bytes,
            $data['stats']['sources'] ?? count($sources),
            $data['stats']['features'] ?? 0,
        ));

        return $result;
    }

    /**
     * @return array{exists: bool, bytes: int|null, modified_at: string|null, url: string}
     */
    public function assetStatus(): array
    {
        $path = $this->outputPath();
        $exists = is_file($path);

        return [
            'exists' => $exists,
            'bytes' => $exists ? (int) filesize($path) : null,
            'modified_at' => $exists ? date('c', (int) filemtime($path)) : null,
            'url' => (string) config('zomboid.map.vector_url', '/map-vector/vanilla/map.json'),
        ];
    }

    /**
     * @return array<string, mixed>|null
     */
    public function lastResult(): ?array
    {
        $path = $this->resultPath();
        if (! is_file($path)) {
            return null;
        }

        try {
            /** @var array<string, mixed> $data */
            $data = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);

            return $data;
        } catch (\Throwable) {
            return null;
        }
    }

    public function outputPath(): string
    {
        $configured = config('zomboid.map.vector_path');
        if (is_string($configured) && $configured !== '') {
            return $configured;
        }

        return public_path('map-vector/vanilla/map.json');
    }

    private function resultPath(): string
    {
        return storage_path('app/map-vector-bake.json');
    }

    private function logPath(): string
    {
        return storage_path('logs/map-vector-bake.log');
    }

    /**
     * @param  array<string, mixed>  $result
     */
    private function writeLastResult(array $result): void
    {
        $dir = dirname($this->resultPath());
        if (! is_dir($dir)) {
            @mkdir($dir, 0755, true);
        }
        @file_put_contents(
            $this->resultPath(),
            json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES),
        );
    }

    private function appendLog(string $line): void
    {
        $dir = dirname($this->logPath());
        if (! is_dir($dir)) {
            @mkdir($dir, 0755, true);
        }
        @file_put_contents(
            $this->logPath(),
            '['.now()->toIso8601String()."] {$line}\n",
            FILE_APPEND,
        );
    }
}
