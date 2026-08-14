import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { WorldmapView, type MapFocus } from '@/components/ui/worldmap'
import { api, ApiError, type PvpViolation, type SafeZone, type SafeZoneInput } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDateTime } from '@/lib/format'
import { adminSafeZonesQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

const ZONE_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899']

type StatusFilter = 'all' | 'pending' | 'dismissed' | 'actioned'

const FILTERS: { id: StatusFilter; label: TranslationKey }[] = [
  { id: 'pending', label: 'safe_zones.filter_pending' },
  { id: 'actioned', label: 'safe_zones.filter_actioned' },
  { id: 'dismissed', label: 'safe_zones.filter_dismissed' },
  { id: 'all', label: 'safe_zones.filter_all' },
]

const STATUS_LABEL: Record<Exclude<StatusFilter, 'all'>, TranslationKey> = {
  pending: 'safe_zones.status_pending',
  dismissed: 'safe_zones.status_dismissed',
  actioned: 'safe_zones.status_actioned',
}

interface Draft {
  id: string
  name: string
  x1: string
  y1: string
  x2: string
  y2: string
}

const EMPTY: Draft = { id: '', name: '', x1: '', y1: '', x2: '', y2: '' }

function toInput(draft: Draft): SafeZoneInput {
  return {
    id: draft.id.trim() || undefined,
    name: draft.name.trim(),
    x1: Number(draft.x1),
    y1: Number(draft.y1),
    x2: Number(draft.x2),
    y2: Number(draft.y2),
  }
}

/**
 * Rectangles the sanctuary hook treats as no-PvP. Drawn on the map, written
 * to the file the dedicated server already reloads.
 */
export function AdminSafeZonesPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const data = useQuery(adminSafeZonesQuery)

  const [drawing, setDrawing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [selected, setSelected] = useState<string | null>(null)
  const [remove, setRemove] = useState<SafeZone | null>(null)
  const [resolve, setResolve] = useState<PvpViolation | null>(null)
  const [resolveNote, setResolveNote] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending')
  const [focus, setFocus] = useState<MapFocus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const config = data.data?.config
  const zones = config?.zones ?? []
  const violations = data.data?.violations ?? []
  const current = zones.find((zone) => zone.id === selected) ?? null

  useEffect(() => {
    if (!drawing) {
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawing(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawing])

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'safe-zones'] })
    await queryClient.invalidateQueries({ queryKey: ['safe-zones'] })
  }

  function fail(cause: unknown) {
    setNotice(null)
    setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
  }

  const toggled = useMutation({
    mutationFn: (enabled: boolean) => api.adminSetSafeZonesEnabled(enabled),
    onSuccess: async (next) => {
      setNotice(next.enabled ? t('safe_zones.enabled') : t('safe_zones.disabled'))
      setError(null)
      await refresh()
    },
    onError: fail,
  })

  const created = useMutation({
    mutationFn: () => api.adminCreateSafeZone(toInput(draft)),
    onSuccess: async (next) => {
      const last = next.zones[next.zones.length - 1]
      setAdding(false)
      setDrawing(false)
      setDraft(EMPTY)
      if (last) setSelected(last.id)
      setNotice(t('safe_zones.created'))
      setError(null)
      await refresh()
    },
    onError: fail,
  })

  const destroyed = useMutation({
    mutationFn: (id: string) => api.adminDeleteSafeZone(id),
    onSuccess: async () => {
      setRemove(null)
      setSelected(null)
      setNotice(t('safe_zones.deleted'))
      setError(null)
      await refresh()
    },
    onError: fail,
  })

  const resolved = useMutation({
    mutationFn: () => {
      if (!resolve) throw new Error('missing violation')
      return api.adminResolveViolation(resolve.id, 'dismissed', resolveNote || undefined)
    },
    onSuccess: async () => {
      setResolve(null)
      setResolveNote('')
      setNotice(t('safe_zones.resolved'))
      setError(null)
      await refresh()
    },
    onError: fail,
  })

  const kicked = useMutation({
    mutationFn: async (violation: PvpViolation) => {
      await api.adminKick(violation.attacker, t('safe_zones.kick_reason', { zone: violation.zone_name }))
      await api.adminResolveViolation(violation.id, 'actioned', t('safe_zones.kicked_note'))
    },
    onSuccess: async () => {
      setNotice(t('safe_zones.kicked'))
      setError(null)
      await refresh()
    },
    onError: fail,
  })

  const banned = useMutation({
    mutationFn: async (violation: PvpViolation) => {
      await api.adminBan(violation.attacker, t('safe_zones.kick_reason', { zone: violation.zone_name }))
      await api.adminResolveViolation(violation.id, 'actioned', t('safe_zones.banned_note'))
    },
    onSuccess: async () => {
      setNotice(t('safe_zones.banned'))
      setError(null)
      await refresh()
    },
    onError: fail,
  })

  const filtered = useMemo(
    () =>
      violations.filter((row) => statusFilter === 'all' || row.status === statusFilter),
    [violations, statusFilter],
  )

  const pending = violations.filter((row) => row.status === 'pending').length

  function openZone(zone: SafeZone) {
    setSelected(zone.id)
    setFocus({
      x: (zone.x1 + zone.x2) / 2,
      y: (zone.y1 + zone.y2) / 2,
      token: Date.now(),
    })
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.world')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('safe_zones.title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('safe_zones.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={config?.enabled ? 'primary' : 'outline'}
            disabled={!config || toggled.isPending}
            onClick={() => toggled.mutate(!(config?.enabled ?? false))}
          >
            <ShieldAlert aria-hidden="true" className="size-3.5" />
            {config?.enabled ? t('common.enabled') : t('common.disabled')}
          </Button>
          <Button
            size="sm"
            variant={drawing ? 'primary' : 'outline'}
            onClick={() => {
              setDrawing((current) => !current)
              setAdding(false)
            }}
          >
            <Pencil aria-hidden="true" className="size-3.5" />
            {drawing ? t('safe_zones.cancel_drawing') : t('safe_zones.draw')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setAdding(true)
              setDrawing(false)
              setDraft(EMPTY)
            }}
          >
            <Plus aria-hidden="true" className="size-3.5" />
            {t('safe_zones.add')}
          </Button>
        </div>
      </header>

      {notice ? (
        <p role="status" className="border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}
      {drawing ? (
        <p className="border border-hazard/40 bg-hazard-soft px-3 py-2 text-sm text-hazard">
          {t('safe_zones.drawing_hint')}
        </p>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
        <Panel bracketed className="flex min-h-[22rem] flex-col overflow-hidden">
          <PanelHeader label={t('safe_zones.map')} />
          <WorldmapView
            className="min-h-0 flex-1"
            selectedId={selected}
            focus={focus}
            rectMode={drawing}
            onRect={(rect) => {
              setDraft({
                id: '',
                name: '',
                x1: String(rect.x1),
                y1: String(rect.y1),
                x2: String(rect.x2),
                y2: String(rect.y2),
              })
              setDrawing(false)
              setAdding(true)
            }}
            onSelect={(id) => {
              const zone = zones.find((item) => item.id === id || item.name === id)
              if (zone) openZone(zone)
            }}
          />
        </Panel>

        <Panel bracketed className="flex min-h-0 flex-col overflow-hidden">
          <PanelHeader label={t('safe_zones.zones', { count: zones.length })} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {data.isPending ? (
              <div className="flex flex-col gap-2 p-3">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : zones.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-dust">{t('safe_zones.empty')}</p>
            ) : (
              <ul>
                {zones.map((zone, index) => (
                  <li key={zone.id}>
                    <button
                      type="button"
                      onClick={() => openZone(zone)}
                      className={cn(
                        'flex w-full flex-col items-start gap-1 border-b border-fence px-4 py-3 text-left last:border-0',
                        selected === zone.id ? 'bg-ash-raised' : 'hover:bg-ash-raised/60',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="size-2.5 shrink-0"
                          style={{ background: ZONE_COLORS[index % ZONE_COLORS.length] }}
                        />
                        <span className="display text-base text-bone">{zone.name}</span>
                      </span>
                      <span className="font-mono text-[0.625rem] tracking-widest text-dust uppercase">
                        {zone.id} · {zone.x1},{zone.y1} → {zone.x2},{zone.y2}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {current ? (
            <div className="flex items-center justify-between gap-2 border-t border-fence px-3 py-2">
              <span className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
                {current.name}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setRemove(current)}>
                <Trash2 aria-hidden="true" className="size-3.5" />
                {t('common.delete')}
              </Button>
            </div>
          ) : null}
        </Panel>
      </div>

      <Panel bracketed className="shrink-0">
        <PanelHeader
          label={t('safe_zones.violations')}
          action={
            <span className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
              {t('safe_zones.pending_count', { count: pending })}
            </span>
          }
        />
        <div className="flex flex-wrap gap-1 border-b border-fence px-3 py-2">
          {FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => setStatusFilter(filter.id)}
              className={cn(
                'px-2 py-1 font-mono text-[0.6875rem] tracking-widest uppercase',
                statusFilter === filter.id ? 'bg-fence text-bone' : 'text-dust hover:text-bone',
              )}
            >
              {t(filter.label)}
            </button>
          ))}
        </div>
        <div className="max-h-72 overflow-auto">
          {filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-dust">{t('safe_zones.no_violations')}</p>
          ) : (
            <table className="w-full min-w-[40rem] border-collapse text-left">
              <thead>
                <tr className="border-b border-fence">
                  <Th>{t('safe_zones.attacker')}</Th>
                  <Th>{t('safe_zones.victim')}</Th>
                  <Th>{t('safe_zones.zone')}</Th>
                  <Th>{t('safe_zones.strike')}</Th>
                  <Th>{t('safe_zones.when')}</Th>
                  <Th>{t('safe_zones.status')}</Th>
                  <Th>{t('common.actions')}</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.id} className="border-b border-fence last:border-0">
                    <td className="px-3 py-2 text-sm text-bone">{row.attacker}</td>
                    <td className="px-3 py-2 text-sm text-smoke">{row.victim}</td>
                    <td className="px-3 py-2 text-sm text-smoke">{row.zone_name}</td>
                    <td className="px-3 py-2 font-mono text-sm text-bone tabular-nums">
                      {row.strike_number}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-dust">
                      {formatDateTime(row.occurred_at, intlLocale)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          'font-mono text-[0.625rem] tracking-widest uppercase',
                          row.status === 'pending'
                            ? 'text-hazard'
                            : row.status === 'actioned'
                              ? 'text-moss'
                              : 'text-dust',
                        )}
                      >
                        {t(STATUS_LABEL[row.status])}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {row.status === 'pending' ? (
                        <div className="flex flex-wrap gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setResolve(row)
                              setResolveNote('')
                            }}
                          >
                            {t('safe_zones.dismiss')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={kicked.isPending}
                            onClick={() => kicked.mutate(row)}
                          >
                            {t('safe_zones.kick')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={banned.isPending}
                            onClick={() => banned.mutate(row)}
                          >
                            {t('safe_zones.ban')}
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-dust">
                          {row.resolved_by ?? '—'}
                          {row.resolution_note ? ` · ${row.resolution_note}` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Panel>

      <ConfirmDialog
        open={adding}
        title={t('safe_zones.add_title')}
        size="lg"
        description={
          <div className="grid gap-3 sm:grid-cols-2">
            <p className="sm:col-span-2 text-sm text-smoke">{t('safe_zones.add_description')}</p>
            <Field
              label={t('safe_zones.name')}
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
            <Field
              label={t('safe_zones.zone_id')}
              value={draft.id}
              onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))}
              hint={t('safe_zones.zone_id_hint')}
            />
            <Field
              label={t('safe_zones.x1')}
              value={draft.x1}
              onChange={(event) => setDraft((current) => ({ ...current, x1: event.target.value }))}
              inputMode="numeric"
            />
            <Field
              label={t('safe_zones.y1')}
              value={draft.y1}
              onChange={(event) => setDraft((current) => ({ ...current, y1: event.target.value }))}
              inputMode="numeric"
            />
            <Field
              label={t('safe_zones.x2')}
              value={draft.x2}
              onChange={(event) => setDraft((current) => ({ ...current, x2: event.target.value }))}
              inputMode="numeric"
            />
            <Field
              label={t('safe_zones.y2')}
              value={draft.y2}
              onChange={(event) => setDraft((current) => ({ ...current, y2: event.target.value }))}
              inputMode="numeric"
            />
          </div>
        }
        confirmLabel={t('safe_zones.add')}
        busy={created.isPending}
        confirmDisabled={draft.name.trim() === '' || draft.x1 === '' || draft.y1 === ''}
        onConfirm={() => created.mutate()}
        onClose={() => setAdding(false)}
      />

      <ConfirmDialog
        open={remove !== null}
        title={t('safe_zones.delete_title')}
        description={t('safe_zones.delete_confirm', { name: remove?.name ?? '' })}
        tone="danger"
        busy={destroyed.isPending}
        onConfirm={() => {
          if (remove) destroyed.mutate(remove.id)
        }}
        onClose={() => setRemove(null)}
      />

      <ConfirmDialog
        open={resolve !== null}
        title={t('safe_zones.dismiss_title')}
        description={
          <div className="flex flex-col gap-3">
            <p>
              {t('safe_zones.dismiss_confirm', {
                attacker: resolve?.attacker ?? '',
                victim: resolve?.victim ?? '',
              })}
            </p>
            <Field
              label={t('safe_zones.note')}
              value={resolveNote}
              onChange={(event) => setResolveNote(event.target.value)}
            />
          </div>
        }
        confirmLabel={t('safe_zones.dismiss')}
        busy={resolved.isPending}
        onConfirm={() => resolved.mutate()}
        onClose={() => setResolve(null)}
      />
    </section>
  )
}

function Th({ children }: { children: string }) {
  return (
    <th
      scope="col"
      className="px-3 py-2 font-mono text-[0.6875rem] font-normal tracking-widest text-dust uppercase"
    >
      {children}
    </th>
  )
}
