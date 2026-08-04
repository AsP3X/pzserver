import { Activity, TrendingUp, Users } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslation } from '@/hooks/use-translation';

export type ServerHistory = {
    uptime: { day: number | null; week: number | null; month: number | null };
    peak_players: number;
    average_players: number;
    sample_count: number;
    population: { at: string; players: number; online: boolean }[];
};

export function UptimeHistorySkeleton() {
    return (
        <Card>
            <CardHeader>
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-64" />
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    {[0, 1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-14" />
                    ))}
                </div>
                <Skeleton className="h-24 w-full" />
            </CardContent>
        </Card>
    );
}

function UptimeFigure({ label, value }: { label: string; value: number | null }) {
    const { t } = useTranslation();

    return (
        <div>
            <p className="text-2xl font-bold tabular-nums">
                {value === null ? '—' : `${value.toFixed(value >= 99.95 ? 0 : 2)}%`}
            </p>
            <p className="text-muted-foreground text-xs">
                {value === null ? t('status.history.no_data') : label}
            </p>
        </div>
    );
}

/**
 * Population over the last day as a bar per sample. Deliberately not a charting
 * library: it is one series of small integers, and a div per bar renders it
 * without shipping another dependency.
 */
function PopulationBars({ population }: { population: ServerHistory['population'] }) {
    const { t } = useTranslation();

    if (population.length === 0) {
        return <p className="text-muted-foreground text-sm">{t('status.history.no_population')}</p>;
    }

    const peak = Math.max(1, ...population.map((point) => point.players));

    return (
        <div>
            <div className="flex h-24 items-end gap-px" role="img" aria-label={t('status.history.population')}>
                {population.map((point) => (
                    <div
                        key={point.at}
                        title={`${new Date(point.at).toLocaleString()} — ${point.players}`}
                        className={`flex-1 rounded-t-sm ${point.online ? 'bg-primary/70' : 'bg-destructive/40'}`}
                        style={{
                            /** Offline samples still get a sliver, so outages read as gaps rather than absence. */
                            height: point.online ? `${Math.max(2, (point.players / peak) * 100)}%` : '4px',
                        }}
                    />
                ))}
            </div>
            <p className="text-muted-foreground mt-2 text-xs">{t('status.history.last_24h')}</p>
        </div>
    );
}

export function UptimeHistory({ history }: { history: ServerHistory }) {
    const { t } = useTranslation();

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Activity className="size-4" />
                    {t('status.history.title')}
                </CardTitle>
                <CardDescription>{t('status.history.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <UptimeFigure label={t('status.history.uptime_day')} value={history.uptime.day} />
                    <UptimeFigure label={t('status.history.uptime_week')} value={history.uptime.week} />
                    <UptimeFigure label={t('status.history.uptime_month')} value={history.uptime.month} />
                    <div>
                        <p className="flex items-center gap-1.5 text-2xl font-bold tabular-nums">
                            <TrendingUp className="text-muted-foreground size-4" />
                            {history.peak_players}
                        </p>
                        <p className="text-muted-foreground text-xs">{t('status.history.peak_week')}</p>
                    </div>
                </div>

                <PopulationBars population={history.population} />

                <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <Users className="size-3" />
                    {t('status.history.average_week', { players: history.average_players.toFixed(1) })}
                </p>
            </CardContent>
        </Card>
    );
}
