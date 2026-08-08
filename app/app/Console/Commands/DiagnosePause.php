<?php

namespace App\Console\Commands;

use App\Services\GameStateReader;
use App\Services\OnlinePlayersReader;
use App\Services\ServerIniParser;
use Illuminate\Console\Command;
use Illuminate\Support\Sleep;

/**
 * Answers "does this server actually pause when empty?" with measurement
 * instead of guesswork.
 *
 * `PauseEmpty=true` in the INI is necessary but not sufficient, and PZ 42 has
 * two separate gates that do not agree:
 *
 *   The world clock, in GameTime.isGamePaused():
 *       GameServer.Players.isEmpty() && ServerOptions.pauseEmpty.getValue()
 *
 *   The world simulation, in IngameState.updateInternal(), which adds:
 *       && ZombiePopulationManager.readyToPause()   // native, libPZPopMan64.so
 *
 * So an advancing clock and a still-simulating world are different faults. The
 * clock is the useful signal: it moves only when Players is non-empty or the
 * option is off in memory. Note that RCON `players` counts
 * udpEngine.connections, a different list from GameServer.Players, so it can
 * report an empty server while the pause gate disagrees.
 *
 * The probe: the Knox Relay bridge exports game_state.json from EveryOneMinute,
 * which is an *in-game* time hook. A paused server advances no clock, so both
 * the world clock and the export timestamp stand still. Sample twice and see
 * whether the clock moved while nobody was connected.
 */
class DiagnosePause extends Command
{
    protected $signature = 'zomboid:diagnose-pause {--seconds=150 : Real seconds to wait between the two clock samples}';

    protected $description = 'Check whether the server really pauses when empty (PauseEmpty + the native popman gate)';

    public function handle(
        ServerIniParser $iniParser,
        OnlinePlayersReader $playersReader,
        GameStateReader $stateReader,
    ): int {
        $pauseEmpty = $this->readPauseEmpty($iniParser);

        $this->line('Config layer');
        $this->line('  PauseEmpty in server.ini: '.($pauseEmpty ?? '<missing>'));

        if ($pauseEmpty === null) {
            $this->error('Could not read server.ini. Is the config volume mounted?');

            return self::FAILURE;
        }

        if (strtolower($pauseEmpty) !== 'true') {
            $this->warn('PauseEmpty is not enabled — nothing to diagnose. Enable it in Admin → Config, then restart the game server.');

            return self::FAILURE;
        }

        $online = $playersReader->getOnlinePlayers();
        $this->newLine();
        $this->line('Player layer');
        $this->line('  Online players: '.count($online['usernames']).' (source: '.$online['source'].')');

        if ($online['usernames'] !== []) {
            $this->warn('Players are connected, so the server is expected to run. Re-run this when the server is empty.');

            return self::FAILURE;
        }

        $first = $stateReader->getGameState();

        if ($first === null) {
            $this->newLine();
            $this->error('No usable game_state.json — the Knox Relay bridge is not exporting.');
            $this->line('  Without it there is no clock to sample. Check Admin → Lua Bridge first.');

            return self::FAILURE;
        }

        $seconds = max(30, (int) $this->option('seconds'));

        $this->newLine();
        $this->line('Clock layer');
        $this->line('  In-game clock now: '.$this->describe($first));
        $this->line("  Sampling again in {$seconds}s...");

        Sleep::for($seconds)->seconds();

        $second = $stateReader->getGameState();

        if ($second === null) {
            $this->error('  Second sample unreadable — bridge export broke mid-check.');

            return self::FAILURE;
        }

        $this->line('  In-game clock after: '.$this->describe($second));

        $moved = $this->minutesElapsed($first, $second);
        $this->newLine();

        if ($moved === 0) {
            $this->info('PAUSED. The world clock did not advance while the server was empty.');
            $this->line('  The Knox Relay bridge is frozen too, so shop deliveries and vault');
            $this->line('  deposits will not process until someone logs in.');
            $this->line('  If zombies still move despite the frozen clock, that is the separate');
            $this->line('  ZombiePopulationManager.readyToPause() gate — native, and not');
            $this->line('  influenced by any panel or INI setting.');

            return self::SUCCESS;
        }

        $this->error('NOT PAUSED. The world clock advanced on an empty server.');
        $this->line("  Moved {$moved} in-game minutes with zero players online.");
        $this->newLine();
        $this->line('  The clock only advances while GameTime.isGamePaused() is false, so');
        $this->line('  either pauseEmpty is off in memory or GameServer.Players is not empty.');
        $this->newLine();
        $this->line('  Most likely, in order:');
        $this->line('  1. The game server has not restarted since PauseEmpty was enabled. PZ');
        $this->line('     reads server.ini only at startup. Restart it, then re-run this.');
        $this->line('  2. A stale character is left in GameServer.Players (a "ghost"). RCON');
        $this->line('     "players" reads udpEngine.connections — a different list — so it can');
        $this->line('     report zero while the pause gate still sees somebody. No RCON command');
        $this->line('     exposes the pause list; a game-server restart clears it.');

        return self::FAILURE;
    }

    /**
     * Raw PauseEmpty value from the INI, or null when the file is unreadable.
     */
    private function readPauseEmpty(ServerIniParser $iniParser): ?string
    {
        try {
            $config = $iniParser->read(config('zomboid.paths.server_ini'));
        } catch (\Throwable) {
            return null;
        }

        return $config['PauseEmpty'] ?? null;
    }

    /**
     * @param  array<string, mixed>  $state
     */
    private function describe(array $state): string
    {
        $time = $state['time'];

        return sprintf(
            '%s %s (exported %s)',
            $time['date'] ?? '?',
            $time['formatted'] ?? '?',
            $state['exported_at'] ?? '?',
        );
    }

    /**
     * In-game minutes between two exports. Uses year + day-of-year + clock so a
     * rollover past midnight or new year still reads as forward movement.
     *
     * @param  array<string, mixed>  $first
     * @param  array<string, mixed>  $second
     */
    private function minutesElapsed(array $first, array $second): int
    {
        return max(0, $this->absoluteMinutes($second) - $this->absoluteMinutes($first));
    }

    /**
     * @param  array<string, mixed>  $state
     */
    private function absoluteMinutes(array $state): int
    {
        $time = $state['time'];

        return ((int) ($time['year'] ?? 0)) * 366 * 24 * 60
            + ((int) ($time['day_of_year'] ?? 0)) * 24 * 60
            + ((int) ($time['hour'] ?? 0)) * 60
            + (int) ($time['minute'] ?? 0);
    }
}
