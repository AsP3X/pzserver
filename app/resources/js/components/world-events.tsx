import { Droplets, Plane, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslation } from '@/hooks/use-translation';
import type { UtilityState, WorldEvents as WorldEventsData } from '@/types/server';

function UtilityRow({
    icon,
    label,
    state,
}: {
    icon: React.ReactNode;
    label: string;
    state: UtilityState;
}) {
    const { t } = useTranslation();

    /** Under a fortnight is close enough that players should be stockpiling. */
    const soon = state.status === 'on' && state.days_remaining !== null && state.days_remaining <= 14;

    return (
        <div className="flex items-center justify-between gap-3 border-b py-2.5 last:border-b-0">
            <span className="flex items-center gap-2 text-sm">
                {icon}
                {label}
            </span>
            {state.status === 'off' ? (
                <Badge variant="destructive">{t('world_events.cut')}</Badge>
            ) : state.status === 'unknown' ? (
                <span className="text-muted-foreground text-xs">{t('world_events.unknown')}</span>
            ) : (
                <span className={`text-xs tabular-nums ${soon ? 'font-medium text-yellow-600 dark:text-yellow-500' : 'text-muted-foreground'}`}>
                    {state.days_remaining === null
                        ? t('world_events.on')
                        : t('world_events.days_left', { days: state.days_remaining.toFixed(0) })}
                </span>
            )}
        </div>
    );
}

export function WorldEvents({ events }: { events: WorldEventsData }) {
    const { t } = useTranslation();
    const helicopter = events.helicopter;

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('world_events.title')}</CardTitle>
                <CardDescription>
                    {events.day === null
                        ? t('world_events.description')
                        : t('world_events.day', { day: events.day.toFixed(0) })}
                </CardDescription>
            </CardHeader>
            <CardContent>
                <UtilityRow
                    icon={<Zap className="text-muted-foreground size-4" />}
                    label={t('world_events.electricity')}
                    state={events.electricity}
                />
                <UtilityRow
                    icon={<Droplets className="text-muted-foreground size-4" />}
                    label={t('world_events.water')}
                    state={events.water}
                />
                {helicopter && (
                    <div className="flex items-center justify-between gap-3 py-2.5">
                        <span className="flex items-center gap-2 text-sm">
                            <Plane className="text-muted-foreground size-4" />
                            {t('world_events.helicopter')}
                        </span>
                        {helicopter.today ? (
                            <Badge variant="destructive">{t('world_events.helicopter_today')}</Badge>
                        ) : helicopter.days_away > 0 ? (
                            <span className="text-muted-foreground text-xs tabular-nums">
                                {t('world_events.days_left', { days: String(helicopter.days_away) })}
                            </span>
                        ) : (
                            <span className="text-muted-foreground text-xs">{t('world_events.passed')}</span>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
