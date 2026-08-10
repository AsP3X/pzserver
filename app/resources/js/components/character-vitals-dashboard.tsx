import {
    Apple,
    Backpack,
    Beef,
    ChefHat,
    Crosshair,
    Droplet,
    Dumbbell,
    Flame,
    HeartPulse,
    Moon,
    Shield,
    Shirt,
    Snowflake,
    Swords,
    Thermometer,
    Weight,
    Wheat,
    Wind,
    Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslation } from '@/hooks/use-translation';
import { formatRelativeTime } from '@/lib/dates';

// ── Types matching KR_Vitals.lua output ────────────────────────────

type BodyPartHealth = {
    health: number;
    wounds: string[];
};

type BodyPartProtection = {
    bite: number;
    scratch: number;
};

type BodyPartTemp = {
    skin: number;
    insulation: number;
};

type SkillXp = {
    level: number;
    xp: number;
};

type ClothingItem = {
    slot: string;
    name: string;
    condition: number;
    holes: number;
    bite: number;
    scratch: number;
};

type QuickloadSlot = {
    index: number;
    /** Absent, not null, for an empty slot: KR_Codec omits nil-valued keys. */
    item?: string;
};

type Wound = {
    part: string;
    type: string;
    severity: string;
    treated: boolean;
};

type Recipe = {
    name: string;
    learned_at: string | null;
};

type VitalsInfo = {
    name?: string;
    profession?: string;
    traits?: string[];
    weight?: number;
    favourite_weapon?: string;
    kills?: number;
    hours_survived?: number;
};

type VitalsHealth = {
    overall?: number;
    parts?: Record<string, BodyPartHealth>;
};

type VitalsProtection = {
    parts?: Record<string, BodyPartProtection>;
};

type VitalsTemperature = {
    core?: number;
    body_heat?: number;
    parts?: Record<string, BodyPartTemp>;
};

type VitalsMoodles = {
    hunger?: number;
    thirst?: number;
    fatigue?: number;
    endurance?: number;
    stress?: number;
    panic?: number;
    boredom?: number;
    unhappiness?: number;
    pain?: number;
    wetness?: number;
    drunk?: number;
    temperature?: number;
    sick?: boolean;
    has_cold?: boolean;
    food_sickness?: number;
};

type VitalsWeapon = {
    name?: string;
    condition?: number;
    sharpness?: number;
    attachments?: string[];
    ammo?: number | null;
    chamber?: boolean;
    jam?: boolean;
};

type VitalsEncumbrance = {
    current?: number;
    capacity?: number;
};

export type VitalsHeartbeat = {
    info?: VitalsInfo;
    skills?: Record<string, SkillXp>;
    health?: VitalsHealth;
    protection?: VitalsProtection;
    temperature?: VitalsTemperature;
    moodles?: VitalsMoodles;
    weapon?: VitalsWeapon;
    clothing?: { items?: ClothingItem[] };
    quickload?: { slots?: QuickloadSlot[] };
    encumbrance?: VitalsEncumbrance;
    wounds?: Wound[];
    recipes?: Recipe[];
};

// ── Helpers ─────────────────────────────────────────────────────────

const BODY_PARTS = [
    'Head', 'Neck', 'Torso',
    'UpperArm_L', 'UpperArm_R',
    'ForeArm_L', 'ForeArm_R',
    'Hand_L', 'Hand_R',
    'Groin',
    'UpperLeg_L', 'UpperLeg_R',
    'LowerLeg_L', 'LowerLeg_R',
    'Foot_L', 'Foot_R',
];

function healthColour(value: number): string {
    if (value >= 66) return 'bg-green-500';
    if (value >= 33) return 'bg-yellow-500';
    return 'bg-red-500';
}

function conditionColour(value: number): string {
    if (value >= 75) return 'text-green-500';
    if (value >= 40) return 'text-yellow-500';
    return 'text-red-500';
}

/**
 * `invert` is for bars where a full bar is the bad news — hunger, pain, panic.
 * Without it a starving character reads green, because healthColour treats a
 * high value as a healthy one.
 */
function ProgressBar({
    value,
    max,
    invert = false,
    className,
}: {
    value: number;
    max: number;
    invert?: boolean;
    className?: string;
}) {
    const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    return (
        <div className={`h-2 w-full overflow-hidden rounded-full bg-muted ${className ?? ''}`}>
            <div
                className={`h-full rounded-full ${healthColour(invert ? 100 - pct : pct)}`}
                style={{ width: `${pct}%` }}
            />
        </div>
    );
}

function StatRow({ icon, label, value, suffix }: { icon: React.ReactNode; label: string; value: string | number; suffix?: string }) {
    return (
        <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground flex items-center gap-1.5">{icon}{label}</span>
            <span className="font-medium tabular-nums">{value}{suffix ?? ''}</span>
        </div>
    );
}

// ── Panel Components ────────────────────────────────────────────────

function InfoPanel({ info }: { info: VitalsInfo }) {
    const { t } = useTranslation();
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('portal.character.vitals.info')}</CardTitle>
                <CardDescription>{t('portal.character.vitals.info_desc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
                {info.profession && <StatRow icon={<Swords className="size-3.5" />} label={t('portal.character.profession')} value={info.profession} />}
                {info.weight !== undefined && <StatRow icon={<Weight className="size-3.5" />} label={t('portal.character.vitals.weight')} value={info.weight.toFixed(1)} suffix=" kg" />}
                {info.favourite_weapon && <StatRow icon={<Crosshair className="size-3.5" />} label={t('portal.character.vitals.favorite_weapon')} value={info.favourite_weapon} />}
                {info.traits && info.traits.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                        {info.traits.map((trait) => <Badge key={trait} variant="outline" className="text-xs">{trait}</Badge>)}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function SkillsPanel({ skills }: { skills: Record<string, SkillXp> }) {
    const { t } = useTranslation();
    const entries = Object.entries(skills).sort(([, a], [, b]) => b.level - a.level || b.xp - a.xp);
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('portal.character.vitals.skills_xp')}</CardTitle>
                <CardDescription>{t('portal.character.vitals.skills_xp_desc')}</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="space-y-2">
                    {entries.map(([name, { level, xp }]) => (
                        <div key={name} className="flex items-center gap-3">
                            <span className="w-24 truncate text-xs text-muted-foreground">{name}</span>
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                                <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(xp * 100, 100)}%` }} />
                            </div>
                            <span className="w-12 text-right text-xs font-medium tabular-nums">{level} <span className="text-muted-foreground">({Math.round(xp * 100)}%)</span></span>
                        </div>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
}

function HealthPanel({ health }: { health: VitalsHealth }) {
    const { t } = useTranslation();
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('portal.character.vitals.health')}</CardTitle>
                <CardDescription>{t('portal.character.vitals.health_desc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                {health.overall !== undefined && (
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-sm">
                            <span className="flex items-center gap-1.5"><HeartPulse className="size-3.5" />{t('portal.character.health')}</span>
                            <span className="tabular-nums">{Math.round(health.overall)}%</span>
                        </div>
                        <ProgressBar value={health.overall} max={100} />
                    </div>
                )}
                {health.parts && (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                        {BODY_PARTS.filter((p) => health.parts![p]).map((part) => {
                            const p = health.parts![part];
                            const hasWounds = p.wounds && p.wounds.length > 0;
                            return (
                                <div key={part} className="flex items-center justify-between text-xs">
                                    <span className="text-muted-foreground truncate">{part.replace(/_/g, ' ')}</span>
                                    <span className={`tabular-nums ${hasWounds ? 'text-red-500 font-medium' : ''}`}>
                                        {Math.round(p.health)}%{hasWounds && ` (${p.wounds.length})`}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function ProtectionPanel({ protection }: { protection: VitalsProtection }) {
    const { t } = useTranslation();
    if (!protection.parts) return null;
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('portal.character.vitals.protection')}</CardTitle>
                <CardDescription>{t('portal.character.vitals.protection_desc')}</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="grid grid-cols-1 gap-1.5">
                    {BODY_PARTS.filter((p) => protection.parts![p]).map((part) => {
                        const p = protection.parts![part];
                        return (
                            <div key={part} className="flex items-center justify-between text-xs">
                                <span className="text-muted-foreground w-24 truncate">{part.replace(/_/g, ' ')}</span>
                                <div className="flex gap-3 tabular-nums">
                                    <span title={t('portal.character.vitals.bite_defense')}><Shield className="inline size-3 text-red-500 mr-0.5" />{p.bite}%</span>
                                    <span title={t('portal.character.vitals.scratch_defense')}><Shield className="inline size-3 text-yellow-500 mr-0.5" />{p.scratch}%</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </CardContent>
        </Card>
    );
}

function TemperaturePanel({ temperature }: { temperature: VitalsTemperature }) {
    const { t } = useTranslation();
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('portal.character.vitals.temperature')}</CardTitle>
                <CardDescription>{t('portal.character.vitals.temperature_desc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                {temperature.core !== undefined && <StatRow icon={<Thermometer className="size-3.5" />} label={t('portal.character.vitals.core_temp')} value={temperature.core.toFixed(1)} suffix="°C" />}
                {temperature.body_heat !== undefined && <StatRow icon={<Flame className="size-3.5" />} label={t('portal.character.vitals.body_heat')} value={temperature.body_heat.toFixed(1)} />}
                {temperature.parts && (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1">
                        {BODY_PARTS.filter((p) => temperature.parts![p]).map((part) => {
                            const p = temperature.parts![part];
                            return (
                                <div key={part} className="flex items-center justify-between text-xs">
                                    <span className="text-muted-foreground truncate">{part.replace(/_/g, ' ')}</span>
                                    <span className="tabular-nums">{p.skin.toFixed(1)}°C<span className="text-muted-foreground ml-1">({p.insulation.toFixed(1)})</span></span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function MoodlesPanel({ moodles }: { moodles: VitalsMoodles }) {
    const { t } = useTranslation();
    /**
     * Every moodle here counts up as things get worse, so a full bar is bad —
     * except endurance, which is the reserve you spend and want kept full.
     */
    const rows: { icon: React.ReactNode; label: string; value: number; invert: boolean }[] = [
        { icon: <Apple className="size-3.5" />, label: t('portal.character.vitals.hunger'), value: moodles.hunger ?? 0, invert: true },
        { icon: <Droplet className="size-3.5" />, label: t('portal.character.vitals.thirst'), value: moodles.thirst ?? 0, invert: true },
        { icon: <Moon className="size-3.5" />, label: t('portal.character.vitals.fatigue'), value: moodles.fatigue ?? 0, invert: true },
        { icon: <Zap className="size-3.5" />, label: t('portal.character.vitals.endurance'), value: moodles.endurance ?? 1, invert: false },
        { icon: <Wind className="size-3.5" />, label: t('portal.character.vitals.stress'), value: moodles.stress ?? 0, invert: true },
        { icon: <Flame className="size-3.5" />, label: t('portal.character.vitals.panic'), value: moodles.panic ?? 0, invert: true },
        { icon: <Dumbbell className="size-3.5" />, label: t('portal.character.vitals.boredom'), value: moodles.boredom ?? 0, invert: true },
        { icon: <Wheat className="size-3.5" />, label: t('portal.character.vitals.unhappiness'), value: moodles.unhappiness ?? 0, invert: true },
        { icon: <HeartPulse className="size-3.5" />, label: t('portal.character.vitals.pain'), value: moodles.pain ?? 0, invert: true },
        { icon: <Droplet className="size-3.5" />, label: t('portal.character.vitals.wetness'), value: moodles.wetness ?? 0, invert: true },
        { icon: <Beef className="size-3.5" />, label: t('portal.character.vitals.drunk'), value: moodles.drunk ?? 0, invert: true },
    ];
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('portal.character.vitals.moodles')}</CardTitle>
                <CardDescription>{t('portal.character.vitals.moodles_desc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
                {moodles.sick && <Badge variant="destructive" className="gap-1"><Snowflake className="size-3" />{t('portal.character.vitals.sick')}</Badge>}
                {moodles.has_cold && <Badge variant="secondary" className="gap-1"><Snowflake className="size-3" />{t('portal.character.has_cold')}</Badge>}
                {rows.map((row) => (
                    <div key={row.label} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground flex items-center gap-1.5">{row.icon}{row.label}</span>
                            <span className="tabular-nums">{Math.round(row.value * 100)}%</span>
                        </div>
                        <ProgressBar value={row.value} max={1} invert={row.invert} />
                    </div>
                ))}
            </CardContent>
        </Card>
    );
}

function WeaponPanel({ weapon }: { weapon: VitalsWeapon }) {
    const { t } = useTranslation();
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('portal.character.vitals.weapon')}</CardTitle>
                <CardDescription>{t('portal.character.vitals.weapon_desc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
                {weapon.name && <StatRow icon={<Swords className="size-3.5" />} label={t('portal.character.vitals.equipped')} value={weapon.name} />}
                {weapon.condition !== undefined && (
                    <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground">{t('portal.character.vitals.condition')}</span>
                            <span className={`tabular-nums font-medium ${conditionColour(weapon.condition)}`}>{weapon.condition}%</span>
                        </div>
                        <ProgressBar value={weapon.condition} max={100} />
                    </div>
                )}
                {weapon.sharpness !== undefined && <StatRow icon={<Crosshair className="size-3.5" />} label={t('portal.character.vitals.sharpness')} value={weapon.sharpness} suffix="%" />}
                {weapon.jam && <Badge variant="destructive">{t('portal.character.vitals.jammed')}</Badge>}
                {weapon.ammo !== undefined && weapon.ammo !== null && <StatRow icon={<Crosshair className="size-3.5" />} label={t('portal.character.vitals.ammo')} value={weapon.ammo} />}
                {weapon.chamber !== undefined && <StatRow icon={<Crosshair className="size-3.5" />} label={t('portal.character.vitals.chambered')} value={weapon.chamber ? 'Yes' : 'No'} />}
                {weapon.attachments && weapon.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                        {weapon.attachments.map((att) => <Badge key={att} variant="outline" className="text-xs">{att}</Badge>)}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function ClothingPanel({ clothing }: { clothing: { items?: ClothingItem[] } }) {
    const { t } = useTranslation();
    if (!clothing.items || clothing.items.length === 0) return null;
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('portal.character.vitals.clothing')}</CardTitle>
                <CardDescription>{t('portal.character.vitals.clothing_desc')}</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="space-y-2">
                    {clothing.items.map((item, i) => (
                        <div key={`${item.slot}-${i}`} className="flex items-center justify-between text-xs">
                            <div className="flex items-center gap-1.5 min-w-0">
                                <Shirt className="size-3 shrink-0 text-muted-foreground" />
                                <span className="text-muted-foreground truncate">{item.slot}</span>
                            </div>
                            <div className="flex items-center gap-3 tabular-nums shrink-0">
                                <span className="truncate max-w-[120px]">{item.name}</span>
                                <span className={conditionColour(item.condition)}>{item.condition}%</span>
                                {item.holes > 0 && <span className="text-red-500">({item.holes})</span>}
                                <span className="text-muted-foreground"><Shield className="inline size-2.5 text-red-400 mr-0.5" />{item.bite}%</span>
                            </div>
                        </div>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
}

function EncumbrancePanel({ encumbrance }: { encumbrance: VitalsEncumbrance }) {
    const { t } = useTranslation();
    if (encumbrance.current === undefined || encumbrance.capacity === undefined) return null;
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('portal.character.vitals.encumbrance')}</CardTitle>
                <CardDescription>{t('portal.character.vitals.encumbrance_desc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-1.5"><Weight className="size-3.5" />{t('portal.character.vitals.carry_load')}</span>
                        <span className="tabular-nums font-medium">{encumbrance.current.toFixed(1)} / {encumbrance.capacity.toFixed(1)}</span>
                    </div>
                    <ProgressBar value={encumbrance.current} max={encumbrance.capacity} invert />
                </div>
            </CardContent>
        </Card>
    );
}

function QuickloadPanel({ quickload }: { quickload: { slots?: QuickloadSlot[] } }) {
    const { t } = useTranslation();
    const slots = quickload.slots ?? [];

    /**
     * Every slot comes back empty on builds without the quickload API, and a
     * row of five blanks says nothing worth the space.
     */
    if (!slots.some((slot) => slot.item)) {
        return null;
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('portal.character.vitals.quickload')}</CardTitle>
                <CardDescription>{t('portal.character.vitals.quickload_desc')}</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="space-y-1.5">
                    {slots.map((slot) => (
                        <div key={slot.index} className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground flex items-center gap-1.5">
                                <Backpack className="size-3" />
                                {t('portal.character.vitals.slot', { index: String(slot.index) })}
                            </span>
                            <span className={slot.item ? 'truncate' : 'text-muted-foreground italic'}>
                                {slot.item ?? t('portal.character.vitals.slot_empty')}
                            </span>
                        </div>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
}

function WoundsPanel({ wounds }: { wounds: Wound[] }) {
    const { t } = useTranslation();
    if (wounds.length === 0) return null;
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('portal.character.vitals.wounds')}</CardTitle>
                <CardDescription>{t('portal.character.vitals.wounds_desc')}</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="space-y-2">
                    {wounds.map((wound, i) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                            <div className="flex items-center gap-1.5">
                                <Droplet className={`size-3 ${wound.treated ? 'text-green-500' : 'text-red-500'}`} />
                                <span className="font-medium">{wound.part}</span>
                                <span className="text-muted-foreground">{wound.type} — {wound.severity}</span>
                            </div>
                            <Badge variant={wound.treated ? 'outline' : 'destructive'} className="text-xs">
                                {wound.treated ? t('portal.character.vitals.treated') : t('portal.character.vitals.untreated')}
                            </Badge>
                        </div>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
}

function RecipesPanel({ recipes }: { recipes: Recipe[] }) {
    const { t } = useTranslation();
    if (recipes.length === 0) return null;
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('portal.character.vitals.recipes')}</CardTitle>
                <CardDescription>{t('portal.character.vitals.recipes_desc')}</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="flex flex-wrap gap-2">
                    {recipes.map((recipe, i) => (
                        <Badge key={i} variant="outline" className="gap-1"><ChefHat className="size-3" />{recipe.name}</Badge>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
}

// ── Main Export ─────────────────────────────────────────────────────

type Props = {
    heartbeat: VitalsHeartbeat | null;
    heartbeatAvailable: boolean;
    /** When the mod last wrote this player's heartbeat, in real time. */
    heartbeatSyncedAt: string | null;
};

export function CharacterVitalsDashboard({ heartbeat, heartbeatAvailable, heartbeatSyncedAt }: Props) {
    const { t } = useTranslation();

    if (!heartbeatAvailable) return null;

    if (!heartbeat) {
        return (
            <Card>
                <CardContent className="py-8">
                    <p className="text-muted-foreground text-center text-sm">{t('portal.character.vitals.no_heartbeat')}</p>
                </CardContent>
            </Card>
        );
    }

    const hasAnyData = Object.values(heartbeat).some((v) => v !== undefined && v !== null);

    if (!hasAnyData) {
        return (
            <Card>
                <CardContent className="py-8">
                    <p className="text-muted-foreground text-center text-sm">{t('portal.character.vitals.waiting_for_data')}</p>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-bold tracking-tight">{t('portal.character.vitals.title')}</h2>
                <Badge variant="secondary" className="text-xs">Knox Relay</Badge>
                {heartbeatSyncedAt && (
                    <span className="text-muted-foreground text-xs">
                        {t('portal.character.vitals.synced', {
                            time: formatRelativeTime(heartbeatSyncedAt, t),
                        })}
                    </span>
                )}
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                {heartbeat.info && <InfoPanel info={heartbeat.info} />}
                {heartbeat.health && <HealthPanel health={heartbeat.health} />}
                {heartbeat.protection && <ProtectionPanel protection={heartbeat.protection} />}
                {heartbeat.temperature && <TemperaturePanel temperature={heartbeat.temperature} />}
                {heartbeat.moodles && <MoodlesPanel moodles={heartbeat.moodles} />}
                {heartbeat.weapon && <WeaponPanel weapon={heartbeat.weapon} />}
                {heartbeat.clothing && <ClothingPanel clothing={heartbeat.clothing} />}
                {heartbeat.encumbrance && <EncumbrancePanel encumbrance={heartbeat.encumbrance} />}
                {heartbeat.quickload && <QuickloadPanel quickload={heartbeat.quickload} />}
                {heartbeat.wounds && <WoundsPanel wounds={heartbeat.wounds} />}
                {heartbeat.recipes && <RecipesPanel recipes={heartbeat.recipes} />}
            </div>

            {heartbeat.skills && Object.keys(heartbeat.skills).length > 0 && (
                <div className="lg:col-span-2">
                    <SkillsPanel skills={heartbeat.skills} />
                </div>
            )}
        </div>
    );
}
