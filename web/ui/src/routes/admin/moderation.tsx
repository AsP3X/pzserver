import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, Clock, Crosshair, Megaphone, Search, Swords, UserX, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError, TextAreaField } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { WorldmapView, type MapFocus } from '@/components/ui/worldmap'
import {
  api,
  ApiError,
  type AdminEvent,
  type AdminEventType,
  type AdminPlayer,
  type Sanction,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDateTime, formatNumber, formatRelativeTime } from '@/lib/format'
import { fuzzyMatch } from '@/lib/fuzzy'
import { adminEventsQuery, adminPlayersQuery, adminSanctionsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

const TYPES: { id: AdminEventType; label: TranslationKey; color: string }[] = [
  { id: 'death', label: 'admin.moderation_event_death', color: '#c44536' },
  { id: 'pvp_kill', label: 'admin.moderation_event_pvp', color: '#ffb000' },
]

const CAUSE_LABEL: Record<string, TranslationKey> = {
  player: 'obituary.cause.player',
  fire: 'obituary.cause.fire',
  infection: 'obituary.cause.infection',
  unknown: 'obituary.cause.unknown',
}

const PRESETS: { seconds: number; label: TranslationKey }[] = [
  { seconds: 15 * 60, label: 'admin.suspend_15m' },
  { seconds: 60 * 60, label: 'admin.suspend_1h' },
  { seconds: 6 * 60 * 60, label: 'admin.suspend_6h' },
  { seconds: 24 * 60 * 60, label: 'admin.suspend_1d' },
  { seconds: 3 * 24 * 60 * 60, label: 'admin.suspend_3d' },
  { seconds: 7 * 24 * 60 * 60, label: 'admin.suspend_7d' },
  { seconds: 30 * 24 * 60 * 60, label: 'admin.suspend_30d' },
]

const DEFAULT_DURATION = 24 * 60 * 60

type Pending =
  | { kind: 'kick'; name: string }
  | { kind: 'ban'; name: string }
  | { kind: 'suspend'; name: string; seconds: number }
  | { kind: 'lift'; name: string }
  | { kind: 'broadcast' }
  | null

function dayBound(value: string, end: boolean): string | undefined {
  if (!value) {
    return undefined
  }
  const date = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function shortItem(type: string | null): string | null {
  if (!type) {
    return null
  }
  const parts = type.split('.')
  return parts[parts.length - 1] || type
}

function hasLocation(event: AdminEvent): boolean {
  return event.x !== null && event.y !== null
}

function isSuspend(row: Sanction): boolean {
  return row.expires_at !== null
}

/**
 * Deaths, PvP, and the actions you take because of them.
 *
 * The dedicated server has no timed ban. A suspension is a real ban plus a
 * timer we lift ourselves — so the list on this page is the source of truth
 * for who we locked out, and for how long.
 */
export function AdminModerationPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const searchRef = useRef<HTMLInputElement>(null)

  const [types, setTypes] = useState<AdminEventType[]>(['death', 'pvp_kill'])
  const [query, setQuery] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [focus, setFocus] = useState<MapFocus | null>(null)

  const [username, setUsername] = useState('')
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState('')
  const [duration, setDuration] = useState(DEFAULT_DURATION)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)

  const eventsQuery = useQuery(
    adminEventsQuery({
      types,
      from: dayBound(from, false),
      to: dayBound(to, true),
    }),
  )
  const playersQuery = useQuery(adminPlayersQuery)
  const sanctionsQuery = useQuery(adminSanctionsQuery)

  const events = eventsQuery.data?.events ?? []
  const totals = eventsQuery.data?.totals
  const searching = query.trim().length > 0
  const name = username.trim()

  const visible = useMemo(() => {
    if (!searching) {
      return events
    }

    return events
      .map((event) => {
        const haystack = [event.player, event.target, event.subject, event.cause, event.weapon]
          .filter((value): value is string => Boolean(value))
          .join(' ')
        const hit = fuzzyMatch(query, haystack)
        return hit ? { event, score: hit.score } : null
      })
      .filter((row): row is { event: AdminEvent; score: number } => row !== null)
      .sort((left, right) => right.score - left.score || right.event.id - left.event.id)
      .map((row) => row.event)
  }, [events, query, searching])

  const current = visible.find((event) => event.id === selected) ?? null

  const markers = visible.filter(hasLocation).map((event) => ({
    id: String(event.id),
    x: event.x as number,
    y: event.y as number,
    label: event.player,
    color: event.event_type === 'pvp_kill' ? '#ffb000' : '#c44536',
  }))

  const roster = playersQuery.data ?? []
  const online = roster.filter((player) => player.online)
  const named = roster.find((player) => player.username.toLowerCase() === name.toLowerCase())
  const active = sanctionsQuery.data?.active ?? []
  const recent = sanctionsQuery.data?.recent ?? []
  const openOnName = active.find((row) => row.username.toLowerCase() === name.toLowerCase()) ?? null
  const durationLabel = PRESETS.find((item) => item.seconds === duration)?.label

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '/' && event.target instanceof HTMLElement) {
        const tag = event.target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          return
        }
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  function toggleType(id: AdminEventType) {
    setTypes((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      return next.length === 0 ? TYPES.map((item) => item.id) : next
    })
  }

  function fillName(player: string) {
    setUsername(player)
    setError(null)
  }

  function selectEvent(event: AdminEvent, recenter = true) {
    setSelected(event.id)
    fillName(event.subject)
    if (recenter && hasLocation(event)) {
      setFocus({ x: event.x as number, y: event.y as number, token: Date.now() })
    }
  }

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'sanctions'] }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'players'] }),
    ])
  }

  const act = useMutation({
    mutationFn: async () => {
      if (!pending) {
        throw new Error('missing action')
      }
      if (pending.kind === 'kick') {
        return api.adminKick(pending.name, reason || undefined)
      }
      if (pending.kind === 'ban') {
        return api.adminBan(pending.name, reason || undefined)
      }
      if (pending.kind === 'suspend') {
        return api.adminSuspend(pending.name, pending.seconds, reason || undefined)
      }
      if (pending.kind === 'lift') {
        return api.adminUnban(pending.name)
      }
      return api.adminBroadcast(message)
    },
    onSuccess: async () => {
      if (pending?.kind === 'broadcast') {
        setMessage('')
        setNotice(t('admin.moderation_sent'))
      } else if (pending?.kind === 'suspend') {
        setNotice(t('admin.moderation_suspended'))
      } else if (pending?.kind === 'lift') {
        setNotice(t('admin.moderation_lifted'))
      } else {
        setNotice(t('admin.moderation_done'))
      }
      setPending(null)
      setError(null)
      await refresh()
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
      setPending(null)
    },
  })

  function needName(): boolean {
    setNotice(null)
    setError(null)
    if (!name) {
      setError(t('admin.moderation_need_name'))
      return false
    }
    return true
  }

  const until =
    pending?.kind === 'suspend'
      ? formatDateTime(new Date(Date.now() + pending.seconds * 1000).toISOString(), intlLocale)
      : ''

  const confirmTitle =
    pending?.kind === 'kick'
      ? t('admin.action.kick_named', { name: pending.name })
      : pending?.kind === 'ban'
        ? t('admin.action.ban_named', { name: pending.name })
        : pending?.kind === 'suspend'
          ? t('admin.action.suspend_named', { name: pending.name })
          : pending?.kind === 'lift'
            ? t('admin.action.lift_named', { name: pending.name })
            : t('admin.action.broadcast')

  const confirmBody =
    pending?.kind === 'kick'
      ? t('admin.action.kick_confirm')
      : pending?.kind === 'ban'
        ? t('admin.action.ban_confirm')
        : pending?.kind === 'suspend'
          ? t('admin.action.suspend_confirm', {
              duration: durationLabel ? t(durationLabel) : '',
              until,
            })
          : pending?.kind === 'lift'
            ? t('admin.action.lift_confirm')
            : t('admin.moderation_broadcast_confirm')

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.players')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('admin.moderation_title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('admin.moderation_description')}</p>
        </div>
        <p className="font-mono text-[0.6875rem] text-dust">
          {t('admin.moderation_counts', {
            deaths: totals?.deaths ?? 0,
            pvp: totals?.pvp_kills ?? 0,
            recent: totals?.last_24h ?? 0,
            held: active.length,
          })}
        </p>
      </header>

      {notice ? (
        <p role="status" className="shrink-0 border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}

      <div className="flex shrink-0 flex-col gap-3 border border-fence bg-ash px-3 py-3 lg:flex-row lg:items-end">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('admin.moderation_event_types')}>
          {TYPES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => toggleType(item.id)}
              aria-pressed={types.includes(item.id)}
              className={cn(
                'inline-flex items-center gap-2 border px-2 py-1 font-mono text-[0.6875rem] tracking-widest uppercase',
                types.includes(item.id)
                  ? 'border-hazard bg-hazard-soft text-hazard'
                  : 'border-fence text-dust hover:border-fence-bright hover:text-bone',
              )}
            >
              <span aria-hidden="true" className="size-2 shrink-0" style={{ background: item.color }} />
              {t(item.label)}
            </button>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-dust"
          />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('admin.moderation_search_placeholder')}
            aria-label={t('common.search')}
            className="h-10 w-full border border-fence-bright bg-void pr-9 pl-9 font-mono text-sm text-bone placeholder:text-dust focus:border-hazard"
            autoComplete="off"
            spellCheck={false}
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute top-1/2 right-2 -translate-y-1/2 p-1 text-dust hover:text-bone"
            >
              <X aria-hidden="true" className="size-3.5" />
              <span className="sr-only">{t('admin.logs_search_clear')}</span>
            </button>
          ) : null}
        </div>
        <Field
          label={t('admin.moderation_from')}
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
          className="h-10"
        />
        <Field
          label={t('admin.moderation_to')}
          type="date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          className="h-10"
        />
        {from || to ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFrom('')
              setTo('')
            }}
          >
            {t('admin.moderation_clear_dates')}
          </Button>
        ) : null}
      </div>

      {eventsQuery.isPending ? (
        <Skeleton className="min-h-0 flex-1" />
      ) : eventsQuery.isError ? (
        <div>
          <FormError>{t('common.error')}</FormError>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void eventsQuery.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
            <Panel bracketed className="flex min-h-0 flex-col">
              <PanelHeader
                label={t('admin.moderation_events')}
                action={
                  <span className="font-mono text-[0.6875rem] text-dust">
                    {t('admin.moderation_showing', { count: visible.length })}
                  </span>
                }
              />
              {visible.length === 0 ? (
                <p className="p-5 text-sm text-dust">{t('admin.moderation_no_events')}</p>
              ) : (
                <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
                  {visible.map((event) => (
                    <EventRow
                      key={event.id}
                      event={event}
                      active={event.id === current?.id}
                      locale={intlLocale}
                      onSelect={() => selectEvent(event)}
                      onKick={() => {
                        fillName(event.subject)
                        setPending({ kind: 'kick', name: event.subject })
                      }}
                      onSuspend={() => {
                        fillName(event.subject)
                        setPending({ kind: 'suspend', name: event.subject, seconds: duration })
                      }}
                    />
                  ))}
                </ul>
              )}
            </Panel>

            <Panel bracketed className="flex min-h-64 flex-col lg:min-h-0">
              <PanelHeader label={t('admin.moderation_event_map')} />
              <WorldmapView
                markers={markers}
                selectedId={current ? String(current.id) : null}
                focus={focus}
                onSelect={(id) => {
                  const event = visible.find((item) => String(item.id) === id)
                  if (event) {
                    selectEvent(event, false)
                  }
                }}
                className="min-h-64 flex-1 border-0"
              />
            </Panel>
          </div>

          <Panel bracketed className="flex min-h-0 flex-col overflow-y-auto">
            <PanelHeader
              label={t('admin.moderation_tools')}
              action={
                <span className="font-mono text-[0.6875rem] text-dust">
                  {t('admin.moderation_held', { count: active.length })}
                </span>
              }
            />
            <div className="flex flex-col gap-5 p-4">
              {active.length > 0 ? (
                <SanctionGroup
                  title={t('admin.moderation_active')}
                  rows={active}
                  locale={intlLocale}
                  selected={name}
                  onSelect={fillName}
                  onLift={(row) => {
                    fillName(row.username)
                    setPending({ kind: 'lift', name: row.username })
                  }}
                />
              ) : (
                <p className="text-sm text-dust">{t('admin.moderation_none_held')}</p>
              )}

              <form
                className="flex flex-col gap-3 border-t border-fence pt-5"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (needName()) {
                    setPending({ kind: 'suspend', name, seconds: duration })
                  }
                }}
              >
                <Field
                  label={t('auth.username')}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  hint={t('admin.moderation_name_hint')}
                />
                {name ? (
                  <p className="font-mono text-[0.6875rem] text-dust">
                    {[
                      named?.online ? t('common.online') : t('common.offline'),
                      openOnName
                        ? openOnName.expires_at
                          ? t('admin.moderation_until', {
                              when: formatDateTime(openOnName.expires_at, intlLocale),
                            })
                          : t('admin.moderation_banned_now')
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                ) : null}
                <Field
                  label={t('common.reason')}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  hint={t('admin.moderation_reason_hint')}
                />
                <fieldset className="flex flex-col gap-2">
                  <legend className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
                    {t('admin.moderation_duration')}
                  </legend>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('admin.moderation_duration')}>
                    {PRESETS.map((item) => (
                      <button
                        key={item.seconds}
                        type="button"
                        onClick={() => setDuration(item.seconds)}
                        aria-pressed={duration === item.seconds}
                        className={cn(
                          'border px-2 py-1 font-mono text-[0.6875rem] tracking-widest uppercase',
                          duration === item.seconds
                            ? 'border-hazard bg-hazard-soft text-hazard'
                            : 'border-fence text-dust hover:border-fence-bright hover:text-bone',
                        )}
                      >
                        {t(item.label)}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm" disabled={!name || act.isPending}>
                    <Clock aria-hidden="true" className="size-3.5" />
                    {t('admin.action.suspend')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!name || act.isPending}
                    onClick={() => needName() && setPending({ kind: 'kick', name })}
                  >
                    <UserX aria-hidden="true" className="size-3.5" />
                    {t('admin.action.kick')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="border-blood text-blood hover:border-blood hover:text-blood"
                    disabled={!name || act.isPending}
                    onClick={() => needName() && setPending({ kind: 'ban', name })}
                  >
                    <Ban aria-hidden="true" className="size-3.5" />
                    {t('admin.action.ban')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={!name || act.isPending}
                    onClick={() => needName() && setPending({ kind: 'lift', name })}
                  >
                    {t('admin.action.lift')}
                  </Button>
                </div>
              </form>

              {online.length > 0 ? (
                <div>
                  <p className="mb-2 font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
                    {t('admin.moderation_online_fill')}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {online.map((player: AdminPlayer) => (
                      <button
                        key={player.username}
                        type="button"
                        onClick={() => fillName(player.username)}
                        className={cn(
                          'border px-2 py-1 font-mono text-[0.6875rem] tracking-widest uppercase',
                          name.toLowerCase() === player.username.toLowerCase()
                            ? 'border-hazard bg-hazard-soft text-hazard'
                            : 'border-fence text-smoke hover:border-fence-bright hover:text-bone',
                        )}
                      >
                        {player.username}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {recent.length > 0 ? (
                <SanctionGroup
                  title={t('admin.moderation_recent')}
                  rows={recent}
                  locale={intlLocale}
                  selected={name}
                  onSelect={fillName}
                />
              ) : null}

              <form
                className="flex flex-col gap-3 border-t border-fence pt-5"
                onSubmit={(event) => {
                  event.preventDefault()
                  setNotice(null)
                  setError(null)
                  if (!message.trim()) {
                    setError(t('admin.moderation_need_message'))
                    return
                  }
                  setPending({ kind: 'broadcast' })
                }}
              >
                <TextAreaField
                  label={t('admin.moderation_message')}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  maxLength={240}
                  hint={t('admin.moderation_message_hint')}
                />
                <Button type="submit" size="sm" variant="outline" disabled={!message.trim() || act.isPending}>
                  <Megaphone aria-hidden="true" className="size-3.5" />
                  {t('admin.action.broadcast')}
                </Button>
              </form>
            </div>
          </Panel>
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={confirmTitle}
        description={confirmBody}
        tone={pending?.kind === 'ban' || pending?.kind === 'kick' || pending?.kind === 'suspend' ? 'danger' : 'primary'}
        busy={act.isPending}
        onConfirm={() => act.mutate()}
        onClose={() => {
          if (!act.isPending) {
            setPending(null)
          }
        }}
      />
    </section>
  )
}

function EventRow({
  event,
  active,
  locale,
  onSelect,
  onKick,
  onSuspend,
}: {
  event: AdminEvent
  active: boolean
  locale: string
  onSelect: () => void
  onKick: () => void
  onSuspend: () => void
}) {
  const { t } = useTranslation()
  const pvp = event.event_type === 'pvp_kill'
  const causeKey = event.cause ? CAUSE_LABEL[event.cause] : undefined
  const weapon = shortItem(event.weapon)

  return (
    <li>
      <div className={cn('flex flex-col gap-2 px-4 py-3', active ? 'bg-hazard-soft' : 'hover:bg-ash-raised')}>
        <button type="button" onClick={onSelect} className="flex w-full flex-col items-start gap-1 text-left">
          <span className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1 font-mono text-[0.625rem] tracking-widest uppercase',
                pvp ? 'text-hazard' : 'text-blood',
              )}
            >
              {pvp ? (
                <Swords aria-hidden="true" className="size-3" />
              ) : (
                <Crosshair aria-hidden="true" className="size-3" />
              )}
              {t(pvp ? 'admin.moderation_event_pvp' : 'admin.moderation_event_death')}
            </span>
            <span className="font-mono text-[0.625rem] text-dust">
              {formatRelativeTime(event.occurred_at, locale)}
            </span>
          </span>
          <span className="text-sm text-bone">
            {pvp
              ? t('admin.moderation_killed', {
                  player: event.player,
                  target: event.target ?? t('common.unknown'),
                })
              : t('admin.moderation_died', { player: event.player })}
          </span>
          <span className="font-mono text-[0.6875rem] text-dust">
            {[
              !pvp && event.target ? t('admin.moderation_by', { name: event.target }) : null,
              causeKey ? t(causeKey) : null,
              weapon,
              hasLocation(event)
                ? `${formatNumber(Math.round(event.x as number), locale)}, ${formatNumber(Math.round(event.y as number), locale)}`
                : t('admin.moderation_no_location'),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <span className="font-mono text-[0.625rem] text-dust">{formatDateTime(event.occurred_at, locale)}</span>
        </button>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onSuspend}>
            <Clock aria-hidden="true" className="size-3.5" />
            {t('admin.action.suspend')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onKick}>
            <UserX aria-hidden="true" className="size-3.5" />
            {t('admin.action.kick')}
          </Button>
        </div>
      </div>
    </li>
  )
}

function SanctionGroup({
  title,
  rows,
  locale,
  selected,
  onSelect,
  onLift,
}: {
  title: string
  rows: Sanction[]
  locale: string
  selected: string
  onSelect: (name: string) => void
  onLift?: (row: Sanction) => void
}) {
  const { t } = useTranslation()

  return (
    <div>
      <p className="mb-2 font-mono text-[0.6875rem] tracking-widest text-dust uppercase">{title}</p>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const active = selected.toLowerCase() === row.username.toLowerCase()
          const timed = isSuspend(row)
          return (
            <li key={row.id} className={cn('border border-fence px-3 py-2', active && 'border-hazard bg-hazard-soft')}>
              <button type="button" onClick={() => onSelect(row.username)} className="flex w-full flex-col items-start text-left">
                <span className="text-sm text-bone">{row.username}</span>
                <span className="font-mono text-[0.6875rem] text-dust">
                  {timed
                    ? row.lifted_at
                      ? t('admin.moderation_was_until', { when: formatDateTime(row.expires_at ?? row.starts_at, locale) })
                      : t('admin.moderation_until', { when: formatDateTime(row.expires_at ?? row.starts_at, locale) })
                    : t('admin.moderation_banned_now')}
                  {row.expires_at && !row.lifted_at ? ` · ${formatRelativeTime(row.expires_at, locale)}` : ''}
                </span>
                {row.reason ? <span className="mt-1 text-xs text-smoke">{row.reason}</span> : null}
              </button>
              {onLift && !row.lifted_at ? (
                <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={() => onLift(row)}>
                  {t('admin.action.lift')}
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
