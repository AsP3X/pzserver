import { useQuery } from '@tanstack/react-query'

import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import { useTranslation } from '@/i18n/use-translation'
import { formatNumber } from '@/lib/format'
import { leaderboardQuery } from '@/lib/queries'

export function Survivors() {
  const { t, intlLocale } = useTranslation()
  const { data: entries, isPending } = useQuery(leaderboardQuery())

  return (
    <Section id="survivors" className="border-b border-fence">
      <Container>
        <SectionHeading
          eyebrow={t('survivors.eyebrow')}
          title={t('survivors.title')}
          description={t('survivors.subtitle')}
        />

        <Panel bracketed className="overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-fence">
                <Th className="w-16">{t('survivors.rank')}</Th>
                <Th>{t('survivors.player')}</Th>
                <Th>{t('survivors.profession')}</Th>
                <Th className="text-right">{t('survivors.kills')}</Th>
                <Th className="text-right">{t('survivors.hours')}</Th>
              </tr>
            </thead>
            <tbody>
              {isPending ? (
                Array.from({ length: 6 }, (_, index) => (
                  <tr key={index} className="border-b border-fence last:border-0">
                    <td colSpan={5} className="px-4 py-3.5">
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
                          // Only the podium gets the accent; past that it is noise.
                          entry.rank <= 3 ? 'text-hazard' : 'text-dust',
                        )}
                      >
                        {String(entry.rank).padStart(2, '0')}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="display text-lg text-bone">
                        {entry.username}
                      </span>
                      {entry.is_dead ? (
                        <span className="ml-2 border border-blood/40 bg-blood-soft px-1.5 py-0.5 font-mono text-[0.625rem] tracking-widest text-blood uppercase">
                          {t('survivors.dead')}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3.5 text-sm text-smoke">
                      {entry.profession ?? '—'}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-sm text-bone tabular-nums">
                      {formatNumber(entry.zombie_kills, intlLocale)}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-sm text-smoke tabular-nums">
                      {formatNumber(entry.hours_survived, intlLocale)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-dust">
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

function Th({ children, className }: { children: string; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        'px-4 py-3 font-mono text-[0.6875rem] font-normal tracking-widest text-dust uppercase',
        className,
      )}
    >
      {children}
    </th>
  )
}
