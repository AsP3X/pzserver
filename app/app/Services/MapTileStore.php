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

    public function hasLooseTiles(): bool
    {
        $layer0 = $this->looseLayerPath();

        foreach (['0', '1', '2', '3'] as $level) {
            $dir = $layer0.'/'.$level;
            if (! is_dir($dir)) {
                continue;
            }

            $files = array_merge(
                glob($dir.'/*.webp') ?: [],
                glob($dir.'/*.jpg') ?: [],
            );

            if ($files !== []) {
                return true;
            }
        }

        return false;
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
        $batchSize = 500;
        $progressEvery = 1000;

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
     */
    public function removeLooseTiles(): void
    {
        $layer0 = $this->looseLayerPath();
        if (! is_dir($layer0)) {
            return;
        }

        // rm -rf is far faster than PHP recursion for huge trees
        if (PHP_OS_FAMILY !== 'Windows') {
            $cmd = 'rm -rf '.escapeshellarg($layer0);
            exec($cmd, $output, $code);
            if ($code === 0 && ! is_dir($layer0)) {
                return;
            }
        }

        $this->deleteDirectoryRecursive($layer0);
    }

    /**
     * Delete packed DB (and optional loose leftovers) before a forced regenerate.
     */
    public function clearAll(): void
    {
        $pack = $this->packPath();
        if (is_file($pack)) {
            @unlink($pack);
        }

        $temp = $pack.'.packing';
        if (is_file($temp)) {
            @unlink($temp);
        }

        // Wipe entire tiles root contents carefully (keeps the directory itself)
        $root = $this->rootPath();
        if (is_dir($root)) {
            $html = $root.'/html';
            if (is_dir($html)) {
                if (PHP_OS_FAMILY !== 'Windows') {
                    exec('rm -rf '.escapeshellarg($html));
                }
                if (is_dir($html)) {
                    $this->deleteDirectoryRecursive($html);
                }
            }
        }

        $this->removeLooseTiles();
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
