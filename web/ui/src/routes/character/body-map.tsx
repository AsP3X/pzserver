import { Panel, PanelHeader } from '@/components/ui/panel'
import { BODY_CANVAS, BODY_PART_ORDER, BODY_SPRITES } from '@/lib/body-sprites'
import { cn } from '@/lib/cn'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'
import type { BodyPartHealth, BodyPartTemperature } from '@/lib/api'
import { useGameVocabulary } from '@/routes/character/vocabulary'

/**
 * A pair of paper-dolls: what the body is doing, and how warm it is.
 *
 * Side by side rather than behind a toggle, because the two answer different
 * questions a player has at the same moment — a cold hand and a bitten hand
 * want different responses, and reading them one after the other loses the
 * comparison.
 *
 * The silhouette is the game's own, arriving as one alpha mask per part and
 * tinted through a CSS mask: the shape is theirs, every colour is ours.
 *
 * Every part carries its number as well as its colour. That is not decoration.
 * The health palette runs amber to red, and colour alone fails a reader with
 * the commonest form of colour blindness — the colour is the glance, the number
 * is the answer.
 */

interface BodyMapProps {
  parts: Record<string, BodyPartHealth>
  temperature?: Record<string, BodyPartTemperature>
  overall?: number
  /** The figure is the declared default, not a reading. */
  placeholder?: boolean
}

interface Band {
  fill: string
  /**
   * Ink for the number sitting on that fill. Chosen per band rather than fixed:
   * a single colour cannot read against both moss and deep blue, and the number
   * is the part a colour-blind reader depends on.
   */
  ink: string
  key: TranslationKey
}

/** Status bands, best first, in the order the legend reads them. */
const HEALTH_BANDS: Band[] = [
  { fill: 'bg-moss/80', ink: 'text-void', key: 'body.band_healthy' },
  { fill: 'bg-hazard/80', ink: 'text-void', key: 'body.band_hurt' },
  { fill: 'bg-blood/80', ink: 'text-bone', key: 'body.band_critical' },
]

/**
 * Skin temperature diverges around comfortable rather than climbing, so it gets
 * two poles and a neutral middle.
 */
const TEMPERATURE_BANDS: Band[] = [
  { fill: 'bg-[#3b6ea5]/80', ink: 'text-bone', key: 'body.band_freezing' },
  { fill: 'bg-[#6fa8c7]/80', ink: 'text-void', key: 'body.band_cold' },
  { fill: 'bg-dust/40', ink: 'text-bone', key: 'body.band_comfortable' },
  { fill: 'bg-rust/80', ink: 'text-bone', key: 'body.band_warm' },
  { fill: 'bg-blood/80', ink: 'text-bone', key: 'body.band_overheating' },
]

function healthBand(value: number): Band {
  if (value >= 67) {
    return HEALTH_BANDS[0]
  }
  if (value >= 34) {
    return HEALTH_BANDS[1]
  }

  return HEALTH_BANDS[2]
}

function temperatureBand(celsius: number): Band {
  if (celsius <= 28) {
    return TEMPERATURE_BANDS[0]
  }
  if (celsius <= 32) {
    return TEMPERATURE_BANDS[1]
  }
  if (celsius < 38.5) {
    return TEMPERATURE_BANDS[2]
  }
  if (celsius < 40) {
    return TEMPERATURE_BANDS[3]
  }

  return TEMPERATURE_BANDS[4]
}

/** What an unreported part looks like: inert, not healthy. */
const UNKNOWN_BAND: Band = { fill: 'bg-fence', ink: 'text-smoke', key: 'common.unknown' }

export function BodyMap({ parts, temperature, overall, placeholder = false }: BodyMapProps) {
  const { t } = useTranslation()
  const vocabulary = useGameVocabulary()

  if (Object.keys(parts).length === 0) {
    return null
  }

  const hasTemperature = temperature !== undefined && Object.keys(temperature).length > 0

  return (
    <Panel bracketed>
      <PanelHeader
        label={t('body.map')}
        action={
          <span className="flex items-center gap-2">
            {placeholder ? (
              <span className="border border-fence-bright bg-ash-raised px-2 py-0.5 font-mono text-[0.625rem] tracking-wide text-dust uppercase">
                {t('body.defaults')}
              </span>
            ) : null}
            {overall === undefined ? null : (
              <span className="font-mono text-xs text-smoke tabular-nums">
                {t('body.overall')} {Math.round(overall)}%
              </span>
            )}
          </span>
        }
      />

      <div className="grid grid-cols-1 gap-8 p-6 sm:grid-cols-2">
        <Figure
          title={t('body.mode_health')}
          parts={parts}
          bands={HEALTH_BANDS}
          withWoundPin
          bandFor={(part) => healthBand(parts[part].health)}
          readingFor={(part) => `${Math.round(parts[part].health)}`}
          labelFor={(part) => {
            const entry = parts[part]
            const wounds = entry.wounds.map(vocabulary.wound).join(', ')

            return `${vocabulary.part(part)} — ${Math.round(entry.health)}%${
              wounds ? ` (${wounds})` : ''
            }`
          }}
        />

        {hasTemperature ? (
          <Figure
            title={t('body.mode_temperature')}
            parts={parts}
            bands={TEMPERATURE_BANDS}
            bandFor={(part) => {
              const node = temperature[part]

              return node ? temperatureBand(node.skin) : UNKNOWN_BAND
            }}
            readingFor={(part) => {
              const node = temperature[part]

              return node ? `${Math.round(node.skin)}°` : '—'
            }}
            labelFor={(part) => {
              const node = temperature[part]

              return node
                ? `${vocabulary.part(part)} — ${node.skin.toFixed(1)}°C`
                : vocabulary.part(part)
            }}
          />
        ) : null}
      </div>
    </Panel>
  )
}

interface FigureProps {
  title: string
  parts: Record<string, BodyPartHealth>
  bands: Band[]
  bandFor: (part: string) => Band
  readingFor: (part: string) => string
  labelFor: (part: string) => string
  withWoundPin?: boolean
}

function Figure({
  title,
  parts,
  bands,
  bandFor,
  readingFor,
  labelFor,
  withWoundPin = false,
}: FigureProps) {
  /** Percentages, so the whole figure scales with its container. */
  const pct = (value: number, axis: 'width' | 'height'): string =>
    `${(value / (axis === 'width' ? BODY_CANVAS.width : BODY_CANVAS.height)) * 100}%`

  return (
    <section className="flex flex-col items-center gap-4">
      <h3 className="eyebrow">{title}</h3>

      <div
        className="relative w-full max-w-[190px]"
        style={{ aspectRatio: `${BODY_CANVAS.width} / ${BODY_CANVAS.height}` }}
        role="img"
        aria-label={title}
      >
        {BODY_PART_ORDER.map((name) => {
          const sprite = BODY_SPRITES[name]
          const part = parts[name]
          const band = part ? bandFor(name) : UNKNOWN_BAND
          const wounded = withWoundPin && part && part.wounds.length > 0

          return (
            <div key={name} title={part ? labelFor(name) : undefined}>
              {/*
                The sprite is an alpha mask, so the element's own background is
                what you see. A part the server did not report stays inert
                rather than reading as healthy.
              */}
              <div
                className={band.fill}
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

              {part ? (
                <>
                  {/* Bone ink, not the fill's colour — identity never rides on hue. */}
                  <span
                    className={cn(
                      'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 font-mono text-[10px] leading-none font-semibold tabular-nums',
                      band.ink,
                    )}
                    style={{
                      left: pct(sprite.label[0], 'width'),
                      top: pct(sprite.label[1], 'height'),
                    }}
                  >
                    {readingFor(name)}
                  </span>

                  {/* A mark of its own, so a wound survives a greyscale print. */}
                  {wounded ? (
                    <span
                      className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-void bg-blood"
                      style={{
                        left: pct(sprite.pin[0], 'width'),
                        top: pct(sprite.pin[1], 'height'),
                      }}
                    />
                  ) : null}
                </>
              ) : null}
            </div>
          )
        })}
      </div>

      <Legend bands={bands} withWound={withWoundPin} />
    </section>
  )
}

function Legend({ bands, withWound }: { bands: Band[]; withWound: boolean }) {
  const { t } = useTranslation()

  return (
    <ul className="flex flex-wrap justify-center gap-x-3 gap-y-1.5">
      {bands.map((band) => (
        <li key={band.key} className="flex items-center gap-1.5 text-xs text-dust">
          <span
            aria-hidden="true"
            className={cn('size-2.5 shrink-0 border border-fence-bright', band.fill)}
          />
          {t(band.key)}
        </li>
      ))}

      {withWound ? (
        <li className="flex items-center gap-1.5 text-xs text-dust">
          <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-blood" />
          {t('body.band_wounded')}
        </li>
      ) : null}
    </ul>
  )
}
