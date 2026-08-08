import { Head, usePoll } from '@inertiajs/react';
import { Activity, Clock, Droplet, HeartPulse, Skull, Snowflake, Swords, UserX } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { LiveSnapshotNotice } from '@/components/live-snapshot-notice';
import { categoriseSkills, SkillBar } from '@/components/skill-list';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslation } from '@/hooks/use-translation';
import AppLayout from '@/layouts/app-layout';
import { formatRelativeTime } from '@/lib/dates';
import { formatHours, loadHoursMode } from '@/lib/hours-format';
import type { HoursMode } from '@/lib/hours-format';
import type { BreadcrumbItem } from '@/types';

type Trait = {
    id: string;
    label: string;
};

type Vitals = {
    health: number | null;
    bleeding_parts: number;
    infected: boolean;
    has_cold: boolean;
};

type Character = {
    username: string;
    zombie_kills: number;
    hours_survived: number;
    profession: string | null;
    skills: Record<string, number>;
    /** Null when the server runs a KnoxRelay older than 1.3. */
    traits: Trait[] | null;
    vitals: Vitals | null;
    is_dead: boolean;
    updated_at: string | null;
};

type Props = {
    username: string | null;
    hasPzAccount: boolean;
    isOnline: boolean;
    character: Character | null;
    /** When the mod last wrote the export, in real time. Null if it never has. */
    snapshotAt: string | null;
    day_length_minutes: number;
};

function StatTile({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
    return (
        <Card>
            <CardContent className="flex items-center gap-3 pt-6">
                {icon}
                <div>
                    <p className="text-2xl font-bold">{value}</p>
                    <p className="text-muted-foreground text-xs">{label}</p>
                </div>
            </CardContent>
        </Card>
    );
}

function EmptyState({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
    return (
        <Card>
            <CardContent className="py-12">
                <div className="flex flex-col items-center gap-3 text-center">
                    {icon}
                    <div>
                        <p className="font-medium">{title}</p>
                        <p className="text-muted-foreground text-sm">{description}</p>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

/** Green above two thirds, amber above a third, red below it. */
function healthColour(health: number): string {
    if (health >= 66) return 'bg-green-500';
    if (health >= 33) return 'bg-yellow-500';

    return 'bg-red-500';
}

export default function PortalCharacter({
    username,
    hasPzAccount,
    isOnline,
    character,
    snapshotAt,
    day_length_minutes,
}: Props) {
    const { t } = useTranslation();
    const [hoursMode, setHoursMode] = useState<HoursMode>('ingame');

    usePoll(5000, { only: ['character', 'isOnline', 'snapshotAt'] });

    /**
     * The stored preference lives in localStorage, which the SSR pass cannot
     * read. Reading it lazily would render 'ingame' on the server and possibly
     * 'real' on the client, so it is applied after hydration instead.
     */
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setHoursMode(loadHoursMode());
    }, []);

    const categorisedSkills = useMemo(() => categoriseSkills(character?.skills ?? {}), [character?.skills]);

    const breadcrumbs: BreadcrumbItem[] = [
        { title: t('portal.title'), href: '/portal' },
        { title: t('portal.character.breadcrumb'), href: '/portal/character' },
    ];

    const vitals = character?.vitals ?? null;

    /**
     * While the player is in the game the mod re-exports them every cycle, so
     * the export's age is their data's age. Once they log out they drop out of
     * the export while it keeps moving for everyone still playing — then the
     * row's own last change is the only honest answer.
     */
    const freshAt = (isOnline ? snapshotAt : null) ?? character?.updated_at ?? null;

    return (
        <AppLayout breadcrumbs={breadcrumbs}>
            <Head title={t('portal.character.title')} />

            <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">{t('portal.character.title')}</h1>
                        <p className="text-muted-foreground text-sm">
                            {username
                                ? t('portal.character.description', { username })
                                : t('portal.character.description_generic')}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {character?.is_dead && <Badge variant="destructive">{t('common.dead')}</Badge>}
                        <Badge variant="secondary">{isOnline ? t('common.online') : t('common.offline')}</Badge>
                    </div>
                </div>

                {!hasPzAccount ? (
                    <EmptyState
                        icon={<UserX className="text-muted-foreground size-8" />}
                        title={t('portal.inventory.no_account')}
                        description={t('portal.inventory.no_account_desc')}
                    />
                ) : !character ? (
                    <EmptyState
                        icon={<Activity className="text-muted-foreground size-8" />}
                        title={t('portal.character.no_data')}
                        description={t('portal.character.no_data_desc')}
                    />
                ) : (
                    <>
                        {freshAt && (
                            <LiveSnapshotNotice
                                isLive={isOnline}
                                liveLabel={t('portal.character.live', {
                                    time: formatRelativeTime(freshAt, t),
                                })}
                                staleTitle={t('portal.character.stale_title')}
                                staleDescription={t('portal.character.stale_desc', {
                                    time: formatRelativeTime(freshAt, t),
                                })}
                            />
                        )}

                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                            <StatTile
                                icon={<Swords className="text-muted-foreground size-5" />}
                                value={character.zombie_kills.toLocaleString()}
                                label={t('portal.character.zombie_kills')}
                            />
                            <StatTile
                                icon={<Clock className="text-muted-foreground size-5" />}
                                value={formatHours(character.hours_survived, hoursMode, day_length_minutes)}
                                label={t('portal.character.hours_survived')}
                            />
                            <StatTile
                                icon={<Skull className="text-muted-foreground size-5" />}
                                value={character.profession ?? t('portal.character.no_profession')}
                                label={t('portal.character.profession')}
                            />
                        </div>

                        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle>{t('portal.character.condition')}</CardTitle>
                                    <CardDescription>{t('portal.character.condition_desc')}</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    {vitals === null ? (
                                        <p className="text-muted-foreground text-sm">
                                            {t('portal.character.needs_newer_mod')}
                                        </p>
                                    ) : (
                                        <>
                                            {vitals.health !== null && (
                                                <div className="space-y-1.5">
                                                    <div className="flex items-center justify-between text-sm">
                                                        <span className="flex items-center gap-1.5">
                                                            <HeartPulse className="size-4" />
                                                            {t('portal.character.health')}
                                                        </span>
                                                        <span className="tabular-nums">
                                                            {Math.round(vitals.health)}%
                                                        </span>
                                                    </div>
                                                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                                                        <div
                                                            className={`h-full rounded-full ${healthColour(vitals.health)}`}
                                                            style={{
                                                                width: `${Math.max(0, Math.min(100, vitals.health))}%`,
                                                            }}
                                                        />
                                                    </div>
                                                </div>
                                            )}

                                            <div className="flex flex-wrap gap-2">
                                                {vitals.infected && (
                                                    <Badge variant="destructive" className="gap-1">
                                                        <Skull className="size-3" />
                                                        {t('portal.character.infected')}
                                                    </Badge>
                                                )}
                                                {vitals.bleeding_parts > 0 && (
                                                    <Badge variant="destructive" className="gap-1">
                                                        <Droplet className="size-3" />
                                                        {t('portal.character.bleeding', {
                                                            count: String(vitals.bleeding_parts),
                                                        })}
                                                    </Badge>
                                                )}
                                                {vitals.has_cold && (
                                                    <Badge variant="secondary" className="gap-1">
                                                        <Snowflake className="size-3" />
                                                        {t('portal.character.has_cold')}
                                                    </Badge>
                                                )}
                                                {!vitals.infected && vitals.bleeding_parts === 0 && !vitals.has_cold && (
                                                    <span className="text-muted-foreground text-sm">
                                                        {t('portal.character.all_well')}
                                                    </span>
                                                )}
                                            </div>
                                        </>
                                    )}
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>{t('portal.character.traits')}</CardTitle>
                                    <CardDescription>{t('portal.character.traits_desc')}</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    {character.traits === null ? (
                                        <p className="text-muted-foreground text-sm">
                                            {t('portal.character.needs_newer_mod')}
                                        </p>
                                    ) : character.traits.length === 0 ? (
                                        <p className="text-muted-foreground text-sm">{t('portal.character.no_traits')}</p>
                                    ) : (
                                        <div className="flex flex-wrap gap-2">
                                            {character.traits.map((trait) => (
                                                <Badge key={trait.id} variant="outline">
                                                    {trait.label}
                                                </Badge>
                                            ))}
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        </div>

                        <Card>
                            <CardHeader>
                                <CardTitle>{t('portal.character.skills')}</CardTitle>
                                <CardDescription>
                                    {freshAt
                                        ? t('portal.character.skills_desc', {
                                              time: formatRelativeTime(freshAt, t),
                                          })
                                        : t('portal.character.traits_desc')}
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                {categorisedSkills.length === 0 ? (
                                    <p className="text-muted-foreground text-sm">{t('portal.character.no_skills')}</p>
                                ) : (
                                    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                                        {categorisedSkills.map(({ category, skills }) => (
                                            <div key={category} className="space-y-2">
                                                <p className="text-sm font-semibold">{category}</p>
                                                {skills.map((skill) => (
                                                    <SkillBar key={skill.name} name={skill.name} level={skill.level} />
                                                ))}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </>
                )}
            </div>
        </AppLayout>
    );
}
