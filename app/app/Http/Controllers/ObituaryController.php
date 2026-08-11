<?php

namespace App\Http\Controllers;

use App\Models\GameEvent;
use App\Services\MapConfigBuilder;
use Inertia\Inertia;
use Inertia\Response;

/**
 * The public memorial: who died, when, and to what.
 *
 * Deaths reach game_events from two places — the server log records that a
 * death happened, the Lua mod records why — so a row may or may not carry a
 * cause depending on which server the site is pointed at.
 */
class ObituaryController extends Controller
{
    private const PAGE_SIZE = 30;

    public function __construct(
        private readonly MapConfigBuilder $mapConfigBuilder,
    ) {}

    public function __invoke(): Response
    {
        $mapConfig = $this->mapConfigBuilder->build();

        return Inertia::render('obituary', [
            'server_name' => config('zomboid.server_name', 'Project Zomboid Server'),
            'deaths' => $this->recentDeaths(),
            'toll' => $this->toll(),
            /**
             * The list already carries every death's coordinates; the map is
             * the same rows plotted, so where the server kills people reads at
             * a glance instead of one row at a time.
             */
            'mapConfig' => $mapConfig,
            'hasTiles' => (bool) ($mapConfig['hasBasemap'] ?? false),
        ]);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function recentDeaths(): array
    {
        return GameEvent::query()
            ->where('event_type', 'death')
            ->latest('game_time')
            ->limit(self::PAGE_SIZE)
            ->get()
            ->map(fn (GameEvent $event) => [
                'id' => $event->id,
                'player' => $event->player,
                'killer' => $event->details['killer'] ?? null,
                'cause' => $event->details['cause'] ?? 'unknown',
                'weapon' => $event->details['weapon'] ?? null,
                'hours_survived' => $event->details['hours_survived'] ?? null,
                'zombie_kills' => $event->details['zombie_kills'] ?? null,
                'x' => $event->x,
                'y' => $event->y,
                'died_at' => $event->game_time?->toIso8601String(),
            ])
            ->all();
    }

    /**
     * @return array{total: int, last_seven_days: int, by_cause: array<string, int>}
     */
    private function toll(): array
    {
        $deaths = GameEvent::query()->where('event_type', 'death');

        $byCause = [];
        foreach ((clone $deaths)->get(['details']) as $event) {
            $cause = $event->details['cause'] ?? 'unknown';
            $byCause[$cause] = ($byCause[$cause] ?? 0) + 1;
        }

        arsort($byCause);

        return [
            'total' => (clone $deaths)->count(),
            'last_seven_days' => (clone $deaths)->where('game_time', '>=', now()->subDays(7))->count(),
            'by_cause' => $byCause,
        ];
    }
}
