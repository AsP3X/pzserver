<?php

namespace App\Console\Commands;

use App\Services\MapTileProgress;
use App\Services\MapTileStore;
use Illuminate\Console\Command;
use Throwable;

class GenerateMapTiles extends Command
{
    /** @var string */
    protected $signature = 'zomboid:generate-map-tiles
        {--force : Clear all tiles and regenerate from scratch}
        {--resume : Continue an interrupted render (never deletes existing loose tiles)}
        {--clear : Only delete packed/loose tiles and progress state, then exit}
        {--stop : Request stop of a running generation job, then exit}
        {--status : Report what is on disk (levels, tiles, pack, progress), then exit}
        {--map= : Specific map name to generate (default: all)}
        {--workers= : Number of render workers (default: auto-detect CPU cores)}
        {--profile=lite : Render profile: lite (default, low resource) or full (more detail/layers)}
        {--keep-loose : Keep multi-file tile pyramid after packing (not recommended)}
        {--pack-only : Pack existing loose tiles into SQLite without re-rendering}';

    /** @var string */
    protected $description = 'Generate map tiles (pzmap2dzi) and pack them into a single SQLite file';

    private float $startedAt = 0.0;

    private int $lastDiskCountAt = 0;

    private int $lastTilesOnDisk = 0;

    private int $lastCliLogAt = 0;

    private bool $wasStopped = false;

    public function __construct(
        private readonly MapTileStore $tileStore,
        private readonly MapTileProgress $progress,
    ) {
        parent::__construct();
    }

    public function handle(): int
    {
        $this->startedAt = microtime(true);
        $tilesPath = $this->tileStore->rootPath();
        $serverPath = config('zomboid.game_server_path');

        if ($this->option('status')) {
            return $this->reportStatus();
        }

        if ($this->option('stop')) {
            return $this->requestStopOnly();
        }

        if ($this->option('clear')) {
            return $this->clearOnly();
        }

        // Pack-only path: convert an existing loose pyramid without re-render
        if ($this->option('pack-only')) {
            return $this->packExisting();
        }

        $force = (bool) $this->option('force');
        $resume = (bool) $this->option('resume');

        if ($force && $resume) {
            $this->error('Use either --force or --resume, not both.');

            return self::FAILURE;
        }

        // Progress may already have been started by the web UI — refresh it
        $this->progress->start([
            'stage' => 'starting',
            'step' => 0,
            'steps' => 3,
            'message' => 'Validating game files and tools…',
        ]);

        if (! is_dir($serverPath)) {
            return $this->failEarly("Game server path does not exist: {$serverPath}");
        }

        if (! is_dir($serverPath.'/media')) {
            return $this->failEarly("Game server files not ready yet (no media/ directory in {$serverPath}). Wait for SteamCMD install to finish.");
        }

        // Check Python3 availability
        exec('python3 --version 2>&1', $output, $exitCode);
        if ($exitCode !== 0) {
            return $this->failEarly('Python3 is required but not found in the app container.');
        }

        $this->info('Python3 found: '.($output[0] ?? 'unknown version'));

        // Check for pzmap2dzi
        $pzmap2dziPath = $this->findPzmap2dzi();
        if ($pzmap2dziPath === null) {
            return $this->failEarly('pzmap2dzi not found at /opt/pzmap2dzi (rebuild the app image).');
        }

        $this->info("Using pzmap2dzi: {$pzmap2dziPath}");

        $pzmapRoot = dirname($pzmap2dziPath);
        $this->ensureMapConfDefaults($pzmapRoot);

        $hasPacked = $this->tileStore->hasPackedTiles();
        $hasLoose = $this->tileStore->hasLooseTiles();

        // Default: skip only when a finished pack exists (not a partial loose pyramid)
        if (! $force && ! $resume && $hasPacked && ! $hasLoose) {
            $this->warn('Packed tiles already exist. Use --force to regenerate, or --resume after a partial run.');
            $this->progress->finish(true, 'Packed tiles already exist. Use Start over / --force to regenerate.');
            $this->clearLock();

            return self::SUCCESS;
        }

        // Auto-resume when loose pyramid remains from an interrupted run
        if (! $force && ! $resume && $hasLoose) {
            $resume = true;
            $this->info('Partial/loose tile pyramid detected — resuming (incremental render, no wipe).');
        }

        if ($resume && $hasPacked && ! $hasLoose) {
            $this->warn('Nothing to resume: only a finished pack is present. Use --force to regenerate from scratch.');
            $this->progress->finish(true, 'Nothing to resume — only a finished pack exists. Use --force to regenerate.');
            $this->clearLock();

            return self::SUCCESS;
        }

        if ($resume) {
            $this->info('Resume mode: existing loose tiles will be kept; pzmap2dzi continues incrementally.');
        }

        // Create output directory
        if (! is_dir($tilesPath)) {
            mkdir($tilesPath, 0755, true);
        }

        $this->progress->clearStopRequest();
        $this->progress->update([
            'stage' => 'starting',
            'step' => 0,
            'steps' => 3,
            'message' => $resume ? 'Resuming map tile generation…' : 'Starting map tile generation…',
            'generating' => true,
        ]);

        if ($force) {
            $this->info('Clearing previous tiles (instant rename; purge may continue in background)...');
            $this->progress->update([
                'stage' => 'clear',
                'step' => 0,
                'message' => 'Clearing previous tiles…',
            ]);
            $this->tileStore->clearAll(function (string $message): void {
                $this->line('  '.$message);
            });
        }

        // Generate pzmap2dzi config
        $confPath = $this->generateConfig($serverPath, $tilesPath, $pzmapRoot);
        $this->info("Generated config: {$confPath}");

        // Step 1: Unpack textures (very disk-heavy — skip when cache already present on resume)
        $this->info('Step 1/3: Unpacking textures (low I/O priority; may take a while)…');
        $this->progress->update([
            'stage' => 'unpack',
            'step' => 1,
            'steps' => 3,
            'message' => 'Unpacking textures (throttled I/O)…',
            'completed' => 0,
            'total' => 0,
        ]);
        if ($resume && $this->textureUnpackLooksPresent($tilesPath, $serverPath)) {
            $this->info('Skipping unpack — texture cache already present (resume).');
            $this->progress->update([
                'message' => 'Skipped unpack (cache present)…',
            ]);
        } elseif (! $this->runPzmap($pzmap2dziPath, $confPath, 'unpack', trackJobProgress: false)) {
            if ($this->wasStopped) {
                return $this->finishInterrupted();
            }
            $this->progress->finish(false, 'Unpack failed. See storage/logs/pzmap2dzi.log', 'pzmap2dzi unpack failed');
            $this->clearLock();

            return self::FAILURE;
        }
        $this->newLine();

        // Step 2: Render isometric tiles (base layer) — creates many small files temporarily
        $this->info('Step 2/3: Rendering isometric tiles (low workers + idle I/O class)…');
        $this->info('Tip: stop safely with: php artisan zomboid:generate-map-tiles --stop  (or Admin → Stop)');
        $this->info('Resume later with: php artisan zomboid:generate-map-tiles --resume');
        $this->warn('Generation intentionally throttles disk so the game server stays playable.');
        $this->progress->update([
            'stage' => 'render',
            'step' => 2,
            'steps' => 3,
            'message' => $resume ? 'Resuming isometric render (throttled)…' : 'Rendering isometric tiles (throttled)…',
            'completed' => 0,
            'total' => 0,
        ]);
        if (! $this->runPzmap($pzmap2dziPath, $confPath, 'render base', trackJobProgress: true)) {
            if ($this->wasStopped) {
                return $this->finishInterrupted();
            }
            $this->progress->finish(false, 'Render failed. See storage/logs/pzmap2dzi.log', 'pzmap2dzi render base failed');
            $this->clearLock();

            return self::FAILURE;
        }
        $this->newLine();

        if ($this->progress->shouldStop()) {
            return $this->finishInterrupted();
        }

        // Step 3: Pack into a single SQLite file and remove the file explosion
        $this->info('Step 3/3: Packing tiles into single SQLite database...');
        $this->progress->update([
            'stage' => 'pack',
            'step' => 3,
            'steps' => 3,
            'message' => 'Packing tiles into SQLite…',
            'completed' => 0,
            'total' => 0,
        ]);
        if (! $this->packRenderedTiles()) {
            if ($this->wasStopped) {
                return $this->finishInterrupted();
            }
            $this->progress->finish(false, 'Packing failed. See storage/logs/map-tiles.log', 'Failed to pack tiles into SQLite');
            $this->clearLock();

            return self::FAILURE;
        }
        $this->newLine();

        $this->progress->clearStopRequest();
        $this->progress->finish(true, 'Map tiles ready at '.$this->tileStore->packPath());
        $this->clearLock();
        $this->info('Map tiles ready at: '.$this->tileStore->packPath());
        $this->info('Loose tile files were packed away so backups/deletes stay fast.');
        $this->info('Total time: '.$this->formatElapsed(microtime(true) - $this->startedAt));

        return self::SUCCESS;
    }

    private function failEarly(string $message): int
    {
        $this->error($message);
        $this->progress->finish(false, $message, 'validation_failed');
        $this->clearLock();

        return self::FAILURE;
    }

    private function clearLock(): void
    {
        $lock = $this->progress->lockPath();
        if (is_file($lock)) {
            @unlink($lock);
        }
    }

    /**
     * Print everything needed to tell whether a render is actually producing tiles.
     */
    private function reportStatus(): int
    {
        $root = $this->tileStore->rootPath();
        $this->info('Tiles root: '.$root.(is_dir($root) ? '' : '  (MISSING)'));
        $this->line('Loose pyramid: '.$this->tileStore->looseLayerPath());

        $pack = $this->tileStore->packPath();
        if (is_file($pack)) {
            $count = $this->tileStore->packedTileCount();
            $this->info(sprintf(
                'Pack: %s (%s, %s tiles)',
                $pack,
                $this->humanFilesize((int) filesize($pack)),
                $count === null ? 'unreadable' : number_format($count),
            ));
        } else {
            $this->warn('Pack: not created yet (step 3 has not run)');
        }

        $info = $this->tileStore->getMapInfo();
        $this->line('map_info.json: '.($info === null ? 'missing' : json_encode($info)));

        $stats = $this->tileStore->looseLevelStats();
        if ($stats === []) {
            $this->warn('No level directories under the loose pyramid — render has not started writing yet.');
        } else {
            $this->newLine();
            $this->line('Level   images        empty (void map area)');
            $images = 0;
            $empty = 0;
            foreach ($stats as $level => $counts) {
                $images += $counts['images'];
                $empty += $counts['empty'];
                $this->line(sprintf(
                    '%5d   %-12s  %s',
                    $level,
                    number_format($counts['images']),
                    number_format($counts['empty']),
                ));
            }
            $this->newLine();
            $this->info(sprintf('Total: %s images, %s empty sentinels', number_format($images), number_format($empty)));
            if ($images === 0 && $empty > 0) {
                $this->warn('Only empty sentinels so far — the renderer is working through void map area.');
                $this->line('pzmap2dzi walks tiles in Z-order from the top-left of the bounding box, which is');
                $this->line('outside the map diamond in isometric projection. Images appear once it reaches it.');
            }
        }

        $progress = $this->progress->read();
        $this->newLine();
        if ($progress === null) {
            $this->line('Progress state: none recorded.');
        } else {
            $this->line(sprintf(
                'Progress: stage=%s step=%d/%d %d%% generating=%s',
                $progress['stage'],
                $progress['step'],
                $progress['steps'],
                $progress['percent'],
                $progress['generating'] ? 'yes' : 'no',
            ));
            $this->line('  '.$progress['message']);
            $this->line('  updated_at: '.($progress['updated_at'] ?? 'never'));
        }

        return self::SUCCESS;
    }

    private function requestStopOnly(): int
    {
        if (! $this->progress->isRunning() && ! is_file($this->progress->lockPath())) {
            $this->warn('No map tile generation appears to be running.');
        }

        $this->progress->requestStop();
        $this->info('Stop requested. The running job will exit after the current work unit and keep loose tiles for --resume.');

        return self::SUCCESS;
    }

    private function clearOnly(): int
    {
        $this->info('Clearing map tiles at: '.$this->tileStore->rootPath());
        $this->info('Huge tile trees are renamed away instantly; real disk free-up may continue in the background.');

        $this->tileStore->clearAll(function (string $message): void {
            $this->line('  '.$message);
        });

        $this->line('  Clearing progress / stop / lock flags…');
        $this->progress->clear();
        $this->progress->clearStopRequest();
        $lock = $this->progress->lockPath();
        if (is_file($lock)) {
            @unlink($lock);
        }

        $this->info('Done. Live paths are empty — safe to generate again now.');
        $this->line('Background purge log (if any): storage/logs/map-tiles-purge.log');
        $this->line('Check trash dirs still deleting: ls -la '.$this->tileStore->rootPath());

        return self::SUCCESS;
    }

    private function finishInterrupted(): int
    {
        $this->wasStopped = true;
        $this->newLine();
        $tiles = $this->progress->countLooseTiles($this->tileStore->looseLayerPath());
        $current = $this->progress->read();
        $this->progress->clearStopRequest();
        $this->progress->update([
            'generating' => false,
            'stage' => 'stopped',
            'message' => 'Stopped. Partial tiles kept — run with --resume to continue.',
            'error' => null,
            'tiles_on_disk' => $tiles,
            'percent' => (int) ($current['percent'] ?? 0),
            'completed' => (int) ($current['completed'] ?? 0),
            'total' => (int) ($current['total'] ?? 0),
            'finished_at' => now()->toIso8601String(),
        ]);

        $this->clearLock();
        $this->warn('Generation stopped. Loose tiles preserved for resume.');
        $this->info("Tiles on disk: ~{$tiles}");
        $this->info('Resume: docker exec -it pz-app php artisan zomboid:generate-map-tiles --resume');

        return self::SUCCESS;
    }

    private function packExisting(): int
    {
        if (! $this->tileStore->hasLooseTiles()) {
            if ($this->tileStore->hasPackedTiles()) {
                $this->info('Tiles are already packed at: '.$this->tileStore->packPath());

                return self::SUCCESS;
            }

            $this->error('No loose tiles found to pack under '.$this->tileStore->looseLayerPath());

            return self::FAILURE;
        }

        $this->startedAt = microtime(true);
        $this->progress->start([
            'stage' => 'pack',
            'step' => 1,
            'steps' => 1,
            'message' => 'Packing existing loose tiles…',
        ]);
        $this->info('Packing existing loose tiles...');

        if (! $this->packRenderedTiles()) {
            $this->progress->finish(false, 'Packing failed.', 'Failed to pack tiles into SQLite');

            return self::FAILURE;
        }

        $this->newLine();
        $this->progress->finish(true, 'Packed tiles ready at '.$this->tileStore->packPath());
        $this->info('Packed tiles ready at: '.$this->tileStore->packPath());
        $this->info('Total time: '.$this->formatElapsed(microtime(true) - $this->startedAt));

        return self::SUCCESS;
    }

    private function packRenderedTiles(): bool
    {
        try {
            $result = $this->tileStore->packLooseTiles(
                removeLoose: ! $this->option('keep-loose'),
                onProgress: function (int $packed, int $total): void {
                    if ($this->progress->shouldStop()) {
                        $this->wasStopped = true;
                        throw new \RuntimeException('Stop requested during packing');
                    }
                    $this->progress->update([
                        'stage' => 'pack',
                        'message' => 'Packing tiles into SQLite…',
                        'completed' => $packed,
                        'total' => $total,
                        'tiles_on_disk' => $total,
                    ]);
                    $this->writeCliStatus(sprintf(
                        '[pack] %s / %s tiles (%s%%)  elapsed %s',
                        number_format($packed),
                        number_format(max($total, $packed)),
                        $total > 0 ? (string) min(100, (int) round(100 * $packed / max(1, $total))) : '?',
                        $this->formatElapsed(microtime(true) - $this->startedAt),
                    ));
                },
            );

            $this->newLine();
            $this->info(sprintf(
                'Packed %s tiles into %s (%s)',
                number_format($result['tiles']),
                $result['path'],
                $this->humanFilesize((int) filesize($result['path'])),
            ));

            if ($this->option('keep-loose')) {
                $this->warn('Kept loose tile files (--keep-loose). Delete them later with: php artisan zomboid:generate-map-tiles --pack-only');
            }

            return true;
        } catch (Throwable $e) {
            $this->newLine();
            if ($this->wasStopped || str_contains($e->getMessage(), 'Stop requested')) {
                $this->wasStopped = true;
                $this->warn('Packing interrupted by stop request (loose tiles kept).');

                return false;
            }
            $this->error('Failed to pack tiles: '.$e->getMessage());

            return false;
        }
    }

    private function humanFilesize(int $bytes): string
    {
        $units = ['B', 'KB', 'MB', 'GB', 'TB'];
        $i = 0;
        $size = (float) $bytes;
        while ($size >= 1024 && $i < count($units) - 1) {
            $size /= 1024;
            $i++;
        }

        return round($size, 1).' '.$units[$i];
    }

    /**
     * Run pzmap2dzi while streaming progress from the log (and optional disk counts).
     */
    private function runPzmap(string $pzmap2dziPath, string $confPath, string $subcommand, bool $trackJobProgress): bool
    {
        $pzmap2dziDir = dirname($pzmap2dziPath);
        $logFile = storage_path('logs/pzmap2dzi.log');
        // Append separator so resume/re-runs keep history without wiping mid-flight tails
        file_put_contents($logFile, "\n==== ".now()->toIso8601String()." {$subcommand} ====\n", FILE_APPEND);

        $inner = sprintf(
            'python3 %s -c %s %s',
            escapeshellarg($pzmap2dziPath),
            escapeshellarg($confPath),
            $subcommand,
        );
        $inner = $this->prefixLowIoPriority($inner);

        $command = sprintf(
            'cd %s && %s',
            escapeshellarg($pzmap2dziDir),
            $inner,
        );

        $this->line("Running: {$command}");
        $this->line("Output logged to: {$logFile}");
        if ($trackJobProgress) {
            $this->line('Progress updates every ~2s from pzmap2dzi (job: done/total). Disk scans throttled.');
        }

        $descriptors = [
            0 => ['file', '/dev/null', 'r'],
            1 => ['file', $logFile, 'a'],
            2 => ['file', $logFile, 'a'],
        ];

        $process = @proc_open($command, $descriptors, $pipes, $pzmap2dziDir);
        if (! is_resource($process)) {
            // Fallback to blocking exec if proc_open is unavailable
            $result = 0;
            exec($command.' >> '.escapeshellarg($logFile).' 2>&1', $output, $result);

            return $this->handlePzmapExit($subcommand, $result, $logFile);
        }

        $this->lastDiskCountAt = 0;
        $this->lastTilesOnDisk = 0;
        $exitCode = 1;

        while (true) {
            $status = proc_get_status($process);
            if ($status === false) {
                break;
            }

            if ($this->progress->shouldStop()) {
                $this->wasStopped = true;
                $this->newLine();
                $this->warn('Stop requested — terminating pzmap2dzi…');
                $this->terminateProcessTree($process, $status['pid'] ?? null);
                $exitCode = 130;
                break;
            }

            if ($trackJobProgress) {
                $this->pollRenderProgress($logFile);
            } else {
                $this->writeCliStatus(sprintf(
                    '[%s] running…  elapsed %s',
                    $subcommand,
                    $this->formatElapsed(microtime(true) - $this->startedAt),
                ));
                $this->progress->update([
                    'message' => 'Running '.$subcommand.'…',
                ]);
            }

            if (! $status['running']) {
                // exitcode is only reliable the first time after the process exits
                $exitCode = (int) $status['exitcode'];
                break;
            }

            usleep(2000000); // 2s — less find(1)/stat spam on the game disk
        }

        // Final progress sample before we close
        if ($trackJobProgress && ! $this->wasStopped) {
            $this->pollRenderProgress($logFile);
        }

        if (is_resource($process)) {
            proc_close($process);
        }

        if ($this->wasStopped) {
            return false;
        }

        return $this->handlePzmapExit($subcommand, $exitCode, $logFile);
    }

    /**
     * @param  resource  $process
     */
    private function terminateProcessTree($process, ?int $pid): void
    {
        if ($pid !== null && $pid > 0 && function_exists('posix_kill')) {
            // Kill process group if possible (shell + python workers)
            @posix_kill(-$pid, defined('SIGTERM') ? SIGTERM : 15);
            @posix_kill($pid, defined('SIGTERM') ? SIGTERM : 15);
            usleep(500000);
            @posix_kill(-$pid, defined('SIGKILL') ? SIGKILL : 9);
            @posix_kill($pid, defined('SIGKILL') ? SIGKILL : 9);
        }

        // Also ask PHP to terminate the handle
        @proc_terminate($process, defined('SIGTERM') ? SIGTERM : 15);
    }

    private function pollRenderProgress(string $logFile): void
    {
        $job = $this->progress->parseJobProgressFromLog($logFile);
        $phase = $this->progress->parsePhaseFromLog($logFile);

        $now = time();
        // find(1) over a multi-million-file tree is itself a disk storm — do it rarely
        if ($now - $this->lastDiskCountAt >= 45) {
            $this->lastTilesOnDisk = $this->progress->countLooseTiles($this->tileStore->looseLayerPath());
            $this->lastDiskCountAt = $now;
        }

        $completed = $job['done'] ?? 0;
        $total = $job['total'] ?? 0;
        $percent = $total > 0 ? (int) round(100 * $completed / $total) : 0;

        $message = $total > 0
            ? sprintf('Rendering tiles %s / %s…', number_format($completed), number_format($total))
            : ($phase ?? 'Preparing render (scanning map — no tile files yet, this can take a long time)…');

        $this->progress->update([
            'stage' => 'render',
            'step' => 2,
            'steps' => 3,
            'message' => $message,
            'completed' => $completed,
            'total' => $total,
            'tiles_on_disk' => $this->lastTilesOnDisk,
        ]);

        if ($total > 0) {
            // "saved" excludes void tiles: pzmap2dzi writes a zero-byte .empty
            // sentinel instead of an image, so this stays 0 while it works
            // through map area with nothing in it.
            $this->writeCliStatus(sprintf(
                '[render] job %s / %s (%d%%)  saved tiles ~%s  elapsed %s',
                number_format($completed),
                number_format($total),
                $percent,
                number_format($this->lastTilesOnDisk),
                $this->formatElapsed(microtime(true) - $this->startedAt),
            ));
        } else {
            $this->writeCliStatus(sprintf(
                '[render] %s  saved tiles ~%s  elapsed %s',
                $phase ?? 'preparing (scan/plan — 0 tiles until workers start)',
                number_format($this->lastTilesOnDisk),
                $this->formatElapsed(microtime(true) - $this->startedAt),
            ));
        }
    }

    private function handlePzmapExit(string $subcommand, int $result, string $logFile): bool
    {
        if ($result !== 0) {
            $this->newLine();
            $this->error("pzmap2dzi '{$subcommand}' failed with exit code: {$result}");
            if (is_file($logFile)) {
                $lines = file($logFile);
                $tail = array_slice($lines, -30);
                $this->error(implode('', $tail));
            }

            return false;
        }

        $this->newLine();
        $this->info("Completed: {$subcommand}");

        return true;
    }

    private function writeCliStatus(string $line): void
    {
        // In-place status line for interactive terminals
        if (function_exists('posix_isatty') && defined('STDOUT') && @posix_isatty(STDOUT)) {
            $this->output->write("\r\033[K".$line);

            return;
        }

        // Non-TTY (docker logs without -t): throttle so logs stay readable
        $now = time();
        if ($now - $this->lastCliLogAt < 15 && $this->lastCliLogAt !== 0) {
            return;
        }
        $this->lastCliLogAt = $now;
        $this->output->writeln($line);
    }

    private function formatElapsed(float $seconds): string
    {
        $seconds = max(0, (int) floor($seconds));
        $h = intdiv($seconds, 3600);
        $m = intdiv($seconds % 3600, 60);
        $s = $seconds % 60;

        if ($h > 0) {
            return sprintf('%d:%02d:%02d', $h, $m, $s);
        }

        return sprintf('%d:%02d', $m, $s);
    }

    /**
     * Ensure conf/default_b42.txt and conf/vanilla.txt exist (upstream renamed default.txt).
     */
    private function ensureMapConfDefaults(string $pzmapRoot): void
    {
        $confDir = $pzmapRoot.'/conf';
        if (! is_dir($confDir)) {
            mkdir($confDir, 0755, true);
        }

        // Upstream: default_b42.txt (mod defaults). Old name was default.txt.
        $b42 = $confDir.'/default_b42.txt';
        $legacy = $confDir.'/default.txt';
        if (! is_file($b42) && is_file($legacy)) {
            @copy($legacy, $b42);
        }
        if (! is_file($b42)) {
            file_put_contents($b42, implode("\n", [
                'map_name: null',
                'texture: false',
                "map_path: '{mod_root}/{steam_id}/mods/{mod_name}/common/media/maps/{map_name}'",
                "texture_path: '{mod_root}/{steam_id}/mods/{mod_name}/common/media/texturepacks'",
                'encoding: utf8',
                "texture_files: ['.*[.]pack']",
                'depend: []',
                '',
            ]));
            $this->warn("Created missing {$b42}");
        }
        // Compatibility symlink/copy for anything still asking for default.txt
        if (! is_file($legacy) && is_file($b42)) {
            @copy($b42, $legacy);
        }

        $vanilla = $confDir.'/vanilla.txt';
        if (! is_file($vanilla)) {
            file_put_contents($vanilla, implode("\n", [
                '# vanilla map',
                'default:',
                "    map_path: '{pz_root}/media/maps/Muldraugh, KY'",
                '    texture: true',
                "    texture_path: '{pz_root}/media/texturepacks'",
                '    texture_files:',
                '        - Tiles2x[.]floor.pack',
                '        - JumboTrees2x[.]pack',
                '        - JumboTreesBigs2x[.]pack',
                '        - Overlays2x[.]pack',
                '        - Tiles2x[.]pack',
                '',
            ]));
            $this->warn("Created missing {$vanilla}");
        }
    }

    private function generateConfig(string $serverPath, string $tilesPath, string $pzmapRoot): string
    {
        $mapOption = $this->option('map') ?: 'default';
        $workerCount = $this->detectCpuCores();
        $profile = strtolower((string) ($this->option('profile') ?: 'lite'));
        if (! in_array($profile, ['lite', 'full'], true)) {
            $profile = 'lite';
        }

        // lite = ground-biased, fewer high-zoom levels, low workers — safe for live servers
        // full = more building layers, more zoom detail (heavier disk/CPU)
        $layerRange = $profile === 'full' ? '[0, 1]' : '[0, 0]';
        $omitLevels = $profile === 'full' ? 3 : 5;
        $tileAlign = $profile === 'full' ? 3 : 2;

        $this->info("Using {$workerCount} render worker(s), profile={$profile} (disk-friendly; set --workers=N / --profile=full)");

        // Workshop content lives under the dedicated server install on this stack
        $modRoot = $serverPath.'/steamapps/workshop/content/108600';
        if (! is_dir($modRoot)) {
            $modRoot = $serverPath;
        }

        // Current pzmap2dzi expects output_root + default_b42.txt (not output_path / default.txt)
        $config = <<<YAML
# Auto-generated by zomboid:generate-map-tiles — do not hand-edit
# profile: {$profile}
pz_root: |-
    {$serverPath}

output_root: |-
    {$tilesPath}

mod_root: |-
    {$modRoot}

custom_root: |-
    .

save_game_root: |-
    /tmp/pz-saves-unused

output_entry: default
output_route: map_data/

# B42 map defaults (upstream renamed default.txt → default_b42.txt)
map_conf_default: default_b42.txt
map_conf:
    - vanilla.txt

use_depend_texture_only: false

base_map: {$mapOption}

mod_maps:

save_games: []

render_conf:
    verbose: true
    profile: false
    worker_count: {$workerCount}
    break_key: ''
    tile_size: 256
    tile_align_levels: {$tileAlign}
    # lite: ground only + more omit_levels = smaller/faster; full: ground+walls
    layer_range: {$layerRange}
    omit_levels: {$omitLevels}
    image_fmt: webp
    image_fmt_base_layer0: jpg
    image_save_options: {}
    enable_cache: false
    cache_limit_mb: 0
    top_view_square_size: 1
    top_view_color_mode: avg
    use_mark: false
    plants_conf:
        snow: false
        large_bush: false
        flower: false
        season: summer2
        tree_size: 2
        jumbo_tree_size: 4
        jumbo_tree_type: 1
        no_ground_cover: false
        unify_tree_type: 0
YAML;

        // Config must live in pzmap2dzi/conf/ so relative map_conf paths resolve
        $confDir = $pzmapRoot.'/conf';
        if (! is_dir($confDir)) {
            mkdir($confDir, 0755, true);
        }
        $confPath = $confDir.'/generated.yaml';
        file_put_contents($confPath, $config."\n");

        return $confPath;
    }

    /**
     * Prefix a shell command with nice/ionice so map gen yields disk to the game server.
     *
     * Default is best-effort low priority (class 2, level 7) — not idle class 3.
     * Idle class can make prepare/render appear stuck for hours while the game is online.
     */
    private function prefixLowIoPriority(string $command): string
    {
        if (! config('zomboid.map.generate_low_priority', true)) {
            return $command;
        }

        $nice = (int) config('zomboid.map.generate_nice', 15);
        $ioClass = (int) config('zomboid.map.generate_ionice_class', 2);
        $ioLevel = (int) config('zomboid.map.generate_ionice_level', 7);

        $prefix = '';
        if ($this->shellCommandExists('nice')) {
            $prefix .= 'nice -n '.$nice.' ';
        }
        if ($this->shellCommandExists('ionice')) {
            if ($ioClass === 3) {
                $prefix .= 'ionice -c 3 ';
            } else {
                $prefix .= 'ionice -c '.$ioClass.' -n '.$ioLevel.' ';
            }
        }

        return $prefix !== '' ? $prefix.$command : $command;
    }

    private function shellCommandExists(string $bin): bool
    {
        $out = [];
        $code = 1;
        @exec('command -v '.escapeshellarg($bin).' 2>/dev/null', $out, $code);

        return $code === 0 && ($out[0] ?? '') !== '';
    }

    /**
     * Heuristic: textures already unpacked under tiles or install tree.
     */
    private function textureUnpackLooksPresent(string $tilesPath, string $serverPath): bool
    {
        $candidates = [
            rtrim($tilesPath, '/').'/html/texture',
            rtrim($tilesPath, '/').'/texture',
            rtrim($serverPath, '/').'/media/texturepacks',
        ];
        foreach ($candidates as $dir) {
            if (is_dir($dir) && (glob($dir.'/*') ?: []) !== []) {
                return true;
            }
        }

        // Resume with an existing loose pyramid implies unpack already ran once
        return $this->tileStore->hasLooseTiles();
    }

    private function detectCpuCores(): int
    {
        // Prefer explicit low default — parallel workers saturate disks
        $configured = (int) config('zomboid.map.generate_workers', 1);
        if ($this->option('workers')) {
            return max(1, (int) $this->option('workers'));
        }

        if ($configured > 0) {
            return max(1, $configured);
        }

        $cores = 2;
        if (is_readable('/proc/cpuinfo')) {
            $cpuinfo = (string) file_get_contents('/proc/cpuinfo');
            $cores = max(1, substr_count($cpuinfo, 'processor'));
        }

        // Never use all cores by default
        return max(1, min(2, (int) floor($cores / 2)));
    }

    private function findPzmap2dzi(): ?string
    {
        // Docker image — installed via Dockerfile
        $dockerPath = '/opt/pzmap2dzi/main.py';
        if (is_file($dockerPath)) {
            return $dockerPath;
        }

        // Check if pzmap2dzi is in PATH
        exec('which pzmap2dzi 2>/dev/null', $output, $exitCode);
        if ($exitCode === 0 && ! empty($output[0])) {
            return $output[0];
        }

        // Check common pip install location
        // $_SERVER['HOME'] is populated by PHP from the environment — no system env() needed
        $home = $_SERVER['HOME'] ?? '';
        if ($home !== '') {
            $pipPath = $home.'/.local/bin/pzmap2dzi';
            if (is_file($pipPath)) {
                return $pipPath;
            }
        }

        // Check local copy in project
        $localPath = base_path('tools/pzmap2dzi/main.py');
        if (is_file($localPath)) {
            return $localPath;
        }

        return null;
    }
}
