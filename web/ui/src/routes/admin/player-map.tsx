import { useMutation, useQuery } from '@tanstack/react-query'
import { Crosshair, Search, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { FormError } from '@/components/ui/field'
import { HealthMeter } from '@/components/ui/bar'
import { PlayerHead } from '@/components/ui/player-head'
import { Panel } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { WorldmapView, type MapFocus } from '@/components/ui/worldmap'
import { api, ApiError, type AdminPlayer } from '@/lib/api'
import { worldToCell } from '@/lib/worldmap'
import { cn } from '@/lib/cn'
import { formatNumber, formatRelativeTime } from '@/lib/format'
import { fuzzyMatch } from '@/lib/fuzzy'
import { adminPlayersQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

type Filter = 'all' | 'online' | 'offline' | 'dead'

const FILTERS: { id: Filter; label: TranslationKey }[] = [
  { id: 'all', label: 'common.all' },
  { id: 'online', label: 'common.online' },
  { id: 'offline', label: 'common.offline' },
  { id: 'dead', label: 'survivors.dead' },
]

const COLOR = {
  selected: '#ffb000',
  online: '#8bb04a',
  offline: '#676e62',
  dead: '#c44536',
}

/**
 * Everyone the mod has a position for, on one map.
 *
 * Selecting a name recentres the camera. Teleporting is a destination you
 * pick on the map — sending someone to the coordinates they already occupy
 * is not a move.
 */
export function AdminPlayerMapPage() {
  const { t, intlLocale } = useTranslation()
  const searchId = useId()
  const searchRef = useRef<HTMLInputElement>(null)

  const { data, isPending, isError, refetch } = useQuery(adminPlayersQuery)

  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [destination, setDestination] = useState<{ x: number; y: number } | null>(null)
  const [pickMode, setPickMode] = useState(false)
  const [focus, setFocus] = useState<MapFocus | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const roster = data ?? []
  const located = useMemo(
    () => roster.filter((player) => player.x !== null && player.y !== null),
    [roster],
  )

  const counts = useMemo(() => {
    const online = roster.filter((player) => player.online).length
    const dead = roster.filter((player) => player.is_dead).length
    return {
      total: roster.length,
      online,
      offline: roster.length - online,
      dead,
    }
  }, [roster])

  const searching = query.trim().length > 0

  const visible = useMemo(() => {
    const source = roster.filter((player) => {
      if (filter === 'online') return player.online
      if (filter === 'offline') return !player.online
      if (filter === 'dead') return player.is_dead
      return true
    })

    const ranked = searching
      ? source
          .map((player) => {
            const hit = fuzzyMatch(query, player.username)
            return hit ? { player, score: hit.score } : null
          })
          .filter((row): row is { player: AdminPlayer; score: number } => row !== null)
          .sort((left, right) => right.score - left.score || left.player.username.localeCompare(right.player.username))
          .map((row) => row.player)
      : [...source].sort(
          (left, right) =>
            Number(right.online) - Number(left.online) || left.username.localeCompare(right.username),
        )

    return ranked
  }, [filter, query, roster, searching])

  const current = roster.find((player) => player.username === selected) ?? null

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

  function selectPlayer(username: string, recenter = true) {
    setSelected(username)
    const player = roster.find((entry) => entry.username === username)
    if (recenter && player && player.x !== null && player.y !== null) {
      setFocus({ x: player.x, y: player.y, token: Date.now() })
    }
  }

  const markers = located.map((player) => ({
    id: player.username,
    x: player.x as number,
    y: player.y as number,
    label: player.username,
    health: player.is_dead ? 0 : player.health,
    look: player.appearance,
    color:
      player.username === current?.username
        ? COLOR.selected
        : player.is_dead
          ? COLOR.dead
          : player.online
            ? COLOR.online
            : COLOR.offline,
  }))

  const teleport = useMutation({
    mutationFn: () => {
      if (!current || !destination) {
        throw new Error('missing target')
      }
      return api.adminTeleport(current.username, destination.x, destination.y, 0)
    },
    onSuccess: () => {
      setConfirming(false)
      setPickMode(false)
      setNotice(t('admin.moderation_done'))
    },
    onError: (cause) => {
      setConfirming(false)
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  function requestTeleport() {
    setError(null)
    setNotice(null)
    if (!current) {
      setError(t('admin.map_pick_player'))
      return
    }
    if (!current.online) {
      setError(t('admin.map_offline_teleport'))
      return
    }
    if (!destination) {
      setPickMode(true)
      return
    }
    setConfirming(true)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.players')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('admin.map_title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('admin.map_description')}</p>
        </div>
        <p className="font-mono text-[0.6875rem] text-dust">
          {t('admin.map_counts', {
            total: counts.total,
            online: counts.online,
            offline: counts.offline,
            dead: counts.dead,
          })}
        </p>
      </header>

      {notice ? (
        <p role="status" className="shrink-0 border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}

      {isPending ? (
        <Skeleton className="min-h-0 flex-1" />
      ) : isError ? (
        <div>
          <FormError>{t('common.error')}</FormError>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <Panel bracketed className="flex min-h-0 flex-col">
            <div className="flex shrink-0 flex-col gap-3 border-b border-fence px-3 py-3">
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-dust"
                />
                <input
                  ref={searchRef}
                  id={searchId}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && query) {
                      event.preventDefault()
                      setQuery('')
                    }
                  }}
                  placeholder={t('admin.map_search_placeholder')}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-10 w-full border border-fence-bright bg-void pr-10 pl-10 font-mono text-sm text-bone placeholder:text-dust focus:border-hazard"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('')
                      searchRef.current?.focus()
                    }}
                    className="absolute top-1/2 right-2 -translate-y-1/2 p-1 text-dust hover:text-bone"
                  >
                    <X aria-hidden="true" className="size-3.5" />
                    <span className="sr-only">{t('admin.logs_search_clear')}</span>
                  </button>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('admin.map_filter')}>
                {FILTERS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setFilter(item.id)}
                    aria-pressed={filter === item.id}
                    className={cn(
                      'border px-2 py-1 font-mono text-[0.6875rem] tracking-widest uppercase',
                      filter === item.id
                        ? 'border-hazard bg-hazard-soft text-hazard'
                        : 'border-fence text-dust hover:border-fence-bright hover:text-bone',
                    )}
                  >
                    {t(item.label)}
                  </button>
                ))}
              </div>
            </div>

            {roster.length === 0 ? (
              <p className="p-5 text-sm text-dust">{t('admin.map_empty')}</p>
            ) : visible.length === 0 ? (
              <p className="p-5 text-sm text-dust">{t('admin.map_no_matches')}</p>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
                {visible.map((player) => {
                  const active = player.username === current?.username
                  return (
                    <li key={player.username}>
                      <button
                        type="button"
                        onClick={() => selectPlayer(player.username)}
                        aria-current={active ? 'true' : undefined}
                        className={cn(
                          'flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left',
                          active ? 'bg-hazard-soft' : 'hover:bg-ash-raised',
                        )}
                      >
                        <span className="flex items-center gap-2 text-sm text-bone">
                          <PlayerHead look={player.appearance} size={28} />
                          <span
                            aria-hidden="true"
                            className="size-2 shrink-0"
                            style={{
                              background: player.is_dead
                                ? COLOR.dead
                                : player.online
                                  ? COLOR.online
                                  : COLOR.offline,
                            }}
                          />
                          {player.username}
                          {player.is_dead ? (
                            <span className="font-mono text-[0.625rem] tracking-widest text-blood uppercase">
                              {t('survivors.dead')}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex w-full flex-col gap-1.5">
                          <span className="font-mono text-[0.6875rem] text-dust">
                            {player.online ? t('map.in_game') : t('map.logged_out')}
                            {' · '}
                            {player.x !== null && player.y !== null
                              ? `${formatNumber(Math.round(player.x), intlLocale)}, ${formatNumber(Math.round(player.y), intlLocale)} · ${t('map.cell_at', worldToCell(player.x, player.y))}`
                              : t('admin.map_unknown_position')}
                          </span>
                          <HealthMeter
                            health={player.is_dead ? 0 : player.health}
                            label={t('character.health')}
                          />
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </Panel>

          <div className="flex min-h-0 flex-col gap-3">
            <WorldmapView
              markers={markers}
              selectedId={current?.username ?? null}
              destination={destination}
              focus={focus}
              pickMode={pickMode}
              onSelect={(id) => selectPlayer(id, true)}
              onPick={(point) => {
                setDestination({ x: point.x, y: point.y })
                setPickMode(false)
                setError(null)
              }}
              className="min-h-64 flex-1"
            />

            <div className="flex shrink-0 flex-col gap-3 border border-fence bg-ash px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0 text-sm text-smoke">
                {current ? (
                  <div>
                    <p>
                      <span className="text-bone">{current.username}</span>
                      {' · '}
                      {current.online ? t('common.online') : t('common.offline')}
                      {current.is_dead ? ` · ${t('survivors.dead')}` : ''}
                      {' · '}
                      {formatNumber(Math.round(current.x ?? 0), intlLocale)},{' '}
                      {formatNumber(Math.round(current.y ?? 0), intlLocale)}
                      {current.x !== null && current.y !== null
                        ? ` · ${t('map.cell_at', worldToCell(current.x, current.y))}`
                        : ''}
                      {current.z !== null && current.z !== 0
                        ? ` · ${t('map.floor_number', { count: current.z })}`
                        : ` · ${t('map.ground_floor')}`}
                      {current.last_seen_at
                        ? ` · ${formatRelativeTime(current.last_seen_at, intlLocale)}`
                        : ''}
                    </p>
                    <HealthMeter
                      health={current.is_dead ? 0 : current.health}
                      label={t('character.health')}
                      className="mt-2"
                    />
                  </div>
                ) : (
                  <p>{t('admin.map_pick_player')}</p>
                )}
                {destination ? (
                  <p className="mt-1 font-mono text-[0.6875rem] text-dust">
                    {t('admin.map_destination', {
                      x: Math.round(destination.x),
                      y: Math.round(destination.y),
                      cx: worldToCell(destination.x, destination.y).x,
                      cy: worldToCell(destination.x, destination.y).y,
                    })}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-dust">{t('admin.map_pick_hint')}</p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={pickMode ? 'primary' : 'outline'}
                  aria-pressed={pickMode}
                  onClick={() => {
                    setPickMode((currentMode) => !currentMode)
                    setError(null)
                  }}
                >
                  <Crosshair aria-hidden="true" className="size-3.5" />
                  {t('admin.map_pick')}
                </Button>
                <Button size="sm" disabled={!current} onClick={requestTeleport}>
                  {t('admin.action.teleport')}
                </Button>
              </div>
            </div>

            <Legend />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirming && current !== null && destination !== null}
        title={t('admin.action.teleport')}
        description={
          current && destination
            ? t('admin.action.teleport_confirm', {
                name: current.username,
                x: Math.round(destination.x),
                y: Math.round(destination.y),
              })
            : ''
        }
        busy={teleport.isPending}
        onConfirm={() => teleport.mutate()}
        onClose={() => {
          if (!teleport.isPending) {
            setConfirming(false)
          }
        }}
      />
    </section>
  )
}

function Legend() {
  const { t } = useTranslation()
  const items = [
    { color: COLOR.selected, label: t('admin.map_legend_selected') },
    { color: COLOR.online, label: t('admin.map_legend_online') },
    { color: COLOR.offline, label: t('admin.map_legend_offline') },
    { color: COLOR.dead, label: t('admin.map_legend_dead') },
    { color: '#e8e4d4', label: t('admin.map_legend_destination') },
  ]

  return (
    <ul className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[0.6875rem] text-dust">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  )
}
