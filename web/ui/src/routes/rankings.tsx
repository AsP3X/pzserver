import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import { formatNumber } from '@/lib/format'
import { leaderboardQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'
import type { LeaderboardStat } from '@/lib/api'

interface Board {
  stat: LeaderboardStat
  label: TranslationKey
}

/**
 * Every board shows the same columns and differs only in what it sorts by, so
 * switching tabs moves the ordering rather than rebuilding the table. The
 * leading column is highlighted so it is obvious which one is in charge.
 */
const BOARDS: Board[] = [
  { stat: 'zombie_kills', label: 'rankings.by_kills' },
  { stat: 'hours_survived', label: 'rankings.by_hours' },
  { stat: 'deaths', label: 'rankings.by_deaths' },
]

export function RankingsPage() {
  const { t, intlLocale } = useTranslation()
  const [stat, setStat] = useState<LeaderboardStat>('zombie_kills')

  const { data: entries, isPending } = useQuery(leaderboardQuery(stat, 25))

  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow={t('survivors.eyebrow')}
          title={t('rankings.title')}
          description={t('rankings.subtitle')}
        />

        <div role="tablist" aria-label={t('rankings.title')} className="mb-6 flex flex-wrap gap-2">
          {BOARDS.map((board) => (
            <button
              key={board.stat}
              type="button"
              role="tab"
              aria-selected={stat === board.stat}
              onClick={() => setStat(board.stat)}
              className={cn(
                'border px-4 py-2 font-mono text-xs tracking-widest uppercase transition-colors',
                stat === board.stat
                  ? 'border-hazard bg-hazard-soft text-hazard'
                  : 'border-fence text-smoke hover:border-fence-bright hover:text-bone',
              )}
            >
              {t(board.label)}
            </button>
          ))}
        </div>

        <Panel bracketed className="overflow-x-auto">
          <table className="w-full min-w-[42rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-fence">
                <Th className="w-16">{t('survivors.rank')}</Th>
                <Th>{t('survivors.player')}</Th>
                <Th>{t('survivors.profession')}</Th>
                <Th className="text-right" leading={stat === 'zombie_kills'}>
                  {t('survivors.kills')}
                </Th>
                <Th className="text-right" leading={stat === 'hours_survived'}>
                  {t('survivors.hours')}
                </Th>
                <Th className="text-right" leading={stat === 'deaths'}>
                  {t('stats.deaths')}
                </Th>
              </tr>
            </thead>
            <tbody>
              {isPending ? (
                Array.from({ length: 10 }, (_, index) => (
                  <tr key={index} className="border-b border-fence last:border-0">
                    <td colSpan={6} className="px-4 py-3.5">
                      <Skeleton className="h-5 w-full" />
                    </td>
                  </tr>
                ))
              ) : entries && entries.length > 0 ? (
                entries.map((entry) => (
                  <tr
                    key={entry.username}
                    className="border-b border-fence transition-colors last:border-0 hover:bg-ash-raised"
                  >
                    <td className="px-4 py-3.5">
                      <span
                        className={cn(
                          'font-mono text-sm tabular-nums',
                          entry.rank <= 3 ? 'text-hazard' : 'text-dust',
                        )}
                      >
                        {String(entry.rank).padStart(2, '0')}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="display text-lg text-bone">{entry.username}</span>
                      {entry.is_dead ? (
                        <span className="ml-2 border border-blood/40 bg-blood-soft px-1.5 py-0.5 font-mono text-[0.625rem] tracking-widest text-blood uppercase">
                          {t('survivors.dead')}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3.5 text-sm text-smoke">
                      {entry.profession ?? '—'}
                    </td>
                    <Cell value={entry.zombie_kills} leading={stat === 'zombie_kills'} locale={intlLocale} />
                    <Cell value={entry.hours_survived} leading={stat === 'hours_survived'} locale={intlLocale} />
                    <Cell value={entry.deaths} leading={stat === 'deaths'} locale={intlLocale} />
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-dust">
                    {t('survivors.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Panel>
      </Container>
    </Section>
  )
}

function Th({
  children,
  className,
  leading = false,
}: {
  children: string
  className?: string
  leading?: boolean
}) {
  return (
    <th
      scope="col"
      aria-sort={leading ? 'descending' : undefined}
      className={cn(
        'px-4 py-3 font-mono text-[0.6875rem] font-normal tracking-widest uppercase',
        leading ? 'text-hazard' : 'text-dust',
        className,
      )}
    >
      {children}
    </th>
  )
}

function Cell({
  value,
  leading,
  locale,
}: {
  value: number
  leading: boolean
  locale: string
}) {
  return (
    <td
      className={cn(
        'px-4 py-3.5 text-right font-mono text-sm tabular-nums',
        leading ? 'text-bone' : 'text-smoke',
      )}
    >
      {formatNumber(value, locale)}
    </td>
  )
}
