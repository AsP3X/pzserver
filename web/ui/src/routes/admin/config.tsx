import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  BookOpen,
  Bug,
  Car,
  ChevronDown,
  ChevronRight,
  Clock,
  Cloud,
  Eye,
  EyeOff,
  GraduationCap,
  Home,
  MessageSquare,
  MoreHorizontal,
  Package,
  PawPrint,
  Puzzle,
  RotateCcw,
  Save,
  Search,
  Shield,
  Swords,
  User,
  Users,
  Wifi,
  X,
  Zap,
  Globe,
  Map as MapIcon,
  Star,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { TabStrip } from '@/components/ui/tabs'
import { api, ApiError, type ConfigField, type MapTileSettings } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  CONFIG_GROUPS,
  FEATURED_KEYS,
  SANDBOX_FEATURED_KEYS,
  SANDBOX_GROUPS,
  featuredKeysFor,
  groupByParentTable,
  groupLabelKey,
  groupsFor,
  hasSettingHelp,
  hasSettingLabel,
  humanizeKey,
  humanizeTable,
  isSensitive,
  numberInputStep,
  parseBoolean,
  settingGroup,
  settingHelpKey,
  settingLabelKey,
  settingMeta,
  splitList,
  type ConfigSource,
  type SettingMeta,
} from '@/lib/config-metadata'
import { fuzzyMatch } from '@/lib/fuzzy'
import { adminConfigQuery, adminMapTileSettingsQuery, adminSandboxQuery, serverStatusQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

const LINE_BREAK_TAG = ' <LINE> '
const FEATURED_KEY_SET = new Set<string>(FEATURED_KEYS)
const SANDBOX_FEATURED_KEY_SET = new Set<string>(SANDBOX_FEATURED_KEYS)

const GROUP_ICONS: Record<string, LucideIcon> = {
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
  mods: Puzzle,
  other: MoreHorizontal,
  population: Bug,
  lore: BookOpen,
  time: Clock,
  climate: Cloud,
  utilities: Zap,
  loot: Package,
  vehicles: Car,
  animals: PawPrint,
  combat: Swords,
  character: User,
  skills: GraduationCap,
  map: MapIcon,
}

function groupIcon(id: string): LucideIcon {
  return GROUP_ICONS[id] ?? MoreHorizontal
}

type ConfigTab = ConfigSource | 'debug'

type Row = {
  field: ConfigField
  meta?: SettingMeta
  group: string
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

  const hash = readConfigHash()
  const [tab, setTab] = useState<ConfigTab>(hash.tab)
  const [group, setGroup] = useState<string>(hash.group)
  const source: ConfigSource = tab === 'sandbox' ? 'sandbox' : 'server'
  const server = useQuery(adminConfigQuery)
  const sandbox = useQuery(adminSandboxQuery)
  const status = useQuery(serverStatusQuery)
  const active = source === 'sandbox' ? sandbox : server
  const data = active.data
  const isPending = active.isPending
  const isError = active.isError
  const refetch = active.refetch

  const [query, setQuery] = useState('')
  const [serverDraft, setServerDraft] = useState<Record<string, string>>({})
  const [sandboxDraft, setSandboxDraft] = useState<Record<string, string>>({})
  const draft = source === 'sandbox' ? sandboxDraft : serverDraft
  const setDraft = source === 'sandbox' ? setSandboxDraft : setServerDraft
  const [notice, setNotice] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!server.data) {
      return
    }
    const next: Record<string, string> = {}
    for (const field of server.data.fields) {
      next[field.key] = field.value
    }
    setServerDraft(next)
  }, [server.data])

  useEffect(() => {
    if (!sandbox.data) {
      return
    }
    const next: Record<string, string> = {}
    for (const field of sandbox.data.fields) {
      next[field.key] = field.value
    }
    setSandboxDraft(next)
  }, [sandbox.data])

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
    mutationFn: (updates: Record<string, string>) =>
      source === 'sandbox' ? api.adminUpdateSandbox(updates) : api.adminUpdateConfig(updates),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: source === 'sandbox' ? ['admin', 'config', 'sandbox'] : ['admin', 'config'],
      })
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

  const featuredKeys = featuredKeysFor(source)
  const sourceGroups = groupsFor(source)

  const rows = useMemo<Row[]>(() => {
    return (data?.fields ?? []).map((field) => {
      if (source === 'sandbox') {
        return {
          field,
          meta: sandboxSettingMeta(field),
          group: field.group ?? 'other',
        }
      }
      return {
        field,
        meta: settingMeta(field.key),
        group: settingGroup(field.key),
      }
    })
  }, [data, source])

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
      if (row.meta?.readOnly || row.field.read_only) {
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
    if (searching) {
      return rows
        .map((row) => {
          const haystack = searchHaystack(row, t)
          const hit = fuzzyMatch(query, haystack)
          return hit ? { row, score: hit.score } : null
        })
        .filter((entry): entry is { row: Row; score: number } => entry !== null)
        .sort((left, right) => right.score - left.score)
        .map((entry) => entry.row)
    }
    if (group === 'featured') {
      return featuredKeys
        .map((key) => rows.find((row) => row.field.key === key))
        .filter((row): row is Row => Boolean(row))
    }
    return rows.filter((row) => row.group === group)
  }, [featuredKeys, group, query, rows, searching, t])

  const groupedVisible = useMemo(() => {
    const buckets = new Map<string, Row[]>()
    for (const id of sourceGroups) {
      buckets.set(id, [])
    }
    for (const row of visible) {
      const id = searching ? row.group : group === 'featured' ? 'featured' : row.group
      if (!buckets.has(id)) {
        buckets.set(id, [])
      }
      buckets.get(id)?.push(row)
    }
    return sourceGroups
      .map((id) => ({
        id,
        rows: buckets.get(id) ?? [],
      }))
      .filter((bucket) => bucket.rows.length > 0)
  }, [group, searching, sourceGroups, visible])

  const sections = useMemo(() => {
    return groupedVisible.flatMap((bucket) => {
      if (bucket.id !== 'mods') {
        return [
          {
            id: bucket.id,
            title: null as string | null,
            group: bucket.id,
            rows: bucket.rows,
            collapsedByDefault: false,
          },
        ]
      }
      return groupByParentTable(bucket.rows, (row) => row.field.key).map((entry) => ({
        id: `mods:${entry.table}`,
        title: humanizeTable(entry.table),
        group: 'mods',
        rows: entry.items,
        collapsedByDefault: true,
      }))
    })
  }, [groupedVisible])

  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const id of sourceGroups) {
      counts[id] = 0
    }
    for (const key of featuredKeys) {
      if (rows.some((row) => row.field.key === key)) {
        counts.featured = (counts.featured ?? 0) + 1
      }
    }
    for (const row of rows) {
      counts[row.group] = (counts[row.group] ?? 0) + 1
    }
    return counts
  }, [featuredKeys, rows, sourceGroups])

  const dirtyByGroup = useMemo(() => {
    const counts: Record<string, number> = {}
    const featured = source === 'sandbox' ? SANDBOX_FEATURED_KEY_SET : FEATURED_KEY_SET
    for (const key of dirtyKeys) {
      const row = rows.find((entry) => entry.field.key === key)
      const id = row?.group ?? settingGroup(key)
      counts[id] = (counts[id] ?? 0) + 1
      if (featured.has(key)) {
        counts.featured = (counts.featured ?? 0) + 1
      }
    }
    return counts
  }, [dirtyKeys, rows, source])

  function selectGroup(next: string) {
    setGroup(next)
    writeConfigHash(tab === 'debug' ? source : tab, next)
  }

  function selectTab(next: ConfigTab) {
    setTab(next)
    setQuery('')
    setNotice(null)
    if (next === 'debug') {
      writeConfigHash('debug', 'featured')
      return
    }
    const nextGroup = 'featured'
    setGroup(nextGroup)
    writeConfigHash(next, nextGroup)
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

  const navGroups = sourceGroups.filter((id) => id === 'featured' || (groupCounts[id] ?? 0) > 0)

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.server')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('admin.config_title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">
            {tab === 'debug'
              ? t('admin.config_debug_description')
              : source === 'sandbox'
                ? t('admin.config_sandbox_description')
                : t('admin.config_description')}
          </p>
          <div className="mt-3 max-w-lg">
            <TabStrip
              label={t('admin.config_title')}
              items={[
                { id: 'server', label: t('admin.config_source_server') },
                {
                  id: 'sandbox',
                  label: t('admin.config_source_sandbox'),
                  count: sandbox.data?.fields.length,
                },
                { id: 'debug', label: t('admin.config_source_debug') },
              ]}
              active={tab}
              onSelect={(id) => selectTab(id)}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tab !== 'debug' ? (
            <p className="font-mono text-[0.6875rem] text-dust">
              {dirtyKeys.length > 0
                ? t('admin.config_unsaved', { count: dirtyKeys.length })
                : source === 'sandbox'
                  ? t('admin.config_file_sandbox')
                  : t('admin.config_file')}
            </p>
          ) : null}
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

      {tab === 'debug' ? (
        <DebugSettings />
      ) : isPending ? (
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
                    const Icon = groupIcon(id)
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
                {sections.length === 0 ? (
                  <p className="p-5 text-sm text-dust">{t('admin.config_no_matches')}</p>
                ) : (
                  sections.map((section) => {
                    const flipped = collapsed.has(section.id)
                    const open = searching || (section.collapsedByDefault ? flipped : !flipped)
                    const Icon = groupIcon(section.group)
                    const dirtyCount = section.rows.filter((row) => dirtySet.has(row.field.key)).length
                    const preview = section.rows.slice(0, 3).map((row) =>
                      hasSettingLabel(row.field.key)
                        ? t(settingLabelKey(row.field.key))
                        : humanizeKey(row.field.key),
                    )
                    const extra = section.rows.length - preview.length
                    const heading = section.title ?? t(groupLabelKey(section.group))

                    return (
                      <section key={section.id} className="border-b border-fence last:border-b-0">
                        <button
                          type="button"
                          className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-ash-raised"
                          onClick={() => toggleCollapsed(section.id)}
                          aria-expanded={open}
                          aria-label={`${heading}, ${t('admin.config_option_count', { count: section.rows.length })}`}
                        >
                          <span className="flex items-center gap-2">
                            <Icon aria-hidden="true" className="size-3.5 shrink-0 text-dust" />
                            <span className="eyebrow min-w-0 flex-1 truncate">{heading}</span>
                            <span
                              className={cn(
                                'shrink-0 border px-1.5 py-0.5 font-mono text-[0.625rem] tracking-wide tabular-nums uppercase',
                                dirtyCount > 0
                                  ? 'border-hazard/50 text-hazard'
                                  : 'border-fence-bright text-smoke',
                              )}
                            >
                              {t('admin.config_option_count', { count: section.rows.length })}
                            </span>
                            {open ? (
                              <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-smoke" />
                            ) : (
                              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-smoke" />
                            )}
                          </span>
                          {open ? null : (
                            <span className="pl-6 text-xs leading-relaxed text-dust">
                              {preview.join(', ')}
                              {extra > 0
                                ? ` · ${t('admin.config_section_more', { count: extra })}`
                                : ''}
                            </span>
                          )}
                        </button>
                        {open ? (
                          <div className="divide-y divide-fence border-t border-fence">
                            {section.rows.map((row) => (
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
  const help = row.field.help
    ? row.field.help
    : hasSettingHelp(row.field.key)
      ? t(settingHelpKey(row.field.key))
      : null
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
            {option.text ?? (option.label ? t(option.label) : option.value)}
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
        step={meta.step ?? numberInputStep(value, meta.min, meta.max)}
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

function DebugSettings() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const query = useQuery(adminMapTileSettingsQuery)
  const [batch, setBatch] = useState(8)
  const [waitMinutes, setWaitMinutes] = useState(5)
  const [notice, setNotice] = useState<string | null>(null)

  const settings = query.data

  useEffect(() => {
    if (!settings) {
      return
    }
    setBatch(settings.batch_blocks)
    setWaitMinutes(Math.round(settings.max_wait_secs / 60))
  }, [settings])

  const save = useMutation({
    mutationFn: (input: Partial<MapTileSettings>) => api.adminUpdateMapTileSettings(input),
    onSuccess: async () => {
      setNotice(t('admin.map_tiles_saved'))
      await queryClient.invalidateQueries({ queryKey: ['admin', 'map-tiles'] })
    },
  })

  const error =
    save.error instanceof ApiError
      ? save.error.message
      : save.error
        ? t('auth.unexpected_error')
        : query.isError
          ? t('common.error')
          : null

  if (query.isPending) {
    return <Skeleton className="min-h-0 flex-1" />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {notice ? (
        <p role="status" className="shrink-0 border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? (
        <div>
          <FormError>{error}</FormError>
          {query.isError ? (
            <Button size="sm" variant="outline" className="mt-3" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {settings ? (
        <Panel bracketed className="shrink-0">
          <PanelHeader label={t('admin.map_tiles_settings')} />
          <div className="flex flex-col gap-3 p-4">
            <p className="text-sm text-smoke">{t('admin.map_tiles_settings_hint')}</p>
            <label className="flex items-center gap-2 text-sm text-bone">
              <input
                type="checkbox"
                checked={settings.auto_rerender}
                disabled={save.isPending}
                onChange={(event) => save.mutate({ auto_rerender: event.target.checked })}
              />
              {t('admin.map_tiles_auto')}
            </label>
            <label className="flex items-center gap-2 text-sm text-bone">
              <input
                type="checkbox"
                checked={settings.debug_overlay}
                disabled={save.isPending}
                onChange={(event) => save.mutate({ debug_overlay: event.target.checked })}
              />
              {t('admin.map_tiles_debug')}
            </label>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
              <Field
                type="number"
                min={1}
                max={256}
                label={t('admin.map_tiles_batch')}
                value={batch}
                disabled={save.isPending || !settings.auto_rerender}
                onChange={(event) => setBatch(Number(event.target.value) || 1)}
              />
              <Field
                type="number"
                min={0}
                max={1440}
                label={t('admin.map_tiles_wait')}
                value={waitMinutes}
                disabled={save.isPending || !settings.auto_rerender}
                onChange={(event) => setWaitMinutes(Number(event.target.value) || 0)}
              />
              <Button
                size="sm"
                disabled={save.isPending || !settings.auto_rerender}
                onClick={() =>
                  save.mutate({
                    batch_blocks: Math.min(256, Math.max(1, batch)),
                    max_wait_secs: Math.min(86_400, Math.max(0, waitMinutes * 60)),
                  })
                }
              >
                {t('common.save')}
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}
    </div>
  )
}

function searchHaystack(row: Row, t: (key: TranslationKey) => string): string {
  const label = hasSettingLabel(row.field.key)
    ? t(settingLabelKey(row.field.key))
    : humanizeKey(row.field.key)
  const help = row.field.help
    ? row.field.help
    : hasSettingHelp(row.field.key)
      ? t(settingHelpKey(row.field.key))
      : ''
  const value = isSensitive(row.field.key, row.meta, row.field.secret) ? '' : row.field.value
  return `${label} ${row.field.key} ${help} ${value}`
}

function sandboxSettingMeta(field: ConfigField): SettingMeta {
  const kind = field.kind ?? 'string'
  return {
    type: kind,
    group: field.group ?? 'other',
    readOnly: field.read_only,
    min: field.min ?? undefined,
    max: field.max ?? undefined,
    step: kind === 'number' ? numberInputStep(field.value, field.min ?? undefined, field.max ?? undefined) : undefined,
    options: field.options?.map((option) => ({
      value: option.value,
      text: option.label,
    })),
  }
}

function readConfigHash(): { tab: ConfigTab; group: string } {
  if (typeof window === 'undefined') {
    return { tab: 'server', group: 'featured' }
  }
  const raw = window.location.hash.replace('#', '')
  if (raw === 'debug' || raw.startsWith('debug/')) {
    return { tab: 'debug', group: 'featured' }
  }
  if (raw === 'sandbox' || raw.startsWith('sandbox/')) {
    const group = raw.split('/')[1] || 'featured'
    return {
      tab: 'sandbox',
      group: (SANDBOX_GROUPS as readonly string[]).includes(group) ? group : 'featured',
    }
  }
  return {
    tab: 'server',
    group: (CONFIG_GROUPS as readonly string[]).includes(raw) ? raw : 'featured',
  }
}

function writeConfigHash(tab: ConfigTab, group: string) {
  if (typeof window === 'undefined') {
    return
  }
  const hash =
    tab === 'debug' ? 'debug' : tab === 'sandbox' ? `sandbox/${group}` : group
  window.history.replaceState(null, '', `#${hash}`)
}
