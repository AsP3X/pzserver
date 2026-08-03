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
        {--map= : Specific map name to generate (default: all)}
        {--workers= : Number of render workers (default: auto-detect CPU cores)}
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

        if (! is_dir($serverPath)) {
            $this->error("Game server path does not exist: {$serverPath}");

            return self::FAILURE;
        }

        if (! is_dir($serverPath.'/media')) {
            $this->error("Game server files not ready yet (no media/ directory in {$serverPath})");

            return self::FAILURE;
        }

        // Check Python3 availability
        exec('python3 --version 2>&1', $output, $exitCode);
        if ($exitCode !== 0) {
            $this->error('Python3 is required but not found.');

            return self::FAILURE;
        }

        $this->info('Python3 found: '.($output[0] ?? 'unknown version'));

        // Check for pzmap2dzi
        $pzmap2dziPath = $this->findPzmap2dzi();
        if ($pzmap2dziPath === null) {
            $this->error('pzmap2dzi not found.');

            return self::FAILURE;
        }

        $this->info("Using pzmap2dzi: {$pzmap2dziPath}");

        $pzmapRoot = dirname($pzmap2dziPath);
        $this->ensureMapConfDefaults($pzmapRoot);

        $hasPacked = $this->tileStore->hasPackedTiles();
        $hasLoose = $this->tileStore->hasLooseTiles();

        // Default: skip only when a finished pack exists (not a partial loose pyramid)
        if (! $force && ! $resume && $hasPacked && ! $hasLoose) {
            $this->warn('Packed tiles already exist. Use --force to regenerate, or --resume after a partial run.');

            return self::SUCCESS;
        }

        // Auto-resume when loose pyramid remains from an interrupted run
        if (! $force && ! $resume && $hasLoose) {
            $resume = true;
            $this->info('Partial/loose tile pyramid detected — resuming (incremental render, no wipe).');
        }

        if ($resume && $hasPacked && ! $hasLoose) {
            $this->warn('Nothing to resume: only a finished pack is present. Use --force to regenerate from scratch.');

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
        $this->progress->start([
            'stage' => 'starting',
            'step' => 0,
            'steps' => 3,
            'message' => $resume ? 'Resuming map tile generation…' : 'Starting map tile generation…',
        ]);

        if ($force) {
            $this->info('Clearing previous tiles...');
            $this->progress->update([
                'stage' => 'clear',
                'step' => 0,
                'message' => 'Clearing previous tiles…',
            ]);
            $this->tileStore->clearAll();
        }

        // Generate pzmap2dzi config
        $confPath = $this->generateConfig($serverPath, $tilesPath, $pzmapRoot);
        $this->info("Generated config: {$confPath}");

        // Step 1: Unpack textures
        $this->info('Step 1/3: Unpacking textures...');
        $this->progress->update([
            'stage' => 'unpack',
            'step' => 1,
            'steps' => 3,
            'message' => 'Unpacking textures…',
            'completed' => 0,
            'total' => 0,
        ]);
        if (! $this->runPzmap($pzmap2dziPath, $confPath, 'unpack', trackJobProgress: false)) {
            if ($this->wasStopped) {
                return $this->finishInterrupted();
            }
            $this->progress->finish(false, 'Unpack failed.', 'pzmap2dzi unpack failed');

            return self::FAILURE;
        }
        $this->newLine();

        // Step 2: Render isometric tiles (base layer) — creates many small files temporarily
        $this->info('Step 2/3: Rendering isometric tiles (temporary multi-file pyramid)...');
        $this->info('Tip: stop safely with: php artisan zomboid:generate-map-tiles --stop  (or Admin → Stop)');
        $this->info('Resume later with: php artisan zomboid:generate-map-tiles --resume');
        $this->progress->update([
            'stage' => 'render',
            'step' => 2,
            'steps' => 3,
            'message' => $resume ? 'Resuming isometric render…' : 'Rendering isometric tiles…',
            'completed' => 0,
            'total' => 0,
        ]);
        if (! $this->runPzmap($pzmap2dziPath, $confPath, 'render base', trackJobProgress: true)) {
            if ($this->wasStopped) {
                return $this->finishInterrupted();
            }
            $this->progress->finish(false, 'Render failed.', 'pzmap2dzi render base failed');

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
            $this->progress->finish(false, 'Packing failed.', 'Failed to pack tiles into SQLite');

            return self::FAILURE;
        }
        $this->newLine();

        $this->progress->clearStopRequest();
        $this->progress->finish(true, 'Map tiles ready at '.$this->tileStore->packPath());
        $this->info('Map tiles ready at: '.$this->tileStore->packPath());
        $this->info('Loose tile files were packed away so backups/deletes stay fast.');
        $this->info('Total time: '.$this->formatElapsed(microtime(true) - $this->startedAt));

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
        $this->info('Clearing map tiles, progress, and stop/lock flags...');
        $this->tileStore->clearAll();
        $this->progress->clear();
        $this->progress->clearStopRequest();
        $lock = $this->progress->lockPath();
        if (is_file($lock)) {
            @unlink($lock);
        }
        $this->info('Cleared: '.$this->tileStore->rootPath());

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
        @file_put_contents($logFile, '');

        $command = sprintf(
            'cd %s && python3 %s -c %s %s',
            escapeshellarg($pzmap2dziDir),
            escapeshellarg($pzmap2dziPath),
            escapeshellarg($confPath),
            $subcommand,
        );

        $this->line("Running: {$command}");
        $this->line("Output logged to: {$logFile}");
        if ($trackJobProgress) {
            $this->line('Progress updates every ~1s from pzmap2dzi (job: done/total).');
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
            exec($command.' > '.escapeshellarg($logFile).' 2>&1', $output, $result);

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

            usleep(1000000); // 1s
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

        $now = time();
        if ($now - $this->lastDiskCountAt >= 10) {
            $this->lastTilesOnDisk = $this->progress->countLooseTiles($this->tileStore->looseLayerPath());
            $this->lastDiskCountAt = $now;
        }

        $completed = $job['done'] ?? 0;
        $total = $job['total'] ?? 0;
        $percent = $total > 0 ? (int) round(100 * $completed / $total) : 0;

        $this->progress->update([
            'stage' => 'render',
            'step' => 2,
            'steps' => 3,
            'message' => $total > 0
                ? sprintf('Rendering tiles %s / %s…', number_format($completed), number_format($total))
                : 'Rendering isometric tiles (planning / preparing)…',
            'completed' => $completed,
            'total' => $total,
            'tiles_on_disk' => $this->lastTilesOnDisk,
        ]);

        if ($total > 0) {
            $this->writeCliStatus(sprintf(
                '[render] job %s / %s (%d%%)  files on disk ~%s  elapsed %s',
                number_format($completed),
                number_format($total),
                $percent,
                number_format($this->lastTilesOnDisk),
                $this->formatElapsed(microtime(true) - $this->startedAt),
            ));
        } else {
            $this->writeCliStatus(sprintf(
                '[render] preparing…  files on disk ~%s  elapsed %s',
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
        $workerCount = (int) ($this->option('workers') ?: $this->detectCpuCores());

        $this->info("Using {$workerCount} render workers");

        // Workshop content lives under the dedicated server install on this stack
        $modRoot = $serverPath.'/steamapps/workshop/content/108600';
        if (! is_dir($modRoot)) {
            $modRoot = $serverPath;
        }

        // Current pzmap2dzi expects output_root + default_b42.txt (not output_path / default.txt)
        $config = <<<YAML
# Auto-generated by zomboid:generate-map-tiles — do not hand-edit
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
    tile_align_levels: 3
    # Preview-quality: ground layers only (full map = all, much slower/larger)
    layer_range: [0, 1]
    omit_levels: 3
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

    private function detectCpuCores(): int
    {
        $cores = 4;

        if (is_readable('/proc/cpuinfo')) {
            $cpuinfo = file_get_contents('/proc/cpuinfo');
            $cores = substr_count($cpuinfo, 'processor');
        }

        return max(1, $cores);
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
        $pipPath = getenv('HOME').'/.local/bin/pzmap2dzi';
        if (is_file($pipPath)) {
            return $pipPath;
        }

        // Check local copy in project
        $localPath = base_path('tools/pzmap2dzi/main.py');
        if (is_file($localPath)) {
            return $localPath;
        }

        return null;
    }
}
