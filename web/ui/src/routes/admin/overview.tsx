import { useQuery } from '@tanstack/react-query'
import { Activity, Clock, Crosshair, Server, Skull, Users } from 'lucide-react'

import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Sparkline } from '@/components/ui/sparkline'
import { StatTile } from '@/components/ui/stat-tile'
import { StatusPill } from '@/components/ui/status-pill'
import { formatNumber, formatUptime } from '@/lib/format'
import {
  serverHistoryQuery,
  serverStatusQuery,
  statsSummaryQuery,
} from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

/**
 * What an operator wants on opening the panel: is it up, who is on it, and has
 * anything changed. Controls live in their own sections — this page reports.
 */
export function AdminOverviewPage() {
  const { t, intlLocale } = useTranslation()
  const { data: status, isPending: statusPending } = useQuery(serverStatusQuery)
  const { data: stats } = useQuery(statsSummaryQuery)
  const { data: history } = useQuery(serverHistoryQuery)

  return (
    <Section className="py-10">
      <Container className="max-w-none">
        <SectionHeading
          eyebrow={t('nav.surface_admin')}
          title={t('admin.overview_title')}
          description={t('admin.overview_description')}
        />

        <div className="grid gap-6 xl:grid-cols-3">
          <Panel bracketed className="xl:col-span-2">
            <PanelHeader
              label={t('admin.server')}
              action={
                <StatusPill
                  state={statusPending ? undefined : status?.state}
                  label={
                    statusPending
                      ? t('status.checking')
                      : status
                        ? t(`status.${status.state}`)
                        : t('status.offline')
                  }
                />
              }
            />

            <div className="grid grid-cols-2 divide-x divide-y divide-fence 2xl:grid-cols-4 2xl:divide-y-0">
              <StatTile
                label={t('status.players_online')}
                value={
                  status
                    ? `${status.player_count}${status.max_players ? ` / ${status.max_players}` : ''}`
                    : undefined
                }
                icon={Users}
              />
              <StatTile
                label={t('status.uptime')}
                value={
                  status
                    ? status.uptime_seconds === null
                      ? '—'
                      : formatUptime(status.uptime_seconds, {
                          days: t('common.days_short'),
                          hours: t('common.hours_short'),
                          minutes: t('common.minutes_short'),
                        })
                    : undefined
                }
                icon={Clock}
              />
              <StatTile
                label={t('admin.container')}
                value={status ? status.container.replace('_', ' ') : undefined}
                icon={Server}
              />
              <StatTile
                label={t('admin.feed')}
                value={status ? t(`status.source_${status.data_source}`) : undefined}
                icon={Activity}
              />
            </div>

            <div className="border-t border-fence px-4 py-4">
              <span className="eyebrow">{t('status.activity_24h')}</span>
              {history && history.length > 1 ? (
                <Sparkline
                  className="mt-3"
                  values={history.map((sample) => sample.player_count)}
                  label={t('status.activity_24h')}
                />
              ) : (
                <p className="mt-3 text-xs text-dust">{t('status.no_activity')}</p>
              )}
            </div>
          </Panel>

          <Panel bracketed className="h-fit">
            <PanelHeader label={t('admin.world')} />

            <div className="grid grid-cols-2 divide-x divide-y divide-fence">
              <StatTile
                label={t('stats.total_players')}
                value={stats ? formatNumber(stats.total_players, intlLocale) : undefined}
                icon={Users}
              />
              <StatTile
                label={t('stats.deaths')}
                value={stats ? formatNumber(stats.total_deaths, intlLocale) : undefined}
                icon={Skull}
              />
              <StatTile
                label={t('stats.zombie_kills')}
                value={stats ? formatNumber(stats.total_zombie_kills, intlLocale) : undefined}
                icon={Crosshair}
              />
              <StatTile
                label={t('stats.pvp_kills')}
                value={stats ? formatNumber(stats.total_pvp_kills, intlLocale) : undefined}
                icon={Crosshair}
              />
            </div>
          </Panel>
        </div>

        {/* Honest about the state of the port rather than shipping dead links. */}
        <Panel className="mt-6 border-dashed p-5">
          <p className="text-sm text-smoke">{t('admin.under_construction')}</p>
        </Panel>
      </Container>
    </Section>
  )
}
