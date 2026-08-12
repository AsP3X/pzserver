import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, Clock, Crosshair, HeartPulse, Skull } from 'lucide-react'

import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { StatTile } from '@/components/ui/stat-tile'
import { StatusPill } from '@/components/ui/status-pill'
import { useCurrentUser } from '@/lib/auth'
import { formatNumber, formatRelativeTime } from '@/lib/format'
import { myCharacterQuery, serverStatusQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

/**
 * The player's landing spot.
 *
 * Answers the three questions someone opens this for — is the server up, is my
 * character alive, what happened since I left — and links to the detail rather
 * than repeating it.
 */
export function PlayerOverviewPage() {
  const { t, intlLocale } = useTranslation()
  const { user } = useCurrentUser()
  const { data } = useQuery({ ...myCharacterQuery, enabled: Boolean(user) })
  const { data: status, isPending: statusPending } = useQuery(serverStatusQuery)

  const character = data?.character
  const health = data?.body?.health?.overall ?? character?.vitals?.health ?? null

  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow={t('nav.overview')}
          title={t('me.welcome', { name: user?.username ?? '' })}
          description={t('me.description')}
        />

        <div className="grid gap-6 lg:grid-cols-3">
          <Panel bracketed className="lg:col-span-2">
            <PanelHeader
              label={t('me.your_survivor')}
              action={
                data?.online ? (
                  <StatusPill state="online" label={t('character.online_now')} />
                ) : null
              }
            />

            {character ? (
              <>
                <div className="p-6">
                  <h2 className="display text-3xl text-bone">{character.username}</h2>
                  <p className="mt-1 font-mono text-xs text-dust">
                    {character.profession ?? t('character.no_profession')}
                  </p>
                </div>

                <div className="grid grid-cols-2 divide-x divide-y divide-fence border-t border-fence xl:grid-cols-4 xl:divide-y-0">
                  <StatTile
                    label={t('stats.zombie_kills')}
                    value={formatNumber(character.zombie_kills, intlLocale)}
                    icon={Crosshair}
                  />
                  <StatTile
                    label={t('stats.hours_survived')}
                    value={formatNumber(character.hours_survived, intlLocale)}
                    icon={Clock}
                  />
                  <StatTile
                    label={t('character.health')}
                    value={health === null ? '—' : `${Math.round(health)}%`}
                    icon={HeartPulse}
                  />
                  <StatTile
                    label={t('character.last_seen')}
                    value={formatRelativeTime(character.last_synced_at, intlLocale)}
                    icon={Clock}
                  />
                </div>

                <div className="border-t border-fence p-4">
                  <Link
                    to="/me/character"
                    className="inline-flex items-center gap-2 font-mono text-xs tracking-widest text-hazard uppercase hover:underline"
                  >
                    {t('me.open_character')}
                    <ArrowRight aria-hidden="true" className="size-3.5" />
                  </Link>
                </div>
              </>
            ) : (
              <div className="p-10 text-center">
                <Skull aria-hidden="true" className="mx-auto size-8 text-dust" strokeWidth={1.25} />
                <p className="mt-4 text-sm text-smoke">
                  {t('character.never_played_body', { username: user?.username ?? '' })}
                </p>
              </div>
            )}
          </Panel>

          <Panel bracketed className="h-fit">
            <PanelHeader label={t('nav.status')} />

            <div className="flex flex-col gap-4 p-6">
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

              <dl className="flex flex-col gap-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-smoke">{t('status.players_online')}</dt>
                  <dd className="font-mono text-bone tabular-nums">
                    {status ? status.player_count : '—'}
                    {status?.max_players ? ` / ${status.max_players}` : ''}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-smoke">{t('status.map')}</dt>
                  <dd className="truncate font-mono text-xs text-bone">
                    {status?.map ?? '—'}
                  </dd>
                </div>
              </dl>

              <Link
                to="/status"
                className="inline-flex items-center gap-2 font-mono text-xs tracking-widest text-hazard uppercase hover:underline"
              >
                {t('me.open_status')}
                <ArrowRight aria-hidden="true" className="size-3.5" />
              </Link>
            </div>
          </Panel>
        </div>
      </Container>
    </Section>
  )
}
