import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Biohazard,
  Clock,
  Crosshair,
  Flame,
  HelpCircle,
  Skull,
  Swords,
  Trophy,
  type LucideIcon,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { StatTile } from '@/components/ui/stat-tile'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatNumber, formatRelativeTime } from '@/lib/format'
import { obituaryQuery, obituarySummaryQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { Obit } from '@/lib/api'
import type { TranslationKey } from '@/i18n/locales'

interface CauseStyle {
  icon: LucideIcon
  /** Text colour for the cause, and the rule down the left of the entry. */
  tone: string
  rule: string
  label: TranslationKey
}

/**
 * How each cause reads.
 *
 * Colour is never the only signal — every entry says its cause in words and
 * carries a distinct icon, so the roll survives being read in greyscale or by
 * someone who cannot separate the red from the amber.
 */
const CAUSES: Record<string, CauseStyle> = {
  player: {
    icon: Crosshair,
    tone: 'text-blood',
    rule: 'bg-blood',
    label: 'obituary.cause.player',
  },
  infection: {
    icon: Biohazard,
    tone: 'text-moss',
    rule: 'bg-moss',
    label: 'obituary.cause.infection',
  },
  fire: {
    icon: Flame,
    tone: 'text-hazard',
    rule: 'bg-hazard',
    label: 'obituary.cause.fire',
  },
  unknown: {
    icon: HelpCircle,
    tone: 'text-dust',
    rule: 'bg-fence-bright',
    label: 'obituary.cause.unknown',
  },
}

/**
 * The dead, most recent first.
 *
 * The server log records that somebody died. What it cannot say is why — a
 * bite, a fire, a fall, or another player — and that is only knowable from
 * inside the game at the moment it happens. This page is the mod's account of
 * it, which is the only account there is.
 */
export function ObituaryPage() {
  const { t, intlLocale } = useTranslation()

  const { data: summary } = useQuery(obituarySummaryQuery)
  const { data: firstPage, isPending } = useQuery(obituaryQuery)

  // Pages already fetched, in order. Kept here rather than in the cache
  // because "the roll so far" is a property of this screen, not of the data:
  // navigating away and back should start at the top again.
  const [older, setOlder] = useState<Obit[]>([])
  // Three states, not two: `undefined` is "nothing paged yet, use the first
  // page's cursor" and `null` is "the roll ended". Collapsing them with `??`
  // makes the end of the roll look like the beginning and the button never
  // goes away.
  const [cursor, setCursor] = useState<string | null | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const nextCursor = cursor === undefined ? (firstPage?.next_before ?? null) : cursor
  const deaths = [...(firstPage?.deaths ?? []), ...older]

  const loadMore = async () => {
    if (!nextCursor || loading) {
      return
    }

    setLoading(true)
    setFailed(false)

    try {
      const page = await api.obituary(nextCursor)

      setOlder((current) => [...current, ...page.deaths])
      setCursor(page.next_before)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  const hours = (value: number) =>
    value.toLocaleString(intlLocale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })

  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow={t('nav.obituary')}
          title={t('obituary.title')}
          description={t('obituary.description')}
        />

        <div className="mb-8 grid grid-cols-2 gap-px border border-fence bg-fence lg:grid-cols-4">
          <StatTile
            className="bg-ash"
            icon={Skull}
            label={t('obituary.total_deaths')}
            value={summary && formatNumber(summary.total_deaths, intlLocale)}
          />
          <StatTile
            className="bg-ash"
            icon={Swords}
            label={t('obituary.by_another_hand')}
            value={summary && formatNumber(summary.total_pvp_deaths, intlLocale)}
          />
          <StatTile
            className="bg-ash"
            icon={Clock}
            label={t('obituary.longest_life')}
            value={summary && t('obituary.hours', { count: hours(summary.longest_life) })}
          />
          <StatTile
            className="bg-ash"
            icon={Trophy}
            label={t('obituary.deadliest')}
            value={
              summary && (summary.deadliest_survivor ?? t('obituary.nobody'))
            }
          />
        </div>

        {isPending ? (
          <Skeleton className="h-96 w-full" />
        ) : deaths.length === 0 ? (
          <Panel bracketed className="p-10 text-center">
            <Skull aria-hidden="true" className="mx-auto size-8 text-dust" strokeWidth={1.25} />
            <h3 className="display mt-4 text-2xl text-bone">{t('obituary.empty_title')}</h3>
            <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-smoke">
              {t('obituary.empty_body')}
            </p>
          </Panel>
        ) : (
          <>
            <Panel bracketed>
              <ul className="divide-y divide-fence">
                {deaths.map((death) => (
                  <Entry
                    key={`${death.username}-${death.occurred_at}`}
                    death={death}
                    locale={intlLocale}
                  />
                ))}
              </ul>
            </Panel>

            <div className="mt-6 text-center">
              {failed ? (
                <p role="alert" className="mb-3 text-sm text-blood">
                  {t('obituary.load_failed')}
                </p>
              ) : null}

              {nextCursor ? (
                <Button variant="outline" onClick={() => void loadMore()} disabled={loading}>
                  {loading ? t('common.loading') : t('obituary.load_more')}
                </Button>
              ) : (
                <p className="font-mono text-xs tracking-widest text-dust uppercase">
                  {t('obituary.end_of_roll')}
                </p>
              )}
            </div>
          </>
        )}
      </Container>
    </Section>
  )
}

/** `Base.Axe` — the game's own name, minus the namespace nobody needs. */
function weaponName(fullType: string): string {
  return fullType.split('.').pop() ?? fullType
}

function Entry({ death, locale }: { death: Obit; locale: string }) {
  const { t } = useTranslation()

  const style = CAUSES[death.cause] ?? CAUSES.unknown!
  const Icon = style.icon

  // A cause the mod has learned to tell apart since this page was written is
  // shown as it was written, rather than flattened into "unknown".
  const cause = CAUSES[death.cause] ? t(style.label) : death.cause

  return (
    <li className="flex items-stretch gap-0">
      <span aria-hidden="true" className={cn('w-0.5 shrink-0', style.rule)} />

      <div className="flex min-w-0 flex-1 flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
        <span className="flex min-w-0 flex-1 items-start gap-3">
          <Icon
            aria-hidden="true"
            className={cn('mt-0.5 size-4 shrink-0', style.tone)}
            strokeWidth={1.5}
          />

          <span className="min-w-0">
            <span className="block truncate text-sm text-bone">{death.username}</span>

            <span className="mt-0.5 block font-mono text-[0.6875rem] tracking-wide text-dust uppercase">
              <span className={style.tone}>{cause}</span>
              {death.killer ? (
                <>
                  {' · '}
                  {t('obituary.killed_by', { name: death.killer })}
                  {death.weapon ? ` (${weaponName(death.weapon)})` : ''}
                </>
              ) : null}
            </span>
          </span>
        </span>

        <span className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1 pl-7 font-mono text-[0.6875rem] text-dust sm:justify-end sm:pl-0">
          {/* Zeroes are left off rather than printed. A death the mod recorded
              nothing else about should read as a name and a cause, not as a
              row of noughts implying the character achieved nothing. */}
          {death.hours_survived > 0 ? (
            <span className="tabular-nums">
              {t('obituary.survived', {
                count: death.hours_survived.toLocaleString(locale, {
                  minimumFractionDigits: 1,
                  maximumFractionDigits: 1,
                }),
              })}
            </span>
          ) : null}

          {death.zombie_kills > 0 ? (
            <span className="tabular-nums">
              {t('obituary.took_down', { count: formatNumber(death.zombie_kills, locale) })}
            </span>
          ) : null}

          {/* Only boxed and right-aligned once the metadata is on one line
              with everything else; on a phone it wraps and a fixed width just
              strands it mid-row. */}
          <span className="tabular-nums sm:w-28 sm:text-right">
            {formatRelativeTime(death.occurred_at, locale)}
          </span>
        </span>
      </div>
    </li>
  )
}
