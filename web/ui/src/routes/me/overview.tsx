import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, Clock, Coins, Crosshair, HeartPulse, Skull, Users, Vault } from 'lucide-react'

import { Panel, PanelHeader } from '@/components/ui/panel'
import { StatusPill } from '@/components/ui/status-pill'
import { useCurrentUser } from '@/lib/auth'
import { formatCoins, formatNumber, formatRelativeTime } from '@/lib/format'
import { isCondition } from '@/lib/quest-graph'
import {
  myCharacterQuery,
  myFriendsQuery,
  myRewardsQuery,
  myVaultQuery,
  myWalletQuery,
  serverStatusQuery,
} from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

/**
 * The player's landing spot.
 *
 * Server, survivor, coins and what is waiting to be claimed — then a link
 * into the page that owns the detail.
 */
export function PlayerOverviewPage() {
  const { t, intlLocale } = useTranslation()
  const { user } = useCurrentUser()
  const characterQuery = useQuery({ ...myCharacterQuery, enabled: Boolean(user) })
  const status = useQuery(serverStatusQuery)
  const wallet = useQuery(myWalletQuery)
  const vault = useQuery(myVaultQuery)
  const rewards = useQuery(myRewardsQuery)
  const friends = useQuery({ ...myFriendsQuery, enabled: Boolean(user) })
  const incomingFriends = friends.data?.incoming.length ?? 0

  const character = characterQuery.data?.character
  const health =
    characterQuery.data?.body?.health?.overall ?? character?.vitals?.health ?? null
  // Objectives folded into flows, so their share of this badge comes from
  // finished flow steps now rather than a list of its own.
  const readySteps =
    rewards.data?.quests.reduce(
      (sum, quest) =>
        sum +
        quest.nodes.filter(
          (node) => node.unlocked && node.complete && !node.claimed && isCondition(node.kind),
        ).length,
      0,
    ) ?? 0
  const ready =
    (rewards.data?.daily.available ? 1 : 0) +
    (rewards.data?.tasks.filter((task) => task.complete && !task.claimed).length ?? 0) +
    readySteps +
    (rewards.data?.available_quests.length ?? 0)

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header>
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="hazard-tape h-1 w-8" />
          <span className="eyebrow">{t('nav.group.survivor')}</span>
        </div>
        <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">
          {t('me.welcome', { name: user?.username ?? '' })}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-smoke">{t('me.description')}</p>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-3">
        <Panel bracketed className="flex min-h-0 flex-col lg:col-span-2">
          <PanelHeader
            label={t('me.your_survivor')}
            action={
              characterQuery.data?.online ? (
                <StatusPill state="online" label={t('character.online_now')} />
              ) : null
            }
          />
          {character ? (
            <>
              <div className="p-5">
                <h2 className="display text-3xl text-bone">{character.username}</h2>
                <p className="mt-1 font-mono text-xs text-dust">
                  {character.profession ?? t('character.no_profession')}
                </p>
              </div>
              <div className="grid grid-cols-2 divide-x divide-y divide-fence border-t border-fence xl:grid-cols-4 xl:divide-y-0">
                <Stat
                  label={t('stats.zombie_kills')}
                  value={formatNumber(character.zombie_kills, intlLocale)}
                  icon={Crosshair}
                />
                <Stat
                  label={t('stats.hours_survived')}
                  value={formatNumber(character.hours_survived, intlLocale)}
                  icon={Clock}
                />
                <Stat
                  label={t('character.health')}
                  value={health === null ? '—' : `${Math.round(health)}%`}
                  icon={HeartPulse}
                />
                <Stat
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
            <div className="flex flex-1 flex-col items-center justify-center p-10 text-center">
              <Skull aria-hidden="true" className="size-8 text-dust" strokeWidth={1.25} />
              <p className="mt-4 text-sm text-smoke">
                {t('character.never_played_body', { username: user?.username ?? '' })}
              </p>
            </div>
          )}
        </Panel>

        <div className="flex flex-col gap-3">
          <Panel bracketed>
            <PanelHeader label={t('nav.status')} />
            <div className="flex flex-col gap-4 p-5">
              <StatusPill
                state={status.isPending ? undefined : status.data?.state}
                label={
                  status.isPending
                    ? t('status.checking')
                    : status.data?.state === 'online'
                      ? t('status.online')
                      : status.data?.state === 'starting'
                        ? t('status.starting')
                        : t('status.offline')
                }
              />
              <dl className="flex flex-col gap-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-smoke">{t('status.players_online')}</dt>
                  <dd className="font-mono text-bone tabular-nums">
                    {status.data ? status.data.player_count : '—'}
                    {status.data?.max_players ? ` / ${status.data.max_players}` : ''}
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

          <Panel bracketed>
            <PanelHeader
              label={t('nav.friends')}
              action={
                incomingFriends > 0 ? (
                  <span className="font-mono text-[0.6875rem] tracking-widest text-hazard uppercase">
                    {t('me.friends_waiting', { count: incomingFriends })}
                  </span>
                ) : null
              }
            />
            <div className="flex flex-col gap-3 p-5">
              <p className="flex items-center gap-2 font-mono text-sm text-bone">
                <Users aria-hidden="true" className="size-4 text-dust" strokeWidth={1.5} />
                {t('me.friends_count', { count: friends.data?.friends.length ?? 0 })}
              </p>
              <Link
                to="/me/friends"
                className="inline-flex items-center gap-2 font-mono text-xs tracking-widest text-hazard uppercase hover:underline"
              >
                {t('me.open_friends')}
                <ArrowRight aria-hidden="true" className="size-3.5" />
              </Link>
            </div>
          </Panel>

          <Panel bracketed>
            <PanelHeader label={t('nav.wallet')} />
            <div className="flex flex-col gap-3 p-5">
              <p className="display text-2xl text-bone tabular-nums">
                {wallet.data ? formatCoins(wallet.data.available, intlLocale) : '—'}
              </p>
              {ready > 0 ? (
                <p className="font-mono text-[0.6875rem] text-hazard">
                  {t('me.ready_rewards', { count: ready })}
                </p>
              ) : null}
              <Link
                to="/me/wallet"
                className="inline-flex items-center gap-2 font-mono text-xs tracking-widest text-hazard uppercase hover:underline"
              >
                {t('me.open_wallet')}
                <ArrowRight aria-hidden="true" className="size-3.5" />
              </Link>
            </div>
          </Panel>

          <Panel bracketed>
            <PanelHeader label={t('nav.vault')} />
            <div className="flex flex-col gap-3 p-5">
              <p className="flex items-center gap-2 font-mono text-sm text-bone">
                <Vault aria-hidden="true" className="size-4 text-dust" strokeWidth={1.5} />
                {vault.data
                  ? t('me.vault_slots', {
                      used: vault.data.capacity.used,
                      total: vault.data.capacity.total,
                    })
                  : '—'}
              </p>
              <Link
                to="/me/vault"
                className="inline-flex items-center gap-2 font-mono text-xs tracking-widest text-hazard uppercase hover:underline"
              >
                {t('me.open_vault')}
                <ArrowRight aria-hidden="true" className="size-3.5" />
              </Link>
            </div>
          </Panel>
        </div>
      </div>
    </section>
  )
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: string
  icon: typeof Coins
}) {
  return (
    <div className="flex items-start gap-3 p-4">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-dust" strokeWidth={1.5} />
      <div>
        <p className="display text-xl text-bone tabular-nums">{value}</p>
        <p className="mt-1 font-mono text-[0.625rem] tracking-widest text-dust uppercase">{label}</p>
      </div>
    </div>
  )
}
