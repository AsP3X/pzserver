<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;

class GenerateMapTiles extends Command
{
    /** @var string */
    protected $signature = 'zomboid:generate-map-tiles
        {--force : Regenerate tiles even if they already exist}
        {--map= : Specific map name to generate (default: all)}
        {--workers= : Number of render workers (default: auto-detect CPU cores)}';

    /** @var string */
    protected $description = 'Generate DZI map tiles from PZ game data using pzmap2dzi';

    public function handle(): int
    {
        $tilesPath = config('zomboid.map.tiles_path');
        $serverPath = config('zomboid.game_server_path');

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

        // Check if tiles already exist
        if (! $this->option('force') && is_dir($tilesPath) && count(scandir($tilesPath)) > 2) {
            $this->warn('Tiles already exist. Use --force to regenerate.');

            return self::SUCCESS;
        }

        // Create output directory
        if (! is_dir($tilesPath)) {
            mkdir($tilesPath, 0755, true);
        }

        // Generate pzmap2dzi config
        $confPath = $this->generateConfig($serverPath, $tilesPath);
        $this->info("Generated config: {$confPath}");

        // Step 1: Unpack textures
        $this->info('Step 1/2: Unpacking textures...');
        if (! $this->runPzmap($pzmap2dziPath, $confPath, 'unpack')) {
            return self::FAILURE;
        }

        // Step 2: Render isometric tiles
        $this->info('Step 2/2: Rendering isometric tiles...');
        if (! $this->runPzmap($pzmap2dziPath, $confPath, 'render base')) {
            return self::FAILURE;
        }

        $this->info('Map tiles generated successfully at: '.$tilesPath);

        return self::SUCCESS;
    }

    private function runPzmap(string $pzmap2dziPath, string $confPath, string $subcommand): bool
    {
        $pzmap2dziDir = dirname($pzmap2dziPath);
        $logFile = storage_path('logs/pzmap2dzi.log');
        $command = sprintf(
            'cd %s && python3 %s -c %s %s > %s 2>&1',
            escapeshellarg($pzmap2dziDir),
            escapeshellarg($pzmap2dziPath),
            escapeshellarg($confPath),
            $subcommand,
            escapeshellarg($logFile),
        );

        $this->line("Running: {$command}");
        $this->line("Output logged to: {$logFile}");

        $result = 0;
        exec($command, $output, $result);

        if ($result !== 0) {
            $this->error("pzmap2dzi '{$subcommand}' failed with exit code: {$result}");
            if (is_file($logFile)) {
                // Show last 20 lines of the log for debugging
                $lines = file($logFile);
                $tail = array_slice($lines, -20);
                $this->error(implode('', $tail));
            }

            return false;
        }

        $this->info("Completed: {$subcommand}");

        return true;
    }

    private function generateConfig(string $serverPath, string $tilesPath): string
    {
        $mapOption = $this->option('map') ?: 'default';
        $workerCount = (int) ($this->option('workers') ?: $this->detectCpuCores());

        $this->info("Using {$workerCount} render workers");

        $config = <<<YAML
        pz_root: |-
            {$serverPath}

        output_path: |-
            {$tilesPath}

        output_entry: default
        output_route: map_data/

        map_conf_default: default.txt
        map_conf:
            - vanilla.txt

        base_map: {$mapOption}

        render_conf:
            verbose: true
            profile: false
            worker_count: {$workerCount}
            break_key: ''
            tile_size: 256
            tile_align_levels: 3
            # Fast preview mode: render only base ground layer.
            layer_range: [0, 1]
            omit_levels: 3
            image_fmt: jpg
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
                jumbo_tree_type: 0
                no_ground_cover: false
                unify_tree_type: -1
        YAML;

        // Config must live in pzmap2dzi/conf/ so relative map_conf paths resolve
        $confDir = dirname($this->findPzmap2dzi()).'/conf';
        $confPath = $confDir.'/generated.yaml';
        file_put_contents($confPath, $config);

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
