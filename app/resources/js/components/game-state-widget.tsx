import {
    AlertTriangle,
    Cloud,
    CloudDrizzle,
    CloudFog,
    CloudRain,
    Flower2,
    Leaf,
    Moon,
    Pause,
    Snowflake,
    Sun,
    Thermometer,
    TreeDeciduous,
} from 'lucide-react';
import { useTranslation } from '@/hooks/use-translation';
import type { GameState } from '@/types';

const seasonConfig = {
    spring: { icon: Flower2, labelKey: 'game_state.spring', color: 'text-green-500' },
    summer: { icon: Sun, labelKey: 'game_state.summer', color: 'text-yellow-500' },
    autumn: { icon: Leaf, labelKey: 'game_state.autumn', color: 'text-orange-500' },
    winter: { icon: Snowflake, labelKey: 'game_state.winter', color: 'text-blue-400' },
};

const weatherIcons: Record<string, typeof Sun> = {
    clear: Sun,
    rain: CloudDrizzle,
    heavy_rain: CloudRain,
    fog: CloudFog,
    snow: Snowflake,
    night: Moon,
};

const weatherLabelKeys: Record<string, string> = {
    clear: 'game_state.clear',
    rain: 'game_state.rain',
    heavy_rain: 'game_state.heavy_rain',
    fog: 'game_state.fog',
    snow: 'game_state.snow',
    night: 'game_state.night',
};

export function GameStateWidget({
    gameState,
    stale = false,
}: {
    gameState: GameState | null;
    /** The bridge has stopped writing — everything below is a last-known value. */
    stale?: boolean;
}) {
    const { t } = useTranslation();

    // Partial/empty bridge files (e.g. 0-byte game_state.json) must not crash the page
    const time = gameState?.time;
    if (!gameState || !time || typeof time.is_night !== 'boolean') {
        return (
            <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card px-4 py-3">
                <TreeDeciduous className="size-5 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{t('game_state.unavailable')}</span>
            </div>
        );
    }

    const season = gameState.season;
    const weather = gameState.weather;
    const SeasonIcon = seasonConfig[season as keyof typeof seasonConfig]?.icon ?? Sun;
    const seasonColor = seasonConfig[season as keyof typeof seasonConfig]?.color ?? 'text-muted-foreground';
    const seasonLabel = season && seasonConfig[season as keyof typeof seasonConfig]
        ? t(seasonConfig[season as keyof typeof seasonConfig].labelKey)
        : (season ?? '');

    const WeatherIcon = weather ? (weatherIcons[weather.condition] ?? Cloud) : Cloud;
    const weatherLabel = weather && weatherLabelKeys[weather.condition]
        ? t(weatherLabelKeys[weather.condition])
        : weather?.condition?.replace('_', ' ') ?? '';

    return (
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border/50 bg-card px-4 py-3">
            {/* In-game time */}
            <div className="flex items-center gap-2">
                {time.is_night ? (
                    <Moon className="size-4 text-indigo-400" />
                ) : (
                    <Sun className="size-4 text-yellow-500" />
                )}
                <div>
                    <span className="font-semibold tabular-nums">{time.formatted ?? '—'}</span>
                    <span className="ml-1.5 text-sm text-muted-foreground">
                        {typeof time.world_day === 'number'
                            ? t('game_state.day', { day: String(time.world_day) })
                            : (time.date ?? '')}
                    </span>
                </div>
            </div>

            <div className="h-5 w-px bg-border" />

            {/* Season */}
            <div className="flex items-center gap-1.5">
                <SeasonIcon className={`size-4 ${seasonColor}`} />
                <span className="text-sm">{seasonLabel}</span>
            </div>

            {weather && (
                <>
                    <div className="h-5 w-px bg-border" />

                    {/* Weather condition */}
                    <div className="flex items-center gap-1.5">
                        <WeatherIcon className="size-4 text-muted-foreground" />
                        <span className="text-sm">{weatherLabel}</span>
                    </div>

                    <div className="h-5 w-px bg-border" />

                    {/* Temperature */}
                    <div className="flex items-center gap-1">
                        <Thermometer className="size-4 text-muted-foreground" />
                        <span className="text-sm font-medium tabular-nums">
                            {weather.temperature}°C
                        </span>
                    </div>
                </>
            )}

            {/*
                Why the numbers above are standing still. A stale bridge and a
                paused world look identical otherwise, and both look like a bug.
            */}
            {stale ? (
                <>
                    <div className="h-5 w-px bg-border" />
                    <div className="flex items-center gap-1.5" title={t('game_state.stale_hint')}>
                        <AlertTriangle className="size-4 text-amber-500" />
                        <span className="text-sm text-amber-500">{t('game_state.stale')}</span>
                    </div>
                </>
            ) : gameState.paused ? (
                <>
                    <div className="h-5 w-px bg-border" />
                    <div className="flex items-center gap-1.5" title={t('game_state.paused_hint')}>
                        <Pause className="size-4 text-muted-foreground" />
                        <span className="text-sm text-muted-foreground">{t('game_state.paused')}</span>
                    </div>
                </>
            ) : null}
        </div>
    );
}
