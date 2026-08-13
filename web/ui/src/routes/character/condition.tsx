import { Droplet, Snowflake, Syringe, Thermometer } from 'lucide-react'

import { Meter } from '@/components/ui/meter'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { cn } from '@/lib/cn'
import { coldestPart, temperatureState } from '@/lib/body'
import { useGameVocabulary } from '@/routes/character/vocabulary'
import { formatRelativeTime } from '@/lib/format'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'
import type { BodyWound, Character, PlayerBody } from '@/lib/api'
import type { TemperatureState } from '@/lib/body'

/** A part is worth listing once it is off full health or carrying a wound. */
const INTACT = 100

interface ConditionProps {
  /** Null until the ten-minute export has been folded into Postgres. */
  character: Character | null
  /** The mod's heartbeat, when there is one. */
  body: PlayerBody | null
}

export function Condition({ character, body }: ConditionProps) {
  const { t, intlLocale } = useTranslation()

  const summary = character?.vitals ?? null
  const overall = body?.health?.overall ?? summary?.health ?? null

  if (overall === null && !body?.temperature) {
    return null
  }

  return (
    <Panel bracketed>
      <PanelHeader
        label={t('character.condition')}
        action={
          body?.reported_at ? (
            <span className="font-mono text-[0.6875rem] text-dust">
              {formatRelativeTime(body.reported_at, intlLocale)}
            </span>
          ) : null
        }
      />

      <div className="p-6">
        {overall !== null ? (
          <Meter
            label={t('character.health')}
            value={overall}
            readout={`${Math.round(overall)}%`}
          />
        ) : null}

        {body?.temperature ? <Temperature temperature={body.temperature} /> : null}

        <div className="mt-6 grid grid-cols-1 gap-px bg-fence sm:grid-cols-3">
          <Flag
            icon={Droplet}
            label={t('character.bleeding')}
            active={(summary?.bleeding_parts ?? 0) > 0}
            detail={
              summary && summary.bleeding_parts > 0
                ? summary.bleeding_parts === 1
                  ? t('character.bleeding_part_one')
                  : t('character.bleeding_parts_other', { count: summary.bleeding_parts })
                : t('character.none')
            }
          />
          <Flag
            icon={Syringe}
            label={t('character.infection')}
            active={summary?.infected ?? false}
            detail={summary?.infected ? t('character.infected') : t('character.clear')}
          />
          <Flag
            icon={Snowflake}
            label={t('character.cold')}
            active={summary?.has_cold ?? false}
            detail={summary?.has_cold ? t('character.has_cold') : t('character.clear')}
          />
        </div>

        {body?.health ? <Injuries body={body} /> : null}
      </div>
    </Panel>
  )
}

function Temperature({
  temperature,
}: {
  temperature: NonNullable<PlayerBody['temperature']>
}) {
  const { t, intlLocale } = useTranslation()
  const vocabulary = useGameVocabulary()

  // Both readings go through Intl, or German shows 35.8 next to 18,7.
  const degrees = (value: number) =>
    value.toLocaleString(intlLocale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })

  const state = temperatureState(temperature.core)
  const coldest = coldestPart(temperature.parts)

  const tone: Record<TemperatureState, string> = {
    freezing: 'text-blood',
    cold: 'text-hazard',
    normal: 'text-moss',
    warm: 'text-hazard',
    overheating: 'text-blood',
  }

  const stateLabel: Record<TemperatureState, TranslationKey> = {
    freezing: 'character.temp_freezing',
    cold: 'character.temp_cold',
    normal: 'character.temp_normal',
    warm: 'character.temp_warm',
    overheating: 'character.temp_overheating',
  }

  return (
    <div className="mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-fence pt-5">
      <div className="flex items-center gap-2">
        <Thermometer aria-hidden="true" className="size-3.5 text-dust" strokeWidth={1.5} />
        <span className="eyebrow">{t('character.body_temperature')}</span>
      </div>

      <span className={cn('display text-2xl', tone[state])}>
        {degrees(temperature.core)}°C
      </span>
      <span className={cn('font-mono text-xs uppercase', tone[state])}>
        {t(stateLabel[state])}
      </span>

      {coldest ? (
        <span className="font-mono text-xs text-dust">
          {t('character.coldest_part', {
            part: vocabulary.part(coldest.part),
            degrees: degrees(coldest.skin),
          })}
        </span>
      ) : null}
    </div>
  )
}

function Injuries({ body }: { body: PlayerBody }) {
  const { t } = useTranslation()
  const vocabulary = useGameVocabulary()

  const hurt = Object.entries(body.health?.parts ?? {})
    .filter(([, part]) => part.health < INTACT || part.wounds.length > 0)
    .sort(([, left], [, right]) => left.health - right.health)

  const woundsByPart = new Map<string, BodyWound[]>()
  for (const wound of body.wounds ?? []) {
    woundsByPart.set(wound.part, [...(woundsByPart.get(wound.part) ?? []), wound])
  }

  return (
    <div className="mt-6 border-t border-fence pt-5">
      <span className="eyebrow">{t('character.injuries')}</span>

      {hurt.length === 0 ? (
        <p className="mt-2 text-sm text-moss">{t('character.no_injuries')}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {hurt.map(([name, part]) => (
            <li key={name} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-40 text-sm text-bone">{vocabulary.part(name)}</span>

              <span
                className={cn(
                  'font-mono text-xs tabular-nums',
                  part.health < 34
                    ? 'text-blood'
                    : part.health < 67
                      ? 'text-hazard'
                      : 'text-smoke',
                )}
              >
                {Math.round(part.health)}%
              </span>

              {(woundsByPart.get(name) ?? []).map((wound, index) => (
                <span
                  key={`${wound.type}-${index}`}
                  className={cn(
                    'border px-1.5 py-0.5 font-mono text-[0.625rem] tracking-wide uppercase',
                    wound.treated
                      ? 'border-fence-bright bg-ash-raised text-smoke'
                      : 'border-blood/40 bg-blood-soft text-blood',
                  )}
                >
                  {vocabulary.wound(wound.type)}
                  {wound.treated ? ` · ${t('character.treated')}` : ''}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Flag({
  icon: Icon,
  label,
  active,
  detail,
}: {
  icon: typeof Droplet
  label: string
  active: boolean
  detail: string
}) {
  return (
    <div className="bg-ash px-4 py-4">
      <div className="flex items-center gap-2">
        <Icon
          aria-hidden="true"
          className={cn('size-3.5', active ? 'text-blood' : 'text-dust')}
          strokeWidth={1.5}
        />
        <span className="eyebrow">{label}</span>
      </div>
      <p className={cn('mt-1.5 text-sm', active ? 'text-blood' : 'text-smoke')}>{detail}</p>
    </div>
  )
}
