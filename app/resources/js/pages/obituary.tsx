import { Head, Link } from '@inertiajs/react';
import { Bug, Flame, HelpCircle, MapPin, Skull, Swords } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslation } from '@/hooks/use-translation';
import PublicLayout from '@/layouts/public-layout';
import { formatRelativeTime } from '@/lib/dates';

type Death = {
    id: number;
    player: string;
    killer: string | null;
    cause: string;
    weapon: string | null;
    hours_survived: number | null;
    zombie_kills: number | null;
    x: number | null;
    y: number | null;
    died_at: string | null;
};

type Toll = {
    total: number;
    last_seven_days: number;
    by_cause: Record<string, number>;
};

type Props = {
    server_name: string;
    deaths: Death[];
    toll: Toll;
};

const causeIcons: Record<string, typeof Skull> = {
    player: Swords,
    infection: Bug,
    fire: Flame,
    unknown: HelpCircle,
};

const causeStyles: Record<string, string> = {
    player: 'text-red-500',
    infection: 'text-green-600 dark:text-green-500',
    fire: 'text-orange-500',
    unknown: 'text-muted-foreground',
};

function CauseIcon({ cause }: { cause: string }) {
    const Icon = causeIcons[cause] ?? HelpCircle;

    return <Icon className={`size-4 shrink-0 ${causeStyles[cause] ?? causeStyles.unknown}`} />;
}

function DeathRow({ death }: { death: Death }) {
    const { t } = useTranslation();

    /** A killer is only ever known for a PvP death; everything else reads as a cause. */
    const headline =
        death.cause === 'player' && death.killer
            ? t('obituary.killed_by', { player: death.player, killer: death.killer })
            : t(`obituary.cause.${death.cause}`, { player: death.player });

    return (
        <div className="flex items-start gap-3 border-b py-3 last:border-b-0">
            <CauseIcon cause={death.cause} />
            <div className="min-w-0 flex-1">
                <p className="text-sm">
                    <Link
                        href={`/rankings/${death.player}`}
                        className="font-medium underline-offset-4 hover:underline"
                    >
                        {death.player}
                    </Link>
                    <span className="text-muted-foreground"> — {headline}</span>
                </p>
                <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    {death.died_at && <span>{formatRelativeTime(death.died_at, t)}</span>}
                    {death.hours_survived !== null && death.hours_survived > 0 && (
                        <span>{t('obituary.survived', { hours: death.hours_survived.toFixed(1) })}</span>
                    )}
                    {death.zombie_kills !== null && death.zombie_kills > 0 && (
                        <span>{t('obituary.zombie_kills', { count: String(death.zombie_kills) })}</span>
                    )}
                    {death.weapon && <span>{death.weapon.replace(/^Base\./, '')}</span>}
                    {death.x !== null && death.y !== null && (
                        <span className="flex items-center gap-1">
                            <MapPin className="size-3" />
                            {death.x}, {death.y}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function Obituary({ server_name, deaths, toll }: Props) {
    const { t } = useTranslation();

    return (
        <PublicLayout>
            <Head title={t('obituary.title')} />

            <div className="mx-auto w-full max-w-4xl px-4 py-10">
                <div className="mb-8 text-center">
                    <Skull className="text-muted-foreground mx-auto mb-3 size-10" />
                    <h1 className="text-3xl font-bold tracking-tight">{t('obituary.title')}</h1>
                    <p className="text-muted-foreground mt-1 text-sm">
                        {t('obituary.description', { server: server_name })}
                    </p>
                </div>

                <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <Card>
                        <CardContent className="pt-6">
                            <p className="text-2xl font-bold">{toll.total}</p>
                            <p className="text-muted-foreground text-xs">{t('obituary.total_deaths')}</p>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardContent className="pt-6">
                            <p className="text-2xl font-bold">{toll.last_seven_days}</p>
                            <p className="text-muted-foreground text-xs">{t('obituary.this_week')}</p>
                        </CardContent>
                    </Card>
                    {Object.entries(toll.by_cause)
                        .slice(0, 2)
                        .map(([cause, count]) => (
                            <Card key={cause}>
                                <CardContent className="pt-6">
                                    <p className="flex items-center gap-2 text-2xl font-bold">
                                        <CauseIcon cause={cause} />
                                        {count}
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                        {t(`obituary.cause_label.${cause}`)}
                                    </p>
                                </CardContent>
                            </Card>
                        ))}
                </div>

                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">{t('obituary.recent')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {deaths.length > 0 ? (
                            <div>
                                {deaths.map((death) => (
                                    <DeathRow key={death.id} death={death} />
                                ))}
                            </div>
                        ) : (
                            <div className="py-10 text-center">
                                <Badge variant="secondary">{t('obituary.nobody_died')}</Badge>
                                <p className="text-muted-foreground mt-2 text-sm">
                                    {t('obituary.nobody_died_desc')}
                                </p>
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>
        </PublicLayout>
    );
}
