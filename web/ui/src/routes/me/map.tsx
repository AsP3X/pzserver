import { useQuery } from '@tanstack/react-query'
import { Layers, Navigation } from 'lucide-react'

import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { WorldmapView } from '@/components/ui/worldmap'
import { formatNumber, formatRelativeTime } from '@/lib/format'
import { myPositionQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

/**
 * Where the survivor is standing.
 *
 * The mod writes everyone's position every thirty real seconds, and the file
 * outlives the session — so a position with an old stamp is not a stale
 * reading to hide, it is the spot the player logged out at, which is exactly
 * what somebody planning their next run wants to know. The page says which of
 * the two it is showing rather than picking one and hoping.
 */
export function MapPage() {
  const { t, intlLocale } = useTranslation()

  const { data, isPending } = useQuery(myPositionQuery)
  const position = data?.position ?? null

  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow={t('nav.map')}
          title={t('map.title')}
          description={t('map.description')}
        />

        {isPending ? (
          <Skeleton className="h-[32rem] w-full" />
        ) : (
          <div className="flex flex-col gap-5">
            <Panel bracketed>
              <PanelHeader
                label={t('map.last_known')}
                action={
                  <span className="flex items-center gap-3 font-mono text-[0.6875rem] text-dust">
                    <span
                      className={
                        data?.online ? 'text-moss' : 'text-dust'
                      }
                    >
                      {data?.online ? t('map.in_game') : t('map.logged_out')}
                    </span>
                    {data?.reported_at ? (
                      <span>{formatRelativeTime(data.reported_at, intlLocale)}</span>
                    ) : null}
                  </span>
                }
              />

              <div className="flex flex-wrap items-center gap-x-8 gap-y-3 p-5">
                {position ? (
                  <>
                    <Reading
                      icon={Navigation}
                      label={t('map.coordinates')}
                      value={`${formatNumber(Math.round(position.x), intlLocale)}, ${formatNumber(Math.round(position.y), intlLocale)}`}
                    />
                    <Reading
                      icon={Layers}
                      label={t('map.floor')}
                      value={
                        position.z === 0
                          ? t('map.ground_floor')
                          : t('map.floor_number', { count: position.z })
                      }
                    />
                  </>
                ) : (
                  <p className="text-sm text-dust">{t('map.no_position')}</p>
                )}
              </div>
            </Panel>

            <WorldmapView
              marker={position}
              className="h-[26rem] sm:h-[34rem]"
            />

            <p className="font-mono text-[0.6875rem] tracking-wide text-dust">
              {t('map.attribution')}
            </p>
          </div>
        )}
      </Container>
    </Section>
  )
}

function Reading({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Navigation
  label: string
  value: string
}) {
  return (
    <span className="flex items-center gap-2.5">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-dust" strokeWidth={1.5} />
      <span>
        <span className="block font-mono text-sm text-bone tabular-nums">{value}</span>
        <span className="block font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
          {label}
        </span>
      </span>
    </span>
  )
}
