import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { Skull, Swords, Timer, Trophy, UserPlus } from 'lucide-react'
import { useMemo } from 'react'

import { Button } from '@/components/ui/button'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Container, Section } from '@/components/ui/section'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import { formatDateTime, formatNumber } from '@/lib/format'
import { myFriendsQuery, playerProfileQuery } from '@/lib/queries'
import { useCurrentUser } from '@/lib/auth'
import { useTranslation } from '@/i18n/use-translation'
import { api, ApiError, type PlayerProfile } from '@/lib/api'

/**
 * One survivor's public record.
 *
 * Built only from what happened in the world — kills, hours, deaths, perks.
 * Nothing from the account behind the character appears here: the page is
 * readable by anyone, and an email address is not part of a survivor's story.
 */
export function PlayerProfilePage() {
  const { t, intlLocale } = useTranslation()
  // `strict: false` matches the other param routes here: the generated route
  // tree types are not wired up, so the id cannot be checked at compile time.
  const { username } = useParams({ strict: false }) as { username: string }
  const { data, isPending, isError } = useQuery(playerProfileQuery(username))
  const { user } = useCurrentUser()
  const friends = useQuery({ ...myFriendsQuery, enabled: Boolean(user) })
  const queryClient = useQueryClient()

  const relation = useMemo(() => {
    if (!user || !data) {
      return 'none' as const
    }
    if (user.username.toLowerCase() === data.username.toLowerCase()) {
      return 'self' as const
    }
    const lists = friends.data
    if (!lists) {
      return 'none' as const
    }
    const match = (card: { username: string }) =>
      card.username.toLowerCase() === data.username.toLowerCase()
    if (lists.friends.some(match)) {
      return 'friends' as const
    }
    if (lists.outgoing.some(match)) {
      return 'outgoing' as const
    }
    if (lists.incoming.some(match)) {
      return 'incoming' as const
    }
    if (lists.blocked.some(match)) {
      return 'blocked' as const
    }
    return 'none' as const
  }, [data, friends.data, user])

  const incoming = friends.data?.incoming.find(
    (card) => card.username.toLowerCase() === username.toLowerCase(),
  )

  const send = useMutation({
    mutationFn: () => api.sendFriendRequest(data?.username ?? username),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me', 'friends'] }),
  })
  const accept = useMutation({
    mutationFn: () => api.friendAction(incoming!.id, 'accept'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me', 'friends'] }),
  })

  if (isPending) {
    return (
      <Section>
        <Container>
          <Skeleton className="h-64 w-full" />
        </Container>
      </Section>
    )
  }

  if (isError || !data) {
    return (
      <Section>
        <Container>
          <p className="text-sm text-dust">{t('profile.not_found', { name: username })}</p>
          <Link to="/rankings" className="mt-3 inline-block text-hazard hover:underline">
            {t('profile.back')}
          </Link>
        </Container>
      </Section>
    )
  }

  const skills = Object.entries(data.skills ?? {})
    .filter(([, level]) => typeof level === 'number' && level > 0)
    .sort(([, a], [, b]) => b - a)

  return (
    <Section>
      <Container>
        <header className="mb-6">
          <Link to="/rankings" className="eyebrow text-hazard hover:underline">
            {t('profile.back')}
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="display text-3xl text-bone sm:text-4xl">{data.username}</h1>
            {data.is_dead ? (
              <span className="border border-blood/40 bg-blood-soft px-2 py-1 font-mono text-[0.625rem] tracking-widest text-blood uppercase">
                {t('survivors.dead')}
              </span>
            ) : null}
            {relation === 'none' && user ? (
              <Button
                size="sm"
                onClick={() => send.mutate()}
                disabled={send.isPending}
              >
                <UserPlus aria-hidden="true" className="size-3.5" />
                {t('profile.add_friend')}
              </Button>
            ) : null}
            {relation === 'outgoing' ? (
              <span className="border border-fence px-2 py-1 font-mono text-[0.625rem] tracking-widest text-smoke uppercase">
                {t('profile.request_sent')}
              </span>
            ) : null}
            {relation === 'friends' ? (
              <span className="border border-moss/40 bg-moss-soft px-2 py-1 font-mono text-[0.625rem] tracking-widest text-moss uppercase">
                {t('profile.already_friends')}
              </span>
            ) : null}
            {relation === 'incoming' && incoming ? (
              <Button
                size="sm"
                onClick={() => accept.mutate()}
                disabled={accept.isPending}
              >
                {t('profile.accept_friend')}
              </Button>
            ) : null}
          </div>
          {send.isError ? (
            <p className="mt-2 text-sm text-blood">
              {send.error instanceof ApiError ? send.error.message : t('auth.unexpected_error')}
            </p>
          ) : null}
          <p className="mt-2 text-sm text-smoke">
            {data.profession
              ? t('profile.since_as', {
                  profession: data.profession,
                  when: formatDateTime(data.first_seen_at, intlLocale),
                })
              : t('profile.since', { when: formatDateTime(data.first_seen_at, intlLocale) })}
          </p>
        </header>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            icon={Swords}
            label={t('survivors.kills')}
            value={formatNumber(data.zombie_kills, intlLocale)}
            rank={data.kills_rank}
          />
          <Stat
            icon={Timer}
            label={t('survivors.hours')}
            value={formatNumber(Math.round(data.hours_survived), intlLocale)}
            rank={data.hours_rank}
          />
          <Stat
            icon={Skull}
            label={t('stats.deaths')}
            value={formatNumber(data.deaths, intlLocale)}
          />
          <Stat
            icon={Trophy}
            label={t('profile.pvp_kills')}
            value={formatNumber(data.pvp_kills, intlLocale)}
          />
        </div>

        {skills.length > 0 ? (
          <Panel bracketed className="mt-3">
            <PanelHeader label={t('profile.skills')} />
            <ul className="grid gap-x-6 gap-y-2 p-5 sm:grid-cols-2 lg:grid-cols-3">
              {skills.map(([name, level]) => (
                <li key={name} className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm text-smoke">{name}</span>
                  <span className="font-mono text-sm tabular-nums text-bone">{level}</span>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        <p className="mt-3 font-mono text-[0.6875rem] text-dust">
          {t('profile.updated', { when: formatDateTime(data.last_synced_at, intlLocale) })}
        </p>
      </Container>
    </Section>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  rank,
}: {
  icon: typeof Swords
  label: string
  value: string
  /** Position on the matching board, when this stat has one. */
  rank?: PlayerProfile['kills_rank']
}) {
  return (
    <Panel bracketed>
      <div className="p-5">
        <div className="flex items-center gap-2">
          <Icon aria-hidden="true" className="size-4 text-hazard" strokeWidth={1.5} />
          <span className="eyebrow">{label}</span>
        </div>
        <p className="display mt-2 text-2xl text-bone tabular-nums">{value}</p>
        {rank ? (
          <p
            className={cn(
              'mt-1 font-mono text-[0.6875rem] tabular-nums',
              rank <= 3 ? 'text-hazard' : 'text-dust',
            )}
          >
            #{rank}
          </p>
        ) : null}
      </div>
    </Panel>
  )
}
