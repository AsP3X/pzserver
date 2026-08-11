import { BODY_CANVAS, BODY_PART_ORDER, BODY_SPRITES } from '@/components/character-body-sprites';
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
 * The silhouette is the game's own, so the body here is the body the player
 * already reads in game. It arrives as one alpha mask per part, tinted from our
 * palette through a CSS mask — the shape is theirs, every colour is ours.
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

/** Every part the figure draws. */
const ALL_PARTS: string[] = BODY_PART_ORDER;

/** Status bands, best first, in the order the legend reads them. */
const HEALTH_BANDS = [
    { floor: 67, fill: 'bg-green-500/80', key: 'healthy' },
    { floor: 34, fill: 'bg-yellow-500/80', key: 'hurt' },
    { floor: 0, fill: 'bg-red-500/80', key: 'critical' },
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
    { fill: 'bg-blue-600/80', key: 'freezing' },
    { fill: 'bg-sky-400/80', key: 'cold' },
    { fill: 'bg-muted-foreground/30', key: 'comfortable' },
    { fill: 'bg-orange-400/80', key: 'warm' },
    { fill: 'bg-red-500/80', key: 'overheating' },
];

function temperatureFill(celsius: number): string {
    if (celsius <= 28) return 'bg-blue-600/80';
    if (celsius <= 32) return 'bg-sky-400/80';
    if (celsius < 38.5) return 'bg-muted-foreground/30';
    if (celsius < 40) return 'bg-orange-400/80';

    return 'bg-red-500/80';
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
                    <span className={`size-3 shrink-0 rounded-sm border border-border ${band.fill}`} aria-hidden="true" />
                    <span className="text-muted-foreground">{t(`portal.character.vitals.band_${band.key}`)}</span>
                </li>
            ))}
            {withWound && (
                <li className="flex items-center gap-2 text-xs">
                    <span className="size-2.5 shrink-0 rounded-full bg-red-600" aria-hidden="true" />
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
    /** Percentages, so the whole figure scales with its container. */
    const pct = (value: number, axis: 'width' | 'height'): string =>
        `${(value / (axis === 'width' ? BODY_CANVAS.width : BODY_CANVAS.height)) * 100}%`;

    return (
        <div
            className="relative w-full max-w-[190px]"
            style={{ aspectRatio: `${BODY_CANVAS.width} / ${BODY_CANVAS.height}` }}
            role="img"
            aria-label={title}
        >
            {BODY_PART_ORDER.map((name) => {
                const sprite = BODY_SPRITES[name];
                const part = parts[name];
                const wounded = showWounds && part && part.wounds.length > 0;

                return (
                    <div key={name} title={part ? labelFor(name) : undefined}>
                        {/*
                          The sprite is an alpha mask, so the element's own
                          background is what you see. A part the server did not
                          report stays muted rather than reading as healthy.
                        */}
                        <div
                            className={part ? fillFor(name) : 'bg-muted'}
                            style={{
                                position: 'absolute',
                                left: pct(sprite.x, 'width'),
                                top: pct(sprite.y, 'height'),
                                width: pct(sprite.w, 'width'),
                                height: pct(sprite.h, 'height'),
                                maskImage: `url(${sprite.mask})`,
                                WebkitMaskImage: `url(${sprite.mask})`,
                                maskSize: '100% 100%',
                                WebkitMaskSize: '100% 100%',
                                maskRepeat: 'no-repeat',
                                WebkitMaskRepeat: 'no-repeat',
                            }}
                        />
                        {part && (
                            <>
                                {/*
                                  The number, in text ink rather than the fill's
                                  colour — identity never rides on hue alone here.
                                */}
                                <span
                                    className="text-foreground pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 text-[10px] leading-none font-semibold tabular-nums"
                                    style={{
                                        left: pct(sprite.label[0], 'width'),
                                        top: pct(sprite.label[1], 'height'),
                                    }}
                                >
                                    {readingFor(name)}
                                </span>
                                {/* Wounds get a mark of their own, so they survive a greyscale print. */}
                                {wounded && (
                                    <span
                                        className="border-background pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border bg-red-600"
                                        style={{
                                            left: pct(sprite.pin[0], 'width'),
                                            top: pct(sprite.pin[1], 'height'),
                                        }}
                                    />
                                )}
                            </>
                        )}
                    </div>
                );
            })}
        </div>
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
