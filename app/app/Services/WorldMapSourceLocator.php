<?php

namespace App\Services;

/**
 * Locate worldmap.xml (+ annotations) for the active server map stack.
 *
 * Map= in server.ini is semicolon-separated, first entry wins on overlapping cells
 * (mod maps are prepended ahead of vanilla). Sources are resolved from the dedicated
 * server install media/ and Workshop downloads under steamapps/workshop/content/108600.
 */
class WorldMapSourceLocator
{
    public function __construct(
        private readonly ServerIniParser $iniParser = new ServerIniParser,
    ) {}

    /**
     * @return list<array{
     *     name: string,
     *     xml: string,
     *     annotations: string|null,
     *     labels: string|null,
     *     origin: string
     * }>
     */
    public function locateForServer(
        ?string $iniPath = null,
        ?string $serverPath = null,
        bool $includeOrphanWorkshopMaps = false,
    ): array {
        $serverPath = rtrim($serverPath ?: (string) config('zomboid.game_server_path', '/pz-server'), '/');
        $iniPath = $iniPath ?: (string) config('zomboid.paths.server_ini');

        $mapFolders = $this->mapFoldersFromIni($iniPath);
        if ($mapFolders === []) {
            $mapFolders = ['Muldraugh, KY'];
        }

        $sources = [];
        $seenNames = [];

        foreach ($mapFolders as $folder) {
            $resolved = $this->resolveMapFolder($folder, $serverPath);
            if ($resolved === null) {
                continue;
            }
            $sources[] = $resolved;
            $seenNames[$folder] = true;
        }

        if ($includeOrphanWorkshopMaps) {
            foreach ($this->scanWorkshopMapFolders($serverPath) as $resolved) {
                if (isset($seenNames[$resolved['name']])) {
                    continue;
                }
                $sources[] = $resolved;
                $seenNames[$resolved['name']] = true;
            }
        }

        return $sources;
    }

    /**
     * Resolve a single Map= folder name to on-disk paths.
     *
     * @return array{name: string, xml: string, annotations: string|null, labels: string|null, origin: string}|null
     */
    public function resolveMapFolder(string $folder, ?string $serverPath = null): ?array
    {
        $folder = trim($folder);
        if ($folder === '') {
            return null;
        }

        $serverPath = rtrim($serverPath ?: (string) config('zomboid.game_server_path', '/pz-server'), '/');

        $fallback = null;

        foreach ($this->candidateMapDirs($folder, $serverPath) as $dir => $origin) {
            $xml = $dir.DIRECTORY_SEPARATOR.'worldmap.xml';
            if (! is_file($xml) || ! is_readable($xml)) {
                continue;
            }

            $annotations = $dir.DIRECTORY_SEPARATOR.'worldmap-annotations.lua';
            $labels = $this->discoverLabelsNear($dir, $serverPath);
            $resolved = [
                'name' => $folder,
                'xml' => $xml,
                'annotations' => is_file($annotations) ? $annotations : null,
                'labels' => $labels,
                'origin' => $origin,
            ];

            // Vanilla Knox Country is multi‑MB. Prefer larger worldmap.xml over tiny stubs
            // (test fixtures / accidental overwrites that only contain "Testville").
            $size = (int) filesize($xml);
            if ($this->looksLikeVanillaBaseFolder($folder) && $size < 50_000) {
                $fallback ??= $resolved;

                continue;
            }

            return $resolved;
        }

        return $fallback;
    }

    /**
     * Vanilla Knox Country base map folder is multi-megabyte; tiny worldmap.xml is never valid.
     */
    private function looksLikeVanillaBaseFolder(string $folder): bool
    {
        $normalized = strtolower(trim($folder));

        return $normalized === 'muldraugh, ky' || $normalized === 'muldraugh,ky';
    }

    /**
     * @return list<string>
     */
    public function mapFoldersFromIni(?string $iniPath = null): array
    {
        $iniPath = $iniPath ?: (string) config('zomboid.paths.server_ini');
        if (! is_file($iniPath)) {
            return [];
        }

        try {
            $config = $this->iniParser->read($iniPath);
        } catch (\Throwable) {
            return [];
        }

        $raw = (string) ($config['Map'] ?? '');
        if ($raw === '') {
            return [];
        }

        $parts = array_values(array_filter(
            array_map('trim', explode(';', $raw)),
            static fn (string $p): bool => $p !== '',
        ));

        return $parts;
    }

    /**
     * @return list<array{name: string, xml: string, annotations: string|null, labels: string|null, origin: string}>
     */
    public function scanWorkshopMapFolders(?string $serverPath = null): array
    {
        $serverPath = rtrim($serverPath ?: (string) config('zomboid.game_server_path', '/pz-server'), '/');
        $workshopRoot = $serverPath.'/steamapps/workshop/content/108600';
        if (! is_dir($workshopRoot)) {
            return [];
        }

        $found = [];
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($workshopRoot, \FilesystemIterator::SKIP_DOTS),
        );

        foreach ($iterator as $file) {
            if (! $file->isFile() || $file->getFilename() !== 'worldmap.xml') {
                continue;
            }

            $dir = $file->getPath();
            // Expect .../media/maps/{MapFolder}/worldmap.xml
            $name = basename($dir);
            if ($name === '' || $name === 'maps') {
                continue;
            }

            $parent = basename(dirname($dir));
            if ($parent !== 'maps') {
                continue;
            }

            $annotations = $dir.DIRECTORY_SEPARATOR.'worldmap-annotations.lua';
            $found[] = [
                'name' => $name,
                'xml' => $file->getPathname(),
                'annotations' => is_file($annotations) ? $annotations : null,
                'labels' => $this->discoverLabelsNear($dir, $serverPath),
                'origin' => 'workshop-scan',
            ];
        }

        usort($found, static fn (array $a, array $b): int => strcmp($a['name'], $b['name']));

        return $found;
    }

    /**
     * Candidate directories for a Map folder, highest trust first.
     *
     * @return array<string, string> path => origin label
     */
    private function candidateMapDirs(string $folder, string $serverPath): array
    {
        $candidates = [];

        // Vanilla / shipped media
        $vanilla = $serverPath.'/media/maps/'.$folder;
        $candidates[$vanilla] = 'server-media';

        // Host Steam / optional mounts used in dev
        foreach ($this->extraMediaRoots() as $root => $origin) {
            $candidates[rtrim($root, '/').'/maps/'.$folder] = $origin;
        }

        // Workshop: common B42 layouts under each subscribed item
        $workshopRoot = $serverPath.'/steamapps/workshop/content/108600';
        if (is_dir($workshopRoot)) {
            foreach (glob($workshopRoot.'/*', GLOB_ONLYDIR) ?: [] as $itemDir) {
                $steamId = basename($itemDir);
                $patterns = [
                    $itemDir.'/mods/*/media/maps/'.$folder,
                    $itemDir.'/mods/*/42/media/maps/'.$folder,
                    $itemDir.'/mods/*/common/media/maps/'.$folder,
                    $itemDir.'/mods/*/42/common/media/maps/'.$folder,
                    // Some packs put maps at mod root without version folder
                    $itemDir.'/media/maps/'.$folder,
                ];
                foreach ($patterns as $pattern) {
                    foreach (glob($pattern, GLOB_ONLYDIR) ?: [] as $dir) {
                        $candidates[$dir] = 'workshop:'.$steamId;
                    }
                }
            }
        }

        return $candidates;
    }

    /**
     * @return array<string, string> media root => origin
     */
    private function extraMediaRoots(): array
    {
        $roots = [];
        $configured = config('zomboid.map.extra_media_roots', []);
        if (is_array($configured)) {
            foreach ($configured as $root) {
                if (is_string($root) && $root !== '') {
                    $roots[$root] = 'config';
                }
            }
        }

        // Optional bind often used for bake tooling
        if (is_dir('/game-media')) {
            $roots['/game-media'] = 'game-media';
        }

        // Dev-only host Steam paths — never in automated tests (pollutes Map= resolution)
        if (! app()->environment('testing')) {
            $home = $_SERVER['HOME'] ?? null;
            if (is_string($home) && $home !== '') {
                $mac = $home.'/Library/Application Support/Steam/steamapps/common/ProjectZomboid/Project Zomboid.app/Contents/Java/media';
                if (is_dir($mac)) {
                    $roots[$mac] = 'local-steam';
                }
                $linux = $home.'/.steam/steam/steamapps/common/ProjectZomboid/media';
                if (is_dir($linux)) {
                    $roots[$linux] = 'local-steam';
                }
            }
        }

        return $roots;
    }

    private function discoverLabelsNear(string $mapDir, string $serverPath): ?string
    {
        // Prefer server install EN MapLabel.json (has vanilla keys; mods rarely ship new ones)
        $serverLabels = $serverPath.'/media/lua/shared/Translate/EN/MapLabel.json';
        if (is_file($serverLabels)) {
            return $serverLabels;
        }

        // Walk up from map dir looking for media/lua/shared/Translate/EN/MapLabel.json
        $cursor = $mapDir;
        for ($i = 0; $i < 8; $i++) {
            $candidate = $cursor.'/lua/shared/Translate/EN/MapLabel.json';
            if (is_file($candidate)) {
                return $candidate;
            }
            // if we're inside .../media/maps/X, media is two levels up
            $parent = dirname($cursor);
            if ($parent === $cursor) {
                break;
            }
            $cursor = $parent;
            $mediaCandidate = $cursor.'/shared/Translate/EN/MapLabel.json';
            if (str_ends_with($cursor, '/lua') && is_file($mediaCandidate)) {
                return $mediaCandidate;
            }
        }

        return null;
    }
}
