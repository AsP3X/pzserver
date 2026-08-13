import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  ChevronDown,
  Eye,
  EyeOff,
  Home,
  MessageSquare,
  MoreHorizontal,
  Package,
  RotateCcw,
  Save,
  Search,
  Shield,
  Swords,
  Users,
  Wifi,
  X,
  Globe,
  Map as MapIcon,
  Star,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { FormError } from '@/components/ui/field'
import { Panel } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { TabStrip } from '@/components/ui/tabs'
import { api, ApiError, type ConfigField } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  CONFIG_GROUPS,
  FEATURED_KEYS,
  groupLabelKey,
  hasSettingHelp,
  hasSettingLabel,
  humanizeKey,
  isSensitive,
  parseBoolean,
  settingGroup,
  settingHelpKey,
  settingLabelKey,
  settingMeta,
  splitList,
  type ConfigGroupId,
  type SettingMeta,
} from '@/lib/config-metadata'
import { fuzzyMatch } from '@/lib/fuzzy'
import { adminConfigQuery, serverStatusQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

const LINE_BREAK_TAG = ' <LINE> '
const FEATURED_KEY_SET = new Set<string>(FEATURED_KEYS)

const GROUP_ICONS: Record<ConfigGroupId, LucideIcon> = {
  featured: Star,
  general: Globe,
  players: Users,
  pvp: Swords,
  world: MapIcon,
  safehouses: Home,
  network: Wifi,
  chat: MessageSquare,
  saves: Save,
  security: Shield,
  mods: Package,
  other: MoreHorizontal,
}

type Row = {
  field: ConfigField
  meta?: SettingMeta
  group: ConfigGroupId
}

/**
 * server.ini as grouped, typed settings rather than a wall of raw keys.
 *
 * Search walks labels, keys and descriptions. The sidebar is the map; the
 * featured group is the short list an operator actually means to change.
 */
export function AdminConfigPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const searchId = useId()
  const searchRef = useRef<HTMLInputElement>(null)

  const { data, isPending, isError, refetch } = useQuery(adminConfigQuery)
  const status = useQuery(serverStatusQuery)

  const [group, setGroup] = useState<ConfigGroupId>(readGroupHash)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!data) {
      return
    }
    const next: Record<string, string> = {}
    for (const field of data.fields) {
      next[field.key] = field.value
    }
    setDraft(next)
  }, [data])

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

  const save = useMutation({
    mutationFn: (updates: Record<string, string>) => api.adminUpdateConfig(updates),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'config'] })
      setNotice(t('common.saved'))
    },
  })

  const restart = useMutation({
    mutationFn: () => api.adminRestart(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['server'] })
      setRestarting(false)
      setNotice(t('admin.moderation_done'))
    },
    onError: () => setRestarting(false),
  })

  const rows = useMemo<Row[]>(() => {
    return (data?.fields ?? []).map((field) => ({
      field,
      meta: settingMeta(field.key),
      group: settingGroup(field.key),
    }))
  }, [data])

  const originals = useMemo(() => {
    const map: Record<string, string> = {}
    for (const field of data?.fields ?? []) {
      map[field.key] = field.value
    }
    return map
  }, [data])

  const dirtyKeys = useMemo(() => {
    const dirty: string[] = []
    for (const row of rows) {
      if (row.meta?.readOnly) {
        continue
      }
      const next = draft[row.field.key]
      if (next === undefined) {
        continue
      }
      if (isSensitive(row.field.key, row.meta, row.field.secret) && next === '') {
        continue
      }
      if (next !== originals[row.field.key]) {
        dirty.push(row.field.key)
      }
    }
    return dirty
  }, [draft, originals, rows])

  const dirtySet = useMemo(() => new Set(dirtyKeys), [dirtyKeys])
  const searching = query.trim().length > 0

  const visible = useMemo(() => {
    const source = searching
      ? rows
          .map((row) => {
            const haystack = searchHaystack(row, t)
            const hit = fuzzyMatch(query, haystack)
            return hit ? { row, score: hit.score } : null
          })
          .filter((entry): entry is { row: Row; score: number } => entry !== null)
          .sort((left, right) => right.score - left.score)
          .map((entry) => entry.row)
      : group === 'featured'
        ? FEATURED_KEYS.map((key) => rows.find((row) => row.field.key === key)).filter(
            (row): row is Row => Boolean(row),
          )
        : rows.filter((row) => row.group === group)

    return source
  }, [group, query, rows, searching, t])

  const groupedVisible = useMemo(() => {
    const buckets = new Map<ConfigGroupId, Row[]>()
    for (const id of CONFIG_GROUPS) {
      buckets.set(id, [])
    }
    for (const row of visible) {
      const id = searching ? row.group : group === 'featured' ? 'featured' : row.group
      buckets.get(id)?.push(row)
    }
    return CONFIG_GROUPS.map((id) => ({
      id,
      rows: buckets.get(id) ?? [],
    })).filter((bucket) => bucket.rows.length > 0)
  }, [group, searching, visible])

  const groupCounts = useMemo(() => {
    const counts: Record<ConfigGroupId, number> = {
      featured: 0,
      general: 0,
      players: 0,
      pvp: 0,
      world: 0,
      safehouses: 0,
      network: 0,
      chat: 0,
      saves: 0,
      security: 0,
      mods: 0,
      other: 0,
    }
    for (const key of FEATURED_KEYS) {
      if (rows.some((row) => row.field.key === key)) {
        counts.featured += 1
      }
    }
    for (const row of rows) {
      counts[row.group] += 1
    }
    return counts
  }, [rows])

  const dirtyByGroup = useMemo(() => {
    const counts: Partial<Record<ConfigGroupId, number>> = {}
    for (const key of dirtyKeys) {
      const id = settingGroup(key)
      counts[id] = (counts[id] ?? 0) + 1
      if (FEATURED_KEY_SET.has(key)) {
        counts.featured = (counts.featured ?? 0) + 1
      }
    }
    return counts
  }, [dirtyKeys])

  function selectGroup(next: ConfigGroupId) {
    setGroup(next)
    writeGroupHash(next)
  }

  function setValue(key: string, value: string) {
    setDraft((current) => ({ ...current, [key]: value }))
    setNotice(null)
  }

  function discard() {
    setDraft({ ...originals })
    setNotice(null)
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (dirtyKeys.length === 0) {
      return
    }
    const updates: Record<string, string> = {}
    for (const key of dirtyKeys) {
      updates[key] = draft[key] ?? ''
    }
    setNotice(null)
    save.mutate(updates)
  }

  function toggleCollapsed(id: string) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const error =
    [save.error, restart.error].find(Boolean) instanceof ApiError
      ? ([save.error, restart.error].find(Boolean) as ApiError).message
      : [save.error, restart.error].find(Boolean)
        ? t('auth.unexpected_error')
        : null

  const navGroups = CONFIG_GROUPS.filter((id) => id === 'featured' || groupCounts[id] > 0)

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.server')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('admin.config_title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('admin.config_description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-mono text-[0.6875rem] text-dust">
            {dirtyKeys.length > 0
              ? t('admin.config_unsaved', { count: dirtyKeys.length })
              : t('admin.config_file')}
          </p>
          <Button size="sm" variant="outline" onClick={() => setRestarting(true)}>
            <RotateCcw aria-hidden="true" className="size-3.5" />
            {t('admin.action.restart')}
          </Button>
        </div>
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
      ) : data?.missing ? (
        <FormError>{t('admin.config_missing')}</FormError>
      ) : (
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <Panel bracketed className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-col gap-3 border-b border-fence px-3 py-3">
              <div className="relative min-w-0">
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
                  placeholder={t('admin.config_search_placeholder')}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-10 w-full border border-fence-bright bg-void pr-10 pl-10 font-mono text-sm text-bone placeholder:text-dust focus:border-hazard"
                  aria-describedby={`${searchId}-hint`}
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
                <p id={`${searchId}-hint`} className="sr-only">
                  {t('admin.config_search_hint')}
                </p>
              </div>

              <div className="lg:hidden">
                <TabStrip
                  label={t('admin.config_groups')}
                  items={navGroups.map((id) => ({
                    id,
                    label: t(groupLabelKey(id)),
                    count: dirtyByGroup[id] || groupCounts[id],
                  }))}
                  active={group}
                  onSelect={(id) => {
                    setQuery('')
                    selectGroup(id)
                  }}
                />
              </div>
            </div>

            <div className="grid min-h-0 flex-1 lg:grid-cols-[15rem_minmax(0,1fr)]">
              <nav
                aria-label={t('admin.config_groups')}
                className="hidden min-h-0 overflow-y-auto border-r border-fence lg:block"
              >
                <ul className="flex flex-col p-2">
                  {navGroups.map((id) => {
                    const Icon = GROUP_ICONS[id]
                    const selected = !searching && group === id
                    const dirty = dirtyByGroup[id] ?? 0

                    return (
                      <li key={id}>
                        <button
                          type="button"
                          onClick={() => {
                            setQuery('')
                            selectGroup(id)
                          }}
                          aria-current={selected ? 'true' : undefined}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-xs tracking-wide uppercase transition-colors',
                            selected
                              ? 'bg-hazard-soft text-hazard'
                              : 'text-smoke hover:bg-ash-raised hover:text-bone',
                          )}
                        >
                          <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate normal-case">
                            {t(groupLabelKey(id))}
                          </span>
                          {dirty > 0 ? (
                            <span className="tabular-nums text-hazard">{dirty}</span>
                          ) : (
                            <span className="tabular-nums text-dust">{groupCounts[id]}</span>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </nav>

              <div className="min-h-0 overflow-y-auto">
                {groupedVisible.length === 0 ? (
                  <p className="p-5 text-sm text-dust">{t('admin.config_no_matches')}</p>
                ) : (
                  groupedVisible.map((bucket) => {
                    const open = searching || !collapsed.has(bucket.id)
                    const Icon = GROUP_ICONS[bucket.id]

                    return (
                      <section key={bucket.id} className="border-b border-fence last:border-b-0">
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 px-4 py-3 text-left"
                          onClick={() => toggleCollapsed(bucket.id)}
                          aria-expanded={open}
                        >
                          <Icon aria-hidden="true" className="size-3.5 text-dust" />
                          <span className="eyebrow">{t(groupLabelKey(bucket.id))}</span>
                          <span className="font-mono text-[0.6875rem] text-dust tabular-nums">
                            {bucket.rows.length}
                          </span>
                          <ChevronDown
                            aria-hidden="true"
                            className={cn(
                              'ml-auto size-4 text-dust transition-transform',
                              open && 'rotate-180',
                            )}
                          />
                        </button>
                        {open ? (
                          <div className="divide-y divide-fence border-t border-fence">
                            {bucket.rows.map((row) => (
                              <SettingRow
                                key={row.field.key}
                                row={row}
                                value={draft[row.field.key] ?? ''}
                                dirty={dirtySet.has(row.field.key)}
                                onChange={(value) => setValue(row.field.key, value)}
                              />
                            ))}
                          </div>
                        ) : null}
                      </section>
                    )
                  })
                )}
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-fence bg-ash px-4 py-3">
              <Button type="submit" size="sm" disabled={save.isPending || dirtyKeys.length === 0}>
                {save.isPending ? t('common.saving') : t('common.save')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={dirtyKeys.length === 0 || save.isPending}
                onClick={discard}
              >
                {t('admin.config_discard')}
              </Button>
              <p className="text-xs text-dust">{t('admin.config_restart_hint')}</p>
            </div>
          </Panel>
        </form>
      )}

      <ConfirmDialog
        open={restarting}
        title={t('admin.action.restart')}
        description={
          status.data?.container === 'running'
            ? t('admin.action.restart_confirm')
            : t('admin.mods_restart_offline')
        }
        busy={restart.isPending}
        onConfirm={() => restart.mutate()}
        onClose={() => {
          if (!restart.isPending) {
            setRestarting(false)
          }
        }}
      />
    </section>
  )
}

function SettingRow({
  row,
  value,
  dirty,
  onChange,
}: {
  row: Row
  value: string
  dirty: boolean
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const id = `cfg-${row.field.key}`
  const meta = row.meta
  const label = hasSettingLabel(row.field.key)
    ? t(settingLabelKey(row.field.key))
    : humanizeKey(row.field.key)
  const help = hasSettingHelp(row.field.key) ? t(settingHelpKey(row.field.key)) : null
  const wide = meta?.type === 'text' || meta?.type === 'list'

  return (
    <div
      className={cn(
        'grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,20rem)] sm:items-start',
        wide && 'sm:grid-cols-1',
        dirty && 'bg-hazard-soft/30',
      )}
    >
      <div className="min-w-0">
        <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-sm text-bone">
          {dirty ? (
            <span aria-hidden="true" className="size-1.5 shrink-0 bg-hazard" />
          ) : null}
          <span>{label}</span>
          {meta?.readOnly ? (
            <span className="font-mono text-[0.625rem] tracking-widest text-dust uppercase">
              {t('admin.config_readonly')}
            </span>
          ) : null}
        </label>
        {help ? <p className="mt-1 text-xs leading-relaxed text-dust">{help}</p> : null}
        <p className="mt-1 font-mono text-[0.625rem] tracking-wide text-dust/80">{row.field.key}</p>
      </div>
      <SettingControl id={id} row={row} value={value} dirty={dirty} onChange={onChange} />
    </div>
  )
}

function SettingControl({
  id,
  row,
  value,
  dirty,
  onChange,
}: {
  id: string
  row: Row
  value: string
  dirty: boolean
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const meta = row.meta
  const sensitive = isSensitive(row.field.key, meta, row.field.secret)
  const box = cn(
    'h-10 w-full border bg-void px-3 font-mono text-sm text-bone',
    dirty ? 'border-hazard' : 'border-fence-bright focus:border-hazard',
  )

  if (meta?.readOnly && meta.type === 'list') {
    const items = splitList(value)
    return (
      <div>
        <div className="flex flex-wrap gap-1.5">
          {items.length > 0 ? (
            items.map((item) => (
              <span
                key={item}
                className="border border-fence bg-void px-2 py-1 font-mono text-[0.6875rem] text-smoke"
              >
                {item}
              </span>
            ))
          ) : (
            <span className="text-xs text-dust">{t('common.none_found')}</span>
          )}
        </div>
        <Link
          to="/admin/mods"
          className="mt-2 inline-block font-mono text-[0.6875rem] tracking-widest text-hazard uppercase hover:underline"
        >
          {t('admin.config_manage_mods')}
        </Link>
      </div>
    )
  }

  if (meta?.readOnly) {
    return (
      <p className="border border-fence bg-void px-3 py-2 font-mono text-sm text-dust">
        {sensitive ? '••••••' : value || '—'}
      </p>
    )
  }

  if (meta?.type === 'boolean') {
    const on = parseBoolean(value)
    return (
      <div className="flex items-center gap-3">
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={on}
          onClick={() => onChange(on ? 'false' : 'true')}
          className={cn(
            'relative h-7 w-12 shrink-0 border transition-colors',
            on ? 'border-hazard bg-hazard-soft' : 'border-fence-bright bg-void',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'absolute top-0.5 size-5 transition-all',
              on ? 'left-6 bg-hazard' : 'left-0.5 bg-smoke',
            )}
          />
        </button>
        <span className="font-mono text-xs tracking-widest text-dust uppercase">
          {on ? t('common.enabled') : t('common.disabled')}
        </span>
      </div>
    )
  }

  if (meta?.type === 'enum' && meta.options) {
    return (
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={box}
      >
        {meta.options.some((option) => option.value === value) ? null : (
          <option value={value}>{value}</option>
        )}
        {meta.options.map((option) => (
          <option key={option.value} value={option.value}>
            {t(option.label)}
          </option>
        ))}
      </select>
    )
  }

  if (meta?.type === 'number') {
    return (
      <input
        id={id}
        type="number"
        value={value}
        min={meta.min}
        max={meta.max}
        step={meta.step ?? (value.includes('.') ? 0.1 : 1)}
        onChange={(event) => onChange(event.target.value)}
        className={box}
      />
    )
  }

  if (meta?.type === 'text') {
    return <RichTextInput id={id} value={value} dirty={dirty} onChange={onChange} />
  }

  if (sensitive || meta?.type === 'password') {
    return (
      <PasswordInput
        id={id}
        value={value}
        dirty={dirty}
        hint={row.field.secret ? t('admin.config_secret_hint') : undefined}
        onChange={onChange}
      />
    )
  }

  return (
    <input
      id={id}
      type="text"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      autoComplete="off"
      spellCheck={false}
      className={box}
    />
  )
}

function PasswordInput({
  id,
  value,
  dirty,
  hint,
  onChange,
}: {
  id: string
  value: string
  dirty: boolean
  hint?: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)

  return (
    <div>
      <div className="relative">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="new-password"
          className={cn(
            'h-10 w-full border bg-void pr-10 pl-3 font-mono text-sm text-bone',
            dirty ? 'border-hazard' : 'border-fence-bright focus:border-hazard',
          )}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          className="absolute top-1/2 right-2 -translate-y-1/2 p-1 text-dust hover:text-bone"
          tabIndex={-1}
        >
          {visible ? (
            <EyeOff aria-hidden="true" className="size-3.5" />
          ) : (
            <Eye aria-hidden="true" className="size-3.5" />
          )}
          <span className="sr-only">
            {visible ? t('admin.config_hide_value') : t('admin.config_show_value')}
          </span>
        </button>
      </div>
      {hint ? <p className="mt-1 text-xs text-dust">{hint}</p> : null}
    </div>
  )
}

function RichTextInput({
  id,
  value,
  dirty,
  onChange,
}: {
  id: string
  value: string
  dirty: boolean
  onChange: (value: string) => void
}) {
  const field = useRef<HTMLTextAreaElement>(null)

  function insertLineBreak() {
    const element = field.current
    if (!element) {
      return
    }
    const start = element.selectionStart
    const end = element.selectionEnd
    onChange(value.slice(0, start) + LINE_BREAK_TAG + value.slice(end))
    const caret = start + LINE_BREAK_TAG.length
    requestAnimationFrame(() => element.setSelectionRange(caret, caret))
  }

  return (
    <textarea
      id={id}
      ref={field}
      rows={4}
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/\r?\n/g, LINE_BREAK_TAG))}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          insertLineBreak()
        }
      }}
      className={cn(
        'min-h-24 w-full border bg-void px-3 py-2 font-mono text-sm text-bone',
        dirty ? 'border-hazard' : 'border-fence-bright focus:border-hazard',
      )}
    />
  )
}

function searchHaystack(row: Row, t: (key: TranslationKey) => string): string {
  const label = hasSettingLabel(row.field.key)
    ? t(settingLabelKey(row.field.key))
    : humanizeKey(row.field.key)
  const help = hasSettingHelp(row.field.key) ? t(settingHelpKey(row.field.key)) : ''
  const value = isSensitive(row.field.key, row.meta, row.field.secret) ? '' : row.field.value
  return `${label} ${row.field.key} ${help} ${value}`
}

function readGroupHash(): ConfigGroupId {
  if (typeof window === 'undefined') {
    return 'featured'
  }
  const raw = window.location.hash.replace('#', '')
  return (CONFIG_GROUPS as readonly string[]).includes(raw) ? (raw as ConfigGroupId) : 'featured'
}

function writeGroupHash(group: ConfigGroupId) {
  if (typeof window === 'undefined') {
    return
  }
  window.history.replaceState(null, '', `#${group}`)
}
