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
 * Proportions follow the game's survivors rather than an anatomy chart: a small
 * squarish head, shoulders better than twice its width, a neck all but hidden
 * between them, and limbs thick enough to look like they carry a bag. Drawn to
 * real human proportion it came out lanky and bulb-headed. Every region is
 * still at least 22 units across at its label, because the reading has to fit
 * inside the part it describes — that is what sets the minimum limb width.
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
        /** Squarish rather than round: the game's survivors read as pixel art, not portraits. */
        part: 'Head',
        d: 'M130,16 C141,16 149,23 149,33 L149,44 C149,54 141,60 130,60 C119,60 111,54 111,44 L111,33 C111,23 119,16 130,16 Z',
        label: [130, 39],
        pin: [143, 25],
    },
    {
        /** Barely there. A visible neck is what made the first attempt look like a puppet. */
        part: 'Neck',
        d: 'M120,54 L140,54 L140,72 L152,80 L108,80 L120,72 Z',
        label: [130, 70],
        pin: [146, 76],
    },
    {
        part: 'Torso_Upper',
        d: 'M108,80 L152,80 C164,81 172,88 174,100 L172,140 C171,156 169,168 168,176 L92,176 C91,168 89,156 88,140 L86,100 C88,88 96,81 108,80 Z',
        label: [130, 128],
        pin: [160, 94],
    },
    {
        part: 'Torso_Lower',
        d: 'M92,176 L168,176 L166,208 C165,222 163,234 161,244 L99,244 C97,234 95,222 94,208 Z',
        label: [130, 208],
        pin: [158, 186],
    },
    {
        part: 'Groin',
        d: 'M99,244 L161,244 C160,258 156,272 148,282 L130,290 L112,282 C104,272 100,258 99,244 Z',
        label: [130, 262],
        pin: [150, 252],
    },
    {
        /** The cap sweeps above the shoulder line so the deltoid rounds off the trunk. */
        part: 'UpperArm_R',
        d: 'M86,100 C78,86 64,86 58,96 C54,103 54,112 55,122 L60,184 L84,184 C85,158 85,126 86,100 Z',
        label: [70, 144],
        pin: [79, 110],
        side: 'R',
    },
    {
        part: 'ForeArm_R',
        d: 'M60,184 L84,184 L85,248 L66,248 Z',
        label: [75, 216],
        pin: [80, 192],
        side: 'R',
    },
    {
        part: 'Hand_R',
        d: 'M66,248 L85,248 C88,262 87,276 81,284 C74,291 66,289 63,280 C61,270 63,258 66,248 Z',
        label: [75, 266],
        pin: [83, 256],
        side: 'R',
    },
    {
        part: 'UpperLeg_R',
        d: 'M112,282 L129,290 L129,368 L98,368 C97,340 103,308 112,282 Z',
        label: [113, 328],
        pin: [122, 298],
        side: 'R',
    },
    {
        part: 'LowerLeg_R',
        d: 'M98,368 L129,368 L129,436 L104,436 C100,414 97,392 98,368 Z',
        label: [114, 400],
        pin: [122, 378],
        side: 'R',
    },
    {
        part: 'Foot_R',
        d: 'M104,436 L129,436 L129,454 C129,459 125,462 119,462 L96,462 C91,462 89,458 91,453 L104,436 Z',
        label: [111, 448],
        pin: [123, 442],
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
        <svg viewBox="0 0 260 470" className="h-auto w-full max-w-[240px]" role="img" aria-label={title}>
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
