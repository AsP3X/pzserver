<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Http\Client\Pool;
use Illuminate\Support\Facades\Http;

class DownloadItemIcons extends Command
{
    /** @var string */
    protected $signature = 'zomboid:download-item-icons
        {--force : Re-download icons that already exist}
        {--catalog= : Path to items_catalog.json (default: from config)}
        {--concurrency=10 : Number of concurrent downloads per batch}';

    /** @var string */
    protected $description = 'Download PZ item icons from PZwiki into public/images/items/';

    private const PZWIKI_URL = 'https://pzwiki.net/wiki/Special:FilePath/';

    public function handle(): int
    {
        $catalogPath = $this->option('catalog') ?: config('zomboid.lua_bridge.items_catalog');
        $outputDir = public_path('images/items');
        $force = (bool) $this->option('force');
        $concurrency = max(1, (int) $this->option('concurrency'));

        if (! file_exists($catalogPath)) {
            $this->error("Item catalog not found at: {$catalogPath}");
            $this->info('The Lua mod exports this file on server startup. Start the game server first.');

            return self::FAILURE;
        }

        $catalog = json_decode(file_get_contents($catalogPath), true);
        if (json_last_error() !== JSON_ERROR_NONE || ! isset($catalog['items'])) {
            $this->error('Failed to parse item catalog JSON.');

            return self::FAILURE;
        }

        if (! is_dir($outputDir)) {
            mkdir($outputDir, 0755, true);
        }

        // Filter items that need downloading
        // Each entry tracks the output filename and the wiki name to try
        $toDownload = [];
        $skipped = 0;

        foreach ($catalog['items'] as $item) {
            $iconName = $item['icon_name'] ?? '';
            if ($iconName === '') {
                $skipped++;

                continue;
            }

            $outputPath = $outputDir.'/'.$iconName.'.png';
            if (! $force && file_exists($outputPath)) {
                $skipped++;

                continue;
            }

            // Prefer the texture_icon field (actual Icon= value from PZ scripts)
            // which maps directly to PZwiki filenames
            $textureIcon = $item['texture_icon'] ?? null;

            $toDownload[] = [
                'output_name' => $iconName,
                'wiki_name' => $textureIcon ?? preg_replace('/^Item_/', '', $iconName),
            ];
        }

        $total = count($catalog['items']);
        $downloadCount = count($toDownload);

        if ($downloadCount === 0) {
            $this->info("All {$total} icons already exist. Use --force to re-download.");

            return self::SUCCESS;
        }

        $this->info("Downloading {$downloadCount} icons ({$skipped} skipped, concurrency: {$concurrency})...");
        $bar = $this->output->createProgressBar($downloadCount);
        $bar->start();

        $downloaded = 0;
        $failed = 0;

        // Deduplicate by wiki_name to avoid fetching the same texture twice
        // Multiple items can share the same Icon (e.g. all Animal_Bowtie* use HatSantaRed)
        $seen = [];
        $deduplicated = [];
        foreach ($toDownload as $entry) {
            $wikiName = $entry['wiki_name'];
            if (! isset($seen[$wikiName])) {
                $seen[$wikiName] = [];
            }
            $seen[$wikiName][] = $entry['output_name'];
            if (count($seen[$wikiName]) === 1) {
                $deduplicated[] = $entry;
            }
        }

        // Process in batches
        $chunks = array_chunk($deduplicated, $concurrency);
        $chunkIndex = 0;

        while ($chunkIndex < count($chunks)) {
            $batch = $chunks[$chunkIndex];

            $responses = Http::pool(function (Pool $pool) use ($batch) {
                foreach ($batch as $entry) {
                    $url = self::PZWIKI_URL.$entry['wiki_name'].'.png';

                    $pool->as($entry['wiki_name'])
                        ->timeout(15)
                        ->withOptions(['allow_redirects' => true])
                        ->get($url);
                }
            });

            $rateLimited = false;
            $retryAfter = 0;

            foreach ($batch as $entry) {
                $wikiName = $entry['wiki_name'];
                $response = $responses[$wikiName];

                try {
                    if ($response->status() === 429) {
                        $rateLimited = true;
                        $retryAfter = max($retryAfter, (int) ($response->header('Retry-After') ?: 30));

                        continue;
                    }

                    if ($response->successful() && str_starts_with($response->header('Content-Type') ?? '', 'image/')) {
                        $imageData = $response->body();
                        // Save to all output names that share this texture
                        foreach ($seen[$wikiName] as $outputName) {
                            $outputPath = $outputDir.'/'.$outputName.'.png';
                            file_put_contents($outputPath, $imageData);
                        }
                        $downloaded += count($seen[$wikiName]);
                    } else {
                        $failed += count($seen[$wikiName]);
                    }
                } catch (\Throwable $e) {
                    $failed += count($seen[$wikiName]);
                }

                $bar->advance(count($seen[$wikiName]));
            }

            if ($rateLimited) {
                $waitSeconds = max($retryAfter, 10);
                $bar->clear();
                $this->warn("  Rate limited — waiting {$waitSeconds}s before retrying batch...");
                $bar->display();
                sleep($waitSeconds);

                // Retry the same batch (don't advance $chunkIndex)
                continue;
            }

            $chunkIndex++;
        }

        $bar->finish();
        $this->newLine(2);

        $this->info("Downloaded: {$downloaded}");
        $this->info("Skipped (existing): {$skipped}");
        if ($failed > 0) {
            $this->warn("Failed: {$failed}");
        }

        return self::SUCCESS;
    }
}
