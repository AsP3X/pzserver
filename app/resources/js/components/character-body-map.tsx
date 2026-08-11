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
 * The figure, drawn once and mirrored.
 *
 * Only the centre line and the character's right side are authored here; the
 * left is the same path reflected about x=130 at render time. Hand-writing both
 * halves invites them to drift a pixel apart, and a lopsided body reads as a
 * bug in the data rather than in the drawing.
 *
 * The figure faces the viewer, so the character's right arm is the one on the
 * left of the screen — the same way a paper doll or a mirror works.
 *
 * Proportions are roughly canonical: the crotch sits at half the total height,
 * the head is about a seventh of it. Every region is at least 22 units across
 * at its label, because the reading has to fit inside the part it describes.
 */
const MIRROR_AXIS = 130;

type Region = {
    part: string;
    d: string;
    /** Where the reading sits, and where a wound pin hangs off it. */
    label: [number, number];
    pin: [number, number];
    /** Centre parts are drawn once; sided parts are drawn twice, mirrored. */
    side?: 'R';
};

const REGIONS: Region[] = [
    {
        part: 'Head',
        d: 'M130,12 C143,12 152,23 152,37 C152,45 149,53 144,58 C140,63 135,67 130,67 C125,67 120,63 116,58 C111,53 108,45 108,37 C108,23 117,12 130,12 Z',
        label: [130, 38],
        pin: [145, 25],
    },
    {
        part: 'Neck',
        d: 'M119,60 L141,60 L141,82 L152,88 L108,88 L119,82 Z',
        label: [130, 74],
        pin: [139, 68],
    },
    {
        part: 'Torso_Upper',
        d: 'M108,88 L152,88 C160,89 165,95 166,104 L165,140 C164,158 163,170 162,178 L98,178 C97,170 96,158 95,140 L94,104 C95,95 100,89 108,88 Z',
        label: [130, 132],
        pin: [156, 100],
    },
    {
        part: 'Torso_Lower',
        d: 'M98,178 L162,178 L160,214 C159,228 157,240 155,248 L105,248 C103,240 101,228 100,214 Z',
        label: [130, 212],
        pin: [154, 188],
    },
    {
        part: 'Groin',
        d: 'M105,248 L155,248 C154,262 150,276 143,286 L130,294 L117,286 C110,276 106,262 105,248 Z',
        label: [130, 266],
        pin: [146, 257],
    },
    {
        /** The cap sweeps above the shoulder line so the deltoid rounds off the trunk. */
        part: 'UpperArm_R',
        d: 'M94,104 C86,92 74,92 68,101 C64,108 64,116 65,124 L69,186 L91,186 C92,160 93,130 94,104 Z',
        label: [78, 146],
        pin: [86, 114],
        side: 'R',
    },
    {
        part: 'ForeArm_R',
        d: 'M69,186 L91,186 L92,252 L74,252 Z',
        label: [82, 218],
        pin: [87, 194],
        side: 'R',
    },
    {
        part: 'Hand_R',
        d: 'M74,252 L92,252 C94,264 93,278 87,286 C81,292 74,290 71,282 C69,272 71,261 74,252 Z',
        label: [82, 268],
        pin: [89, 258],
        side: 'R',
    },
    {
        part: 'UpperLeg_R',
        d: 'M117,286 L129,294 L129,372 L100,372 C99,344 105,312 117,286 Z',
        label: [114, 332],
        pin: [123, 301],
        side: 'R',
    },
    {
        part: 'LowerLeg_R',
        d: 'M100,372 L129,372 L129,442 L106,442 C102,420 99,396 100,372 Z',
        label: [115, 405],
        pin: [123, 382],
        side: 'R',
    },
    {
        part: 'Foot_R',
        d: 'M106,442 L129,442 L129,460 C129,465 125,468 119,468 L98,468 C93,468 91,464 93,459 L106,442 Z',
        label: [112, 453],
        pin: [124, 448],
        side: 'R',
    },
];

/** Every part the figure can draw, both sides of the mirrored ones. */
const ALL_PARTS: string[] = REGIONS.flatMap((region) =>
    region.side === 'R' ? [region.part, region.part.replace(/_R$/, '_L')] : [region.part],
);

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

/**
 * What a character looks like before the server has ever reported one: whole,
 * unwounded, and comfortable.
 *
 * The caller is expected to label this as a placeholder. Showing invented
 * numbers as though they were readings is the exact failure that made 1.7's
 * dashboard useless — the difference is that these are declared, not defaults
 * leaking out of a swallowed error.
 */
export const DEFAULT_SKIN_CELSIUS = 36.6;

export function defaultBodyParts(): Record<string, BodyPartHealth> {
    return Object.fromEntries(ALL_PARTS.map((part) => [part, { health: 100, wounds: [] }]));
}

export function defaultBodyTemperature(): Record<string, BodyPartTemp> {
    return Object.fromEntries(
        ALL_PARTS.map((part) => [part, { skin: DEFAULT_SKIN_CELSIUS, insulation: 0 }]),
    );
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
    /**
     * Shapes first, then every reading on top.
     *
     * Kept in two passes on purpose: the left half is the right half under a
     * reflection, and text inside that group would come out backwards. Drawing
     * all the silhouette first also means no neighbouring limb can overlap a
     * number that has already been placed.
     */
    const placements = REGIONS.flatMap((region) => {
        const own = { part: region.part, d: region.d, label: region.label, pin: region.pin, flip: false };

        if (region.side !== 'R') {
            return [own];
        }

        const mirror = (x: number): number => MIRROR_AXIS * 2 - x;

        return [
            own,
            {
                part: region.part.replace(/_R$/, '_L'),
                d: region.d,
                label: [mirror(region.label[0]), region.label[1]] as [number, number],
                pin: [mirror(region.pin[0]), region.pin[1]] as [number, number],
                flip: true,
            },
        ];
    });

    return (
        <svg viewBox="0 0 260 478" className="h-auto w-full max-w-[240px]" role="img" aria-label={title}>
            {placements.map((place) => {
                const part = parts[place.part];

                return (
                    <path
                        key={`shape-${place.part}`}
                        d={place.d}
                        transform={place.flip ? `translate(${MIRROR_AXIS * 2},0) scale(-1,1)` : undefined}
                        /** A build without this part draws it absent, not healthy. */
                        className={`${part ? fillFor(place.part) : 'fill-muted'} stroke-border`}
                        strokeWidth={1.25}
                        strokeLinejoin="round"
                    />
                );
            })}

            {placements.map((place) => {
                const part = parts[place.part];
                if (!part) {
                    return null;
                }

                const wounded = showWounds && part.wounds.length > 0;

                return (
                    <g key={`reading-${place.part}`} className="cursor-default">
                        <title>{labelFor(place.part)}</title>
                        {/*
                          The number, in text ink rather than the fill's colour —
                          identity never rides on hue alone here.
                        */}
                        <text
                            x={place.label[0]}
                            y={place.label[1]}
                            textAnchor="middle"
                            dominantBaseline="central"
                            className="fill-foreground font-medium tabular-nums"
                            style={{ fontSize: 11 }}
                        >
                            {readingFor(place.part)}
                        </text>
                        {/* Wounds get a mark of their own, so they survive a greyscale print. */}
                        {wounded && (
                            <circle
                                cx={place.pin[0]}
                                cy={place.pin[1]}
                                r={4.5}
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
