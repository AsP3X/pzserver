import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslation } from '@/hooks/use-translation';

/**
 * A pair of paper-dolls: what the character's body is doing, and how warm it is.
 *
 * Side by side rather than one behind a toggle, because the two answer different
 * questions a player has at the same moment — a cold hand and a bitten hand want
 * different responses, and reading them one after the other loses the comparison
 * between them.
 *
 * Every part carries its own number as well as its colour. That is not
 * decoration: the health palette is green / amber / red, and green against
 * amber separates by only ΔE 4.2 for a protan viewer — far under the ΔE 8 floor
 * — so a reader with the commonest form of colour blindness would be looking at
 * one flat shape. The colour is the glance; the number is the answer.
 */

type BodyPartHealth = {
    health: number;
    wounds: string[];
};

type BodyPartTemp = {
    skin: number;
    insulation: number;
};

type Props = {
    parts?: Record<string, BodyPartHealth>;
    temperature?: Record<string, BodyPartTemp>;
    overall?: number;
};

/**
 * Where each BodyPartType sits on the figure, which faces the viewer — so the
 * character's left arm is drawn on the right, as it would be looking at them.
 */
const REGIONS: { part: string; x: number; y: number; w: number; h: number; r: number }[] = [
    { part: 'Head', x: 95, y: 8, w: 50, h: 46, r: 18 },
    { part: 'Neck', x: 105, y: 56, w: 30, h: 16, r: 5 },
    { part: 'Torso_Upper', x: 82, y: 74, w: 76, h: 66, r: 8 },
    { part: 'Torso_Lower', x: 82, y: 142, w: 76, h: 58, r: 8 },
    { part: 'Groin', x: 95, y: 202, w: 50, h: 28, r: 8 },
    { part: 'UpperArm_R', x: 52, y: 78, w: 26, h: 62, r: 9 },
    { part: 'UpperArm_L', x: 162, y: 78, w: 26, h: 62, r: 9 },
    { part: 'ForeArm_R', x: 52, y: 142, w: 26, h: 56, r: 9 },
    { part: 'ForeArm_L', x: 162, y: 142, w: 26, h: 56, r: 9 },
    { part: 'Hand_R', x: 50, y: 200, w: 30, h: 30, r: 10 },
    { part: 'Hand_L', x: 160, y: 200, w: 30, h: 30, r: 10 },
    { part: 'UpperLeg_R', x: 88, y: 232, w: 31, h: 70, r: 9 },
    { part: 'UpperLeg_L', x: 121, y: 232, w: 31, h: 70, r: 9 },
    { part: 'LowerLeg_R', x: 88, y: 304, w: 31, h: 64, r: 9 },
    { part: 'LowerLeg_L', x: 121, y: 304, w: 31, h: 64, r: 9 },
    { part: 'Foot_R', x: 84, y: 370, w: 35, h: 24, r: 8 },
    { part: 'Foot_L', x: 121, y: 370, w: 35, h: 24, r: 8 },
];

/** Status bands, best first, in the order the legend reads them. */
const HEALTH_BANDS = [
    { floor: 67, fill: 'fill-green-500/70', key: 'healthy' },
    { floor: 34, fill: 'fill-yellow-500/70', key: 'hurt' },
    { floor: 0, fill: 'fill-red-500/70', key: 'critical' },
];

function healthFill(value: number): string {
    return (HEALTH_BANDS.find((band) => value >= band.floor) ?? HEALTH_BANDS[2]).fill;
}

/**
 * Skin temperature diverges around comfortable rather than climbing, so it gets
 * two poles and a neutral middle: cold below, warm above, grey where the
 * character is neither.
 */
const TEMPERATURE_BANDS = [
    { fill: 'fill-blue-600/70', key: 'freezing' },
    { fill: 'fill-sky-400/70', key: 'cold' },
    { fill: 'fill-muted-foreground/25', key: 'comfortable' },
    { fill: 'fill-orange-400/70', key: 'warm' },
    { fill: 'fill-red-500/70', key: 'overheating' },
];

function temperatureFill(celsius: number): string {
    if (celsius <= 28) return 'fill-blue-600/70';
    if (celsius <= 32) return 'fill-sky-400/70';
    if (celsius < 38.5) return 'fill-muted-foreground/25';
    if (celsius < 40) return 'fill-orange-400/70';

    return 'fill-red-500/70';
}

function humanPart(part: string): string {
    return part.replace(/_/g, ' ');
}

function Legend({ bands, withWound }: { bands: { fill: string; key: string }[]; withWound?: boolean }) {
    const { t } = useTranslation();

    return (
        <ul className="space-y-1.5">
            {bands.map((band) => (
                <li key={band.key} className="flex items-center gap-2 text-xs">
                    <svg viewBox="0 0 12 12" className="size-3 shrink-0" aria-hidden="true">
                        <rect width="12" height="12" rx="3" className={`${band.fill} stroke-border`} strokeWidth={1} />
                    </svg>
                    <span className="text-muted-foreground">{t(`portal.character.vitals.band_${band.key}`)}</span>
                </li>
            ))}
            {withWound && (
                <li className="flex items-center gap-2 text-xs">
                    <svg viewBox="0 0 12 12" className="size-3 shrink-0" aria-hidden="true">
                        <circle cx="6" cy="6" r="4" className="fill-red-600" />
                    </svg>
                    <span className="text-muted-foreground">{t('portal.character.vitals.band_wounded')}</span>
                </li>
            )}
        </ul>
    );
}

/** One figure. The callers decide what each part is shaded and labelled by. */
function BodyFigure({
    title,
    parts,
    fillFor,
    readingFor,
    labelFor,
    showWounds,
}: {
    title: string;
    parts: Record<string, BodyPartHealth>;
    fillFor: (part: string) => string;
    readingFor: (part: string) => string;
    labelFor: (part: string) => string;
    showWounds: boolean;
}) {
    return (
        <svg viewBox="0 0 240 402" className="h-auto w-full max-w-[230px]" role="img" aria-label={title}>
            {REGIONS.map((region) => {
                const part = parts[region.part];

                /** A build without this part draws it as absent, not as healthy. */
                if (!part) {
                    return (
                        <rect
                            key={region.part}
                            x={region.x}
                            y={region.y}
                            width={region.w}
                            height={region.h}
                            rx={region.r}
                            className="fill-muted stroke-border"
                            strokeWidth={1}
                        />
                    );
                }

                const wounded = showWounds && part.wounds.length > 0;

                return (
                    <g key={region.part} className="cursor-default">
                        <title>{labelFor(region.part)}</title>
                        <rect
                            x={region.x}
                            y={region.y}
                            width={region.w}
                            height={region.h}
                            rx={region.r}
                            className={`${fillFor(region.part)} stroke-border`}
                            strokeWidth={1}
                        />
                        {/*
                          The number, in text ink rather than the fill's colour —
                          identity never rides on hue alone here.
                        */}
                        <text
                            x={region.x + region.w / 2}
                            y={region.y + region.h / 2}
                            textAnchor="middle"
                            dominantBaseline="central"
                            className="fill-foreground font-medium tabular-nums"
                            style={{ fontSize: 11 }}
                        >
                            {readingFor(region.part)}
                        </text>
                        {/* Wounds get a mark of their own, so they survive a greyscale print. */}
                        {wounded && (
                            <circle
                                cx={region.x + region.w - 6}
                                cy={region.y + 6}
                                r={4}
                                className="fill-red-600 stroke-background"
                                strokeWidth={1.5}
                            />
                        )}
                    </g>
                );
            })}
        </svg>
    );
}

export function CharacterBodyMap({ parts, temperature, overall }: Props) {
    const { t } = useTranslation();

    if (!parts || Object.keys(parts).length === 0) {
        return null;
    }

    const hasTemperature = temperature !== undefined && Object.keys(temperature).length > 0;

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('portal.character.vitals.body_map')}</CardTitle>
                <CardDescription>{t('portal.character.vitals.body_map_desc')}</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
                    <section className="flex flex-col items-center gap-3">
                        <div className="flex items-baseline gap-2">
                            <h3 className="text-sm font-semibold">{t('portal.character.vitals.mode_health')}</h3>
                            {overall !== undefined && (
                                <span className="text-muted-foreground text-sm tabular-nums">
                                    {t('portal.character.vitals.overall')} {Math.round(overall)}%
                                </span>
                            )}
                        </div>
                        <BodyFigure
                            title={t('portal.character.vitals.mode_health')}
                            parts={parts}
                            showWounds
                            fillFor={(part) => healthFill(parts[part].health)}
                            readingFor={(part) => `${Math.round(parts[part].health)}`}
                            labelFor={(part) => {
                                const entry = parts[part];
                                const wounds = entry.wounds.length > 0 ? ` (${entry.wounds.join(', ')})` : '';

                                return `${humanPart(part)} — ${Math.round(entry.health)}%${wounds}`;
                            }}
                        />
                        <Legend bands={HEALTH_BANDS} withWound />
                    </section>

                    {hasTemperature && (
                        <section className="flex flex-col items-center gap-3">
                            <h3 className="text-sm font-semibold">
                                {t('portal.character.vitals.mode_temperature')}
                            </h3>
                            <BodyFigure
                                title={t('portal.character.vitals.mode_temperature')}
                                parts={parts}
                                showWounds={false}
                                fillFor={(part) => {
                                    const node = temperature[part];

                                    return node ? temperatureFill(node.skin) : 'fill-muted';
                                }}
                                readingFor={(part) => {
                                    const node = temperature[part];

                                    return node ? `${node.skin.toFixed(0)}°` : '—';
                                }}
                                labelFor={(part) => {
                                    const node = temperature[part];

                                    return node
                                        ? `${humanPart(part)} — ${node.skin.toFixed(1)}°C`
                                        : humanPart(part);
                                }}
                            />
                            <Legend bands={TEMPERATURE_BANDS} />
                        </section>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
