<?php

namespace App\Services;

use PDO;
use RecursiveDirectoryIterator;
use RecursiveIteratorIterator;
use RuntimeException;
use SplFileInfo;
use Throwable;

/**
 * Stores DZI map tiles in a single SQLite database instead of millions of loose files.
 *
 * pzmap2dzi still renders a tile pyramid to disk; after render we pack those tiles
 * into one DB file and remove the loose tree. Serving reads blobs from SQLite.
 */
class MapTileStore
{
    public const PACK_FILENAME = 'tiles.sqlite';

    /**
     * Max directory entries scanned per level when probing for loose tiles.
     *
     * Bottom level directories can hold millions of entries; hasLooseTiles()
     * runs on every dashboard poll, so the probe must stay bounded.
     */
    private const LOOSE_PROBE_LIMIT = 20000;

    /** @var list<string> */
    private const TILE_EXTENSIONS = ['webp', 'jpg', 'jpeg'];

    public function __construct(
        private readonly ?string $tilesPath = null,
    ) {}

    public function rootPath(): string
    {
        return rtrim((string) ($this->tilesPath ?? config('zomboid.map.tiles_path')), '/');
    }

    public function packPath(): string
    {
        return $this->rootPath().'/'.self::PACK_FILENAME;
    }

    public function looseLayerPath(): string
    {
        return $this->rootPath().'/html/map_data/base/layer0_files';
    }

    public function mapInfoPath(): string
    {
        return $this->rootPath().'/html/map_data/base/map_info.json';
    }

    /**
     * Whether a usable packed tile set (or legacy loose tiles) exists.
     */
    public function hasTiles(): bool
    {
        if ($this->hasPackedTiles()) {
            return true;
        }

        return $this->hasLooseTiles();
    }

    public function hasPackedTiles(): bool
    {
        $path = $this->packPath();
        if (! is_file($path) || filesize($path) < 1024) {
            return false;
        }

        try {
            $pdo = $this->openReadOnly($path);
            // Avoid COUNT(*) on multi-million-row tables — existence of one row is enough
            $exists = $pdo->query('SELECT 1 FROM tiles LIMIT 1')->fetchColumn();

            return $exists !== false;
        } catch (Throwable) {
            return false;
        }
    }

    /**
     * Whether the loose pyramid holds at least one tile image.
     *
     * pzmap2dzi builds the pyramid bottom-up, so the top levels (0-3) are only
     * written at the very end of a render. Probing every level lets a partial
     * render show up in the UI and stay resumable/packable.
     */
    public function hasLooseTiles(): bool
    {
        return $this->findLooseTile() !== null;
    }

    /**
     * Path of the first tile image found in the loose pyramid, or null.
     *
     * Levels are probed shallow-first: those directories are small, and a
     * finished render always has them populated.
     */
    private function findLooseTile(): ?string
    {
        foreach ($this->looseLevels() as $dir) {
            $handle = @opendir($dir);
            if ($handle === false) {
                continue;
            }

            $scanned = 0;
            while (($entry = readdir($handle)) !== false) {
                if (++$scanned > self::LOOSE_PROBE_LIMIT) {
                    break;
                }

                if (in_array(strtolower(pathinfo($entry, PATHINFO_EXTENSION)), self::TILE_EXTENSIONS, true)) {
                    closedir($handle);

                    return $dir.'/'.$entry;
                }
            }

            closedir($handle);
        }

        return null;
    }

    /**
     * Numeric level directories of the loose pyramid, ascending.
     *
     * @return array<int, string> level => absolute directory path
     */
    public function looseLevels(): array
    {
        $layer0 = $this->looseLayerPath();
        $entries = @scandir($layer0);
        if ($entries === false) {
            return [];
        }

        $levels = [];
        foreach ($entries as $entry) {
            if (preg_match('/^\d+$/', $entry) !== 1) {
                continue;
            }

            $dir = $layer0.'/'.$entry;
            if (is_dir($dir)) {
                $levels[(int) $entry] = $dir;
            }
        }

        ksort($levels);

        return $levels;
    }

    /**
     * Per-level file counts for the loose pyramid.
     *
     * `empty` counts pzmap2dzi's zero-byte `.empty` sentinels — tiles that
     * rendered to nothing because that part of the map is void. A level with
     * only sentinels means the renderer worked there and found no map data.
     *
     * Walks whole directories, so this is for on-demand diagnostics only.
     *
     * @return array<int, array{images: int, empty: int}>
     */
    public function looseLevelStats(): array
    {
        $stats = [];

        foreach ($this->looseLevels() as $level => $dir) {
            $counts = ['images' => 0, 'empty' => 0];
            $handle = @opendir($dir);
            if ($handle === false) {
                $stats[$level] = $counts;

                continue;
            }

            while (($entry = readdir($handle)) !== false) {
                $ext = strtolower(pathinfo($entry, PATHINFO_EXTENSION));
                if (in_array($ext, self::TILE_EXTENSIONS, true)) {
                    $counts['images']++;
                } elseif ($ext === 'empty') {
                    $counts['empty']++;
                }
            }

            closedir($handle);
            $stats[$level] = $counts;
        }

        return $stats;
    }

    /**
     * Number of tiles in the packed database (null when there is no usable pack).
     */
    public function packedTileCount(): ?int
    {
        if (! $this->hasPackedTiles()) {
            return null;
        }

        try {
            $pdo = $this->openReadOnly($this->packPath());

            return (int) $pdo->query('SELECT COUNT(*) FROM tiles')->fetchColumn();
        } catch (Throwable) {
            return null;
        }
    }

    /**
     * @return array{width: int, height: int, x0: int, y0: int, sqr: int, maxNativeZoom: int, isometric: bool}|null
     */
    public function getDziConfig(): ?array
    {
        $mapInfo = $this->getMapInfo();
        if ($mapInfo === null) {
            if (! $this->hasTiles()) {
                return null;
            }

            // Partial / unknown layout — enough for Leaflet to request tiles
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

    /**
     * @return array{w: int, h: int, x0?: int, y0?: int, sqr?: int}|null
     */
    public function getMapInfo(): ?array
    {
        if ($this->hasPackedTiles()) {
            try {
                $pdo = $this->openReadOnly($this->packPath());
                $stmt = $pdo->prepare('SELECT value FROM meta WHERE key = ?');
                $stmt->execute(['map_info']);
                $raw = $stmt->fetchColumn();
                if (is_string($raw) && $raw !== '') {
                    $decoded = json_decode($raw, true);
                    if (is_array($decoded) && isset($decoded['w'], $decoded['h'])) {
                        return $decoded;
                    }
                }
            } catch (Throwable) {
                // fall through to loose map_info.json
            }
        }

        $infoPath = $this->mapInfoPath();
        if (! is_file($infoPath)) {
            return null;
        }

        $decoded = json_decode((string) file_get_contents($infoPath), true);
        if (! is_array($decoded) || ! isset($decoded['w'], $decoded['h'])) {
            return null;
        }

        return $decoded;
    }

    /**
     * Fetch a single tile blob.
     *
     * @return array{data: string, content_type: string}|null
     */
    public function getTile(string $level, string $tile): ?array
    {
        $baseTile = pathinfo($tile, PATHINFO_FILENAME);
        if ($baseTile === '' || ! preg_match('/^\d+_\d+$/', $baseTile)) {
            return null;
        }

        if (! preg_match('/^\d+$/', $level)) {
            return null;
        }

        [$x, $y] = array_map('intval', explode('_', $baseTile, 2));
        $z = (int) $level;

        $packPath = $this->packPath();
        if (is_file($packPath)) {
            try {
                $pdo = $this->openReadOnly($packPath);
                $stmt = $pdo->prepare('SELECT format, data FROM tiles WHERE z = ? AND x = ? AND y = ? LIMIT 1');
                $stmt->execute([$z, $x, $y]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if ($row !== false) {
                    $format = (string) $row['format'];

                    return [
                        'data' => (string) $row['data'],
                        'content_type' => $format === 'jpg' || $format === 'jpeg' ? 'image/jpeg' : 'image/webp',
                    ];
                }

                // Pack exists but tile missing — do not fall through to loose files
                return null;
            } catch (Throwable) {
                // fall through to loose files for partial/corrupt packs
            }
        }

        // Legacy loose files
        $dziPath = $this->looseLayerPath();
        foreach (['webp', 'jpg'] as $ext) {
            $candidate = $dziPath.'/'.$level.'/'.$baseTile.'.'.$ext;
            if (! is_file($candidate)) {
                continue;
            }

            $realRoot = realpath($this->rootPath());
            $realFile = realpath($candidate);
            if ($realRoot === false || $realFile === false || ! str_starts_with($realFile, $realRoot)) {
                return null;
            }

            $data = file_get_contents($realFile);
            if ($data === false) {
                return null;
            }

            return [
                'data' => $data,
                'content_type' => $ext === 'jpg' ? 'image/jpeg' : 'image/webp',
            ];
        }

        return null;
    }

    /**
     * Pack a loose pzmap2dzi tile pyramid into a single SQLite file, then remove loose tiles.
     *
     * @param  (callable(int $packed, int $total): void)|null  $onProgress
     * @return array{tiles: int, path: string}
     */
    public function packLooseTiles(bool $removeLoose = true, ?callable $onProgress = null): array
    {
        $layer0 = $this->looseLayerPath();
        if (! is_dir($layer0)) {
            throw new RuntimeException("Loose tile directory not found: {$layer0}");
        }

        $root = $this->rootPath();
        if (! is_dir($root)) {
            mkdir($root, 0755, true);
        }

        $packPath = $this->packPath();
        $tempPath = $packPath.'.packing';

        if (is_file($tempPath)) {
            @unlink($tempPath);
        }

        // Pre-count tile files so packing can report percent
        $totalEstimate = 0;
        if ($onProgress !== null) {
            $progressService = new MapTileProgress;
            $totalEstimate = $progressService->countLooseTiles($layer0);
            $onProgress(0, $totalEstimate);
        }

        $pdo = new PDO('sqlite:'.$tempPath, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        ]);

        $pdo->exec('PRAGMA journal_mode = OFF');
        $pdo->exec('PRAGMA synchronous = OFF');
        $pdo->exec('PRAGMA temp_store = MEMORY');
        $pdo->exec('PRAGMA cache_size = -65536');

        $pdo->exec('CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
        $pdo->exec('CREATE TABLE tiles (
            z INTEGER NOT NULL,
            x INTEGER NOT NULL,
            y INTEGER NOT NULL,
            format TEXT NOT NULL,
            data BLOB NOT NULL,
            PRIMARY KEY (z, x, y)
        ) WITHOUT ROWID');

        $mapInfoRaw = null;
        $infoPath = $this->mapInfoPath();
        if (is_file($infoPath)) {
            $mapInfoRaw = (string) file_get_contents($infoPath);
        }

        $meta = $pdo->prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
        $meta->execute(['version', '1']);
        $meta->execute(['created_at', gmdate('c')]);
        $meta->execute(['source', 'pzmap2dzi']);
        if ($mapInfoRaw !== null && $mapInfoRaw !== '') {
            $meta->execute(['map_info', $mapInfoRaw]);
        }

        $insert = $pdo->prepare('INSERT OR REPLACE INTO tiles (z, x, y, format, data) VALUES (?, ?, ?, ?, ?)');
        $count = 0;
        $batchSize = 200;
        $progressEvery = 500;
        $pauseEvery = max(50, (int) config('zomboid.map.pack_pause_every', 100));
        $pauseUs = max(0, (int) config('zomboid.map.pack_pause_us', 10000));

        $pdo->beginTransaction();

        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($layer0, RecursiveDirectoryIterator::SKIP_DOTS),
        );

        /** @var SplFileInfo $file */
        foreach ($iterator as $file) {
            if (! $file->isFile()) {
                continue;
            }

            $ext = strtolower($file->getExtension());
            if ($ext !== 'webp' && $ext !== 'jpg' && $ext !== 'jpeg') {
                continue;
            }

            $basename = $file->getBasename('.'.$file->getExtension());
            if (! preg_match('/^(\d+)_(\d+)$/', $basename, $m)) {
                continue;
            }

            $levelDir = basename(dirname($file->getPathname()));
            if (! preg_match('/^\d+$/', $levelDir)) {
                continue;
            }

            $data = file_get_contents($file->getPathname());
            if ($data === false || $data === '') {
                continue;
            }

            $format = $ext === 'jpeg' ? 'jpg' : $ext;
            // SQLite PDO stores PHP strings as blobs correctly (including null bytes)
            $insert->execute([
                (int) $levelDir,
                (int) $m[1],
                (int) $m[2],
                $format,
                $data,
            ]);

            $count++;
            if ($count % $batchSize === 0) {
                $pdo->commit();
                $pdo->beginTransaction();
            }

            // Yield disk to the game server / OS
            if ($pauseUs > 0 && $count % $pauseEvery === 0) {
                usleep($pauseUs);
            }

            if ($onProgress !== null && ($count % $progressEvery === 0 || ($totalEstimate > 0 && $count >= $totalEstimate))) {
                $onProgress($count, max($totalEstimate, $count));
            }
        }

        if ($onProgress !== null && $count > 0) {
            $onProgress($count, max($totalEstimate, $count));
        }

        $pdo->commit();
        $pdo->exec('ANALYZE');
        $pdo = null;

        if ($count === 0) {
            @unlink($tempPath);
            throw new RuntimeException('No tile images found to pack under '.$layer0);
        }

        if (is_file($packPath)) {
            @unlink($packPath);
        }

        if (! rename($tempPath, $packPath)) {
            throw new RuntimeException("Failed to move packed tiles to {$packPath}");
        }

        // Keep a small map_info.json sidecar for tools that look for it
        if ($mapInfoRaw !== null && $mapInfoRaw !== '') {
            $infoDir = dirname($infoPath);
            if (! is_dir($infoDir)) {
                mkdir($infoDir, 0755, true);
            }
            file_put_contents($infoPath, $mapInfoRaw);
        }

        if ($removeLoose) {
            $this->removeLooseTiles();
        }

        return [
            'tiles' => $count,
            'path' => $packPath,
        ];
    }

    /**
     * Remove the multi-million-file loose DZI pyramid. Keeps map_info.json and the pack DB.
     *
     * Uses rename + background purge so callers do not block on millions of unlinks.
     *
     * @param  (callable(string $message): void)|null  $onLog
     */
    public function removeLooseTiles(?callable $onLog = null): void
    {
        $layer0 = $this->looseLayerPath();
        if (! is_dir($layer0)) {
            return;
        }

        $this->trashPath($layer0, $onLog);
    }

    /**
     * Delete packed DB and tile trees. Returns immediately for huge pyramids by
     * renaming them out of the way and purging in the background.
     *
     * @param  (callable(string $message): void)|null  $onLog
     */
    public function clearAll(?callable $onLog = null): void
    {
        $log = $onLog ?? static function (string $message): void {};

        $pack = $this->packPath();
        if (is_file($pack)) {
            $log('Removing tiles.sqlite ('.$this->humanSize((int) filesize($pack)).')…');
            @unlink($pack);
        } else {
            $log('No tiles.sqlite present.');
        }

        $temp = $pack.'.packing';
        if (is_file($temp)) {
            $log('Removing incomplete pack file…');
            @unlink($temp);
        }

        $root = $this->rootPath();
        if (! is_dir($root)) {
            $log('Tiles root does not exist yet.');

            return;
        }

        // Instantly free the live paths so generate/resume can start; purge later.
        $html = $root.'/html';
        if (is_dir($html)) {
            $log('Moving html/ tile tree aside (instant)…');
            $this->trashPath($html, $log);
        } else {
            $log('No html/ tile tree present.');
        }

        // Clean any leftover loose path if it exists outside html (should not)
        $layer0 = $this->looseLayerPath();
        if (is_dir($layer0)) {
            $log('Moving remaining layer0_files aside…');
            $this->trashPath($layer0, $log);
        }

        // Kick purge for any previous .trash-* dirs still sitting around
        $this->purgeExistingTrashDirs($root, $log);

        $log('Live tile paths are clear. Background purge of old files may still run for a while.');
    }

    /**
     * Rename a directory to .trash-* under the tiles root and delete it in the background.
     * Rename is O(1); deleting millions of files can take a long time.
     *
     * @param  (callable(string $message): void)|null  $onLog
     */
    private function trashPath(string $path, ?callable $onLog = null): void
    {
        $log = $onLog ?? static function (string $message): void {};

        if (! file_exists($path)) {
            return;
        }

        $root = $this->rootPath();
        if (! is_dir($root)) {
            mkdir($root, 0755, true);
        }

        $base = basename($path);
        $trash = $root.'/.trash-'.$base.'-'.bin2hex(random_bytes(4));

        // If rename fails (cross-device), fall back to a slow delete with a warning
        if (@rename($path, $trash)) {
            $log("Queued background delete: {$trash}");
            $this->purgePathInBackground($trash);

            return;
        }

        $log("Rename failed for {$path}; falling back to slow delete (may take a long time)…");
        $this->purgePathSync($path);
        $log("Finished slow delete: {$path}");
    }

    /**
     * @param  (callable(string $message): void)|null  $onLog
     */
    private function purgeExistingTrashDirs(string $root, ?callable $onLog = null): void
    {
        $log = $onLog ?? static function (string $message): void {};
        $entries = @scandir($root);
        if ($entries === false) {
            return;
        }

        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            if (! str_starts_with($entry, '.trash-')) {
                continue;
            }
            $full = $root.'/'.$entry;
            if (is_dir($full) || is_file($full)) {
                $log("Re-queueing leftover trash: {$entry}");
                $this->purgePathInBackground($full);
            }
        }
    }

    private function purgePathInBackground(string $path): void
    {
        if (! file_exists($path)) {
            return;
        }

        if (PHP_OS_FAMILY === 'Windows') {
            $this->purgePathSync($path);

            return;
        }

        // Detach so artisan returns immediately; log to storage if possible
        $logFile = storage_path('logs/map-tiles-purge.log');
        $cmd = sprintf(
            'nohup sh -c %s >> %s 2>&1 &',
            escapeshellarg('echo "[$(date -Iseconds)] purging '.$path.'"; rm -rf '.escapeshellarg($path).'; echo "[$(date -Iseconds)] done '.$path.'"'),
            escapeshellarg($logFile),
        );
        exec($cmd);
    }

    private function purgePathSync(string $path): void
    {
        if (! file_exists($path)) {
            return;
        }

        if (is_file($path) || is_link($path)) {
            @unlink($path);

            return;
        }

        if (PHP_OS_FAMILY !== 'Windows') {
            exec('rm -rf '.escapeshellarg($path), $output, $code);
            if ($code === 0 && ! file_exists($path)) {
                return;
            }
        }

        $this->deleteDirectoryRecursive($path);
    }

    private function humanSize(int $bytes): string
    {
        $units = ['B', 'KB', 'MB', 'GB'];
        $i = 0;
        $size = (float) $bytes;
        while ($size >= 1024 && $i < count($units) - 1) {
            $size /= 1024;
            $i++;
        }

        return round($size, 1).' '.$units[$i];
    }

    private function openReadOnly(string $path): PDO
    {
        $pdo = new PDO('sqlite:'.$path, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);

        try {
            $pdo->exec('PRAGMA query_only = ON');
        } catch (Throwable) {
            // Older SQLite builds may not support query_only
        }

        return $pdo;
    }

    private function deleteDirectoryRecursive(string $dir): void
    {
        if (! is_dir($dir)) {
            return;
        }

        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, RecursiveDirectoryIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST,
        );

        /** @var SplFileInfo $file */
        foreach ($iterator as $file) {
            if ($file->isDir()) {
                @rmdir($file->getPathname());
            } else {
                @unlink($file->getPathname());
            }
        }

        @rmdir($dir);
    }
}
