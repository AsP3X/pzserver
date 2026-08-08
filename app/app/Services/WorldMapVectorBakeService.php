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
    public function bake(bool $scanWorkshop = false, bool $includeForest = true): array
    {
        $sources = $this->locator->locateForServer(
            includeOrphanWorkshopMaps: $scanWorkshop,
        );

        if ($sources === []) {
            $result = [
                'ok' => false,
                'message' => 'No worldmap.xml sources found. Ensure the game install is mounted (/pz-server) and Map= folders exist. Check Map= in server.ini and that /pz-server is readable.',
                'finished_at' => now()->toIso8601String(),
            ];
            $this->writeLastResult($result);
            $this->appendLog('ERROR no sources scan_workshop='.($scanWorkshop ? '1' : '0'));

            return $result;
        }

        $output = $this->outputPath();
        $this->ensureWritableDirectory(dirname($output));

        try {
            @set_time_limit(300);
            @ini_set('memory_limit', '512M');
            $data = $this->builder->buildFromSources(
                $sources,
                'merged',
                includeForest: $includeForest,
            );
            $this->builder->writeJson($data, $output);
            // Never mirror into public/ automatically — unit/feature tests use tiny fixtures and
            // would overwrite the packaged Knox Country basemap (e.g. only "Testville" left).
            // Runtime serves storage via /map-vector/data; public/ remains a deploy seed only.
        } catch (\Throwable $e) {
            $hint = $this->permissionHint($output, $e->getMessage());
            $result = [
                'ok' => false,
                'message' => 'Bake failed: '.$e->getMessage().$hint,
                'error' => $e->getMessage(),
                'output' => $output,
                'finished_at' => now()->toIso8601String(),
            ];
            $this->writeLastResult($result);
            $this->appendLog('ERROR '.$e->getMessage().' path='.$output);

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
            'OK bytes=%d sources=%d features=%d path=%s',
            $bytes,
            $data['stats']['sources'] ?? count($sources),
            $data['stats']['features'] ?? 0,
            $output,
        ));

        return $result;
    }

    /**
     * @return array{exists: bool, bytes: int|null, modified_at: string|null, url: string, path: string|null}
     */
    public function assetStatus(): array
    {
        $path = $this->resolveReadablePath();
        $exists = $path !== null && is_file($path);

        return [
            'exists' => $exists,
            'bytes' => $exists ? (int) filesize($path) : null,
            'modified_at' => $exists ? date('c', (int) filemtime($path)) : null,
            'url' => (string) config('zomboid.map.vector_url', '/map-vector/data'),
            'path' => $path,
        ];
    }

    /**
     * Prefer runtime storage bake, then packaged public/ seed.
     */
    public function resolveReadablePath(): ?string
    {
        foreach ($this->candidatePaths() as $path) {
            if (is_file($path) && is_readable($path)) {
                return $path;
            }
        }

        return null;
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

    /**
     * Writable path for UI/runtime bakes (under storage — owned by www-data in Docker).
     */
    public function outputPath(): string
    {
        $configured = config('zomboid.map.vector_path');
        if (is_string($configured) && $configured !== '') {
            return $configured;
        }

        return storage_path('app/map-vector/vanilla/map.json');
    }

    /**
     * @return list<string>
     */
    public function candidatePaths(): array
    {
        $configured = config('zomboid.map.vector_path');
        $paths = [];
        if (is_string($configured) && $configured !== '') {
            $paths[] = $configured;
        }
        $paths[] = storage_path('app/map-vector/vanilla/map.json');
        $paths[] = public_path('map-vector/vanilla/map.json');
        $paths[] = base_path('public/map-vector/vanilla/map.json');

        return array_values(array_unique($paths));
    }

    private function resultPath(): string
    {
        return storage_path('app/map-vector-bake.json');
    }

    private function logPath(): string
    {
        return storage_path('logs/map-vector-bake.log');
    }

    private function ensureWritableDirectory(string $dir): void
    {
        if (! is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        if (! is_dir($dir)) {
            throw new \RuntimeException("Cannot create bake directory: {$dir}");
        }
        if (! is_writable($dir)) {
            throw new \RuntimeException(
                "Bake directory is not writable: {$dir}. In Docker run: "
                .'docker exec -u root pz-app chown -R www-data:www-data /var/www/html/storage/app/map-vector '
                .'&& docker exec -u root pz-app chmod -R 775 /var/www/html/storage/app/map-vector'
            );
        }
    }

    private function permissionHint(string $path, string $message): string
    {
        $lower = strtolower($message);
        if (! str_contains($lower, 'permission')
            && ! str_contains($lower, 'failed to write')
            && ! str_contains($lower, 'not writable')) {
            return '';
        }

        return ' [path='.$path.']. Fix: docker exec -u root pz-app chown -R www-data:www-data storage/app/map-vector storage/logs && docker exec -u root pz-app chmod -R 775 storage/app/map-vector';
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
