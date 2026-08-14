import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarClock,
  ChevronRight,
  Download,
  File,
  FileText,
  Folder,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError, TextAreaField } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import {
  api,
  ApiError,
  type BackupArchiveEntry,
  type BackupRecord,
  type BackupSchedule,
  type BackupType,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatBytes, formatDateTime } from '@/lib/format'
import { fuzzyMatch } from '@/lib/fuzzy'
import { adminBackupContentsQuery, adminBackupScheduleQuery, adminBackupsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'
import { BackupEditorDialog, isTextBackupFile, type OpenBackupFile } from '@/routes/admin/backup-editor'

const TYPES: { id: 'all' | BackupType; label: TranslationKey }[] = [
  { id: 'all', label: 'common.all' },
  { id: 'manual', label: 'admin.backups_type_manual' },
  { id: 'scheduled', label: 'admin.backups_type_scheduled' },
  { id: 'daily', label: 'admin.backups_type_daily' },
  { id: 'pre_rollback', label: 'admin.backups_type_pre_rollback' },
  { id: 'pre_update', label: 'admin.backups_type_pre_update' },
  { id: 'pre_import', label: 'admin.backups_type_pre_import' },
]

const COUNTDOWNS = [0, 60, 120, 300, 600, 1800] as const

type RetentionKey =
  | 'retention_manual'
  | 'retention_scheduled'
  | 'retention_daily'
  | 'retention_pre_rollback'
  | 'retention_pre_update'
  | 'retention_pre_import'

const RETENTION: { key: RetentionKey; label: TranslationKey }[] = [
  { key: 'retention_manual', label: 'admin.backups_type_manual' },
  { key: 'retention_scheduled', label: 'admin.backups_type_scheduled' },
  { key: 'retention_daily', label: 'admin.backups_type_daily' },
  { key: 'retention_pre_rollback', label: 'admin.backups_type_pre_rollback' },
  { key: 'retention_pre_update', label: 'admin.backups_type_pre_update' },
  { key: 'retention_pre_import', label: 'admin.backups_type_pre_import' },
]

function typeLabel(kind: string): TranslationKey {
  return TYPES.find((item) => item.id === kind)?.label ?? 'admin.backups_type_manual'
}

function typeTone(kind: string): string {
  if (kind === 'scheduled' || kind === 'daily') {
    return 'text-moss'
  }
  if (kind === 'pre_rollback' || kind === 'pre_import' || kind === 'pre_update') {
    return 'text-hazard'
  }
  return 'text-smoke'
}

/**
 * Archives of the world. Left: the catalogue. Right: the selected archive,
 * or the schedule when nothing is selected. Create / import / rollback are
 * dialogs so the list never moves.
 */
export function AdminBackupsPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const searchRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const backupsQuery = useQuery(adminBackupsQuery)
  const scheduleQuery = useQuery(adminBackupScheduleQuery)

  const [kind, setKind] = useState<(typeof TYPES)[number]['id']>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [notes, setNotes] = useState('')
  const [notify, setNotify] = useState(false)
  const [noticeMsg, setNoticeMsg] = useState('')
  const [rollback, setRollback] = useState<BackupRecord | null>(null)
  const [countdown, setCountdown] = useState<(typeof COUNTDOWNS)[number]>(0)
  const [warning, setWarning] = useState('')
  const [remove, setRemove] = useState<BackupRecord | null>(null)
  const [bulk, setBulk] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importConfirm, setImportConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const backups = backupsQuery.data?.backups ?? []
  const job = backupsQuery.data?.job ?? null
  const lastError = backupsQuery.data?.last_error ?? null
  const schedule = scheduleQuery.data
  const busy = Boolean(job)

  const visible = useMemo(() => {
    const filtered = kind === 'all' ? backups : backups.filter((item) => item.type === kind)
    if (!query.trim()) {
      return filtered
    }
    return filtered
      .map((item) => {
        const hit = fuzzyMatch(query, `${item.filename} ${item.notes ?? ''} ${item.type}`)
        return hit ? { item, score: hit.score } : null
      })
      .filter((row): row is { item: BackupRecord; score: number } => row !== null)
      .sort((left, right) => right.score - left.score)
      .map((row) => row.item)
  }, [backups, kind, query])

  const current = backups.find((item) => item.id === selected) ?? null
  const allVisiblePicked = visible.length > 0 && visible.every((item) => picked.has(item.id))

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

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'backups'] })
  }

  function fail(cause: unknown) {
    setNotice(null)
    setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
  }

  const create = useMutation({
    mutationFn: () =>
      api.adminCreateBackup({
        notes: notes.trim() || undefined,
        notify_players: notify,
        message: notify ? noticeMsg.trim() || undefined : undefined,
      }),
    onSuccess: async (result) => {
      setCreating(false)
      setNotes('')
      setNotify(false)
      setNoticeMsg('')
      setError(null)
      setNotice(result.message)
      await refresh()
    },
    onError: fail,
  })

  const destroy = useMutation({
    mutationFn: (id: string) => api.adminDeleteBackup(id),
    onSuccess: async (result, id) => {
      setRemove(null)
      setSelected((currentId) => (currentId === id ? null : currentId))
      setPicked((currentPicked) => {
        const next = new Set(currentPicked)
        next.delete(id)
        return next
      })
      setError(null)
      setNotice(result.message)
      await refresh()
    },
    onError: fail,
  })

  const destroyMany = useMutation({
    mutationFn: () => api.adminDeleteBackups([...picked]),
    onSuccess: async (result) => {
      setBulk(false)
      if (selected && picked.has(selected)) {
        setSelected(null)
      }
      setPicked(new Set())
      setError(null)
      setNotice(result.message)
      await refresh()
    },
    onError: fail,
  })

  const restore = useMutation({
    mutationFn: () => {
      if (!rollback) {
        throw new Error('missing backup')
      }
      return api.adminRollbackBackup(rollback.id, {
        confirm: true,
        countdown: countdown || undefined,
        message: warning.trim() || undefined,
      })
    },
    onSuccess: async (result) => {
      setRollback(null)
      setCountdown(0)
      setWarning('')
      setError(null)
      setNotice(result.message)
      await refresh()
    },
    onError: fail,
  })

  const saveSchedule = useMutation({
    mutationFn: (input: Partial<BackupSchedule>) => api.adminUpdateBackupSchedule(input),
    onSuccess: async () => {
      setError(null)
      setNotice(t('admin.backups_schedule_saved'))
      await queryClient.invalidateQueries({ queryKey: ['admin', 'backups', 'schedule'] })
    },
    onError: fail,
  })

  const imported = useMutation({
    mutationFn: () => {
      if (!importFile) {
        throw new Error('missing file')
      }
      return api.adminImportWorld(importFile)
    },
    onSuccess: async (result) => {
      setImporting(false)
      setImportFile(null)
      setImportConfirm(false)
      setError(null)
      setNotice(result.message)
      await refresh()
    },
    onError: fail,
  })

  function togglePick(id: string) {
    setPicked((currentPicked) => {
      const next = new Set(currentPicked)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function togglePickAll() {
    setPicked((currentPicked) => {
      if (allVisiblePicked) {
        const next = new Set(currentPicked)
        for (const item of visible) {
          next.delete(item.id)
        }
        return next
      }
      const next = new Set(currentPicked)
      for (const item of visible) {
        next.add(item.id)
      }
      return next
    })
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.server')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('admin.backups_title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('admin.backups_description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {picked.size > 0 ? (
            <Button size="sm" variant="outline" onClick={() => setBulk(true)}>
              <Trash2 aria-hidden="true" className="size-3.5" />
              {t('admin.backups_delete_selected', { count: picked.size })}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => setImporting(true)} disabled={busy}>
            <Upload aria-hidden="true" className="size-3.5" />
            {t('admin.backups_import')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setError(null)
              setCreating(true)
            }}
            disabled={busy}
          >
            <Plus aria-hidden="true" className="size-3.5" />
            {t('admin.backups_create')}
          </Button>
        </div>
      </header>

      {job ? (
        <p role="status" className="shrink-0 border border-hazard/40 bg-hazard-soft px-3 py-2 text-sm text-hazard">
          {job.detail}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="shrink-0 border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {lastError && !job ? <FormError>{lastError}</FormError> : null}
      {error ? <FormError>{error}</FormError> : null}

      <div className="flex shrink-0 flex-col gap-3 border border-fence bg-ash px-3 py-3 lg:flex-row lg:items-end">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('admin.backups_kind')}>
          {TYPES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setKind(item.id)}
              aria-pressed={kind === item.id}
              className={cn(
                'border px-2 py-1 font-mono text-[0.6875rem] tracking-widest uppercase',
                kind === item.id
                  ? 'border-hazard bg-hazard-soft text-hazard'
                  : 'border-fence text-dust hover:border-fence-bright hover:text-bone',
              )}
            >
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
            placeholder={t('admin.backups_search')}
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
      </div>

      {backupsQuery.isPending ? (
        <Skeleton className="min-h-0 flex-1" />
      ) : backupsQuery.isError ? (
        <div>
          <FormError>{t('common.error')}</FormError>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void backupsQuery.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)]">
          <Panel bracketed className="flex min-h-0 flex-col">
            <PanelHeader
              label={t('admin.backups_list')}
              action={
                <span className="flex items-center gap-3">
                  {visible.length > 0 ? (
                    <label className="flex items-center gap-2 font-mono text-[0.6875rem] text-dust">
                      <input
                        type="checkbox"
                        checked={allVisiblePicked}
                        onChange={togglePickAll}
                        aria-label={t('admin.backups_select_all')}
                      />
                      {t('admin.backups_select_all')}
                    </label>
                  ) : null}
                  <span className="font-mono text-[0.6875rem] text-dust">
                    {t('admin.backups_showing', { count: visible.length })}
                  </span>
                </span>
              }
            />
            {visible.length === 0 ? (
              <p className="p-5 text-sm text-dust">
                {backups.length === 0 ? t('admin.backups_empty') : t('common.none_found')}
              </p>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
                {visible.map((backup) => (
                  <li key={backup.id}>
                    <div
                      className={cn(
                        'flex items-start gap-3 px-4 py-3',
                        backup.id === current?.id ? 'bg-hazard-soft' : 'hover:bg-ash-raised',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={picked.has(backup.id)}
                        onChange={() => togglePick(backup.id)}
                        className="mt-1"
                        aria-label={backup.filename}
                      />
                      <button
                        type="button"
                        onClick={() => setSelected(backup.id)}
                        aria-current={backup.id === current?.id ? 'true' : undefined}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-sm text-bone">{backup.filename}</span>
                          <span
                            className={cn(
                              'shrink-0 font-mono text-[0.625rem] tracking-widest uppercase',
                              typeTone(backup.type),
                            )}
                          >
                            {t(typeLabel(backup.type))}
                          </span>
                        </span>
                        <span className="mt-1 flex flex-wrap gap-x-3 font-mono text-[0.6875rem] text-dust">
                          <span>{backup.size_human}</span>
                          <span>{formatDateTime(backup.created_at, intlLocale)}</span>
                          {backup.missing ? <span className="text-blood">{t('admin.backups_missing')}</span> : null}
                        </span>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel bracketed className="flex min-h-0 flex-col">
            {current ? (
              <Inspector
                backup={current}
                locale={intlLocale}
                busy={busy}
                onSchedule={() => setSelected(null)}
                onRollback={() => setRollback(current)}
                onDelete={() => setRemove(current)}
              />
            ) : schedule ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <SchedulePane
                  key={[
                    schedule.hourly_enabled,
                    schedule.daily_enabled,
                    schedule.daily_time,
                    schedule.retention_manual,
                    schedule.retention_scheduled,
                    schedule.retention_daily,
                    schedule.retention_pre_rollback,
                    schedule.retention_pre_update,
                    schedule.retention_pre_import,
                  ].join(':')}
                  schedule={schedule}
                  busy={saveSchedule.isPending}
                  onSave={(patch) => saveSchedule.mutate(patch)}
                />
              </div>
            ) : (
              <Skeleton className="m-5 h-40" />
            )}
          </Panel>
        </div>
      )}

      <CreateDialog
        open={creating}
        notes={notes}
        notify={notify}
        message={noticeMsg}
        busy={create.isPending}
        onNotes={setNotes}
        onNotify={setNotify}
        onMessage={setNoticeMsg}
        onClose={() => setCreating(false)}
        onConfirm={() => create.mutate()}
      />

      <ConfirmDialog
        open={remove !== null}
        title={t('admin.backups_delete_title')}
        description={t('admin.backups_delete_body', { filename: remove?.filename ?? '' })}
        confirmLabel={t('common.delete')}
        tone="danger"
        busy={destroy.isPending}
        onConfirm={() => remove && destroy.mutate(remove.id)}
        onClose={() => setRemove(null)}
      />

      <ConfirmDialog
        open={bulk}
        title={t('admin.backups_bulk_title')}
        description={t('admin.backups_bulk_body', { count: picked.size })}
        confirmLabel={t('admin.backups_delete_selected', { count: picked.size })}
        tone="danger"
        busy={destroyMany.isPending}
        onConfirm={() => destroyMany.mutate()}
        onClose={() => setBulk(false)}
      />

      <RollbackDialog
        backup={rollback}
        countdown={countdown}
        warning={warning}
        busy={restore.isPending}
        onCountdown={setCountdown}
        onWarning={setWarning}
        onClose={() => setRollback(null)}
        onConfirm={() => restore.mutate()}
      />

      <ImportDialog
        open={importing}
        file={importFile}
        confirmed={importConfirm}
        busy={imported.isPending}
        locale={intlLocale}
        fileRef={fileRef}
        onFile={setImportFile}
        onConfirmChange={setImportConfirm}
        onClose={() => {
          setImporting(false)
          setImportFile(null)
          setImportConfirm(false)
        }}
        onSubmit={() => imported.mutate()}
      />
    </section>
  )
}

function Inspector({
  backup,
  locale,
  busy,
  onSchedule,
  onRollback,
  onDelete,
}: {
  backup: BackupRecord
  locale: string
  busy: boolean
  onSchedule: () => void
  onRollback: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        label={t('admin.backups_detail')}
        action={
          <button
            type="button"
            onClick={onSchedule}
            className="inline-flex items-center gap-1.5 font-mono text-[0.6875rem] tracking-widest text-dust uppercase hover:text-bone"
          >
            <CalendarClock aria-hidden="true" className="size-3.5" />
            {t('admin.backups_open_schedule')}
          </button>
        }
      />
      <div className="shrink-0 border-b border-fence p-5">
        <p className="break-all font-mono text-sm text-bone">{backup.filename}</p>
        <p className={cn('mt-2 font-mono text-[0.6875rem] tracking-widest uppercase', typeTone(backup.type))}>
          {t(typeLabel(backup.type))}
        </p>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <Fact label={t('admin.backups_size')} value={backup.size_human} />
          <Fact label={t('admin.backups_date')} value={formatDateTime(backup.created_at, locale)} />
          <Fact
            label={t('admin.backups_version')}
            value={backup.game_version ? `v${backup.game_version}` : t('admin.backups_version_unknown')}
          />
          <Fact
            label={t('admin.backups_branch')}
            value={backup.steam_branch ?? t('admin.backups_version_unknown')}
          />
        </dl>
        {backup.notes ? <p className="mt-4 text-sm text-smoke">{backup.notes}</p> : null}
        {backup.missing ? <p className="mt-4 text-sm text-blood">{t('admin.backups_missing_hint')}</p> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <a href={`/api/v1/admin/backups/${backup.id}/download`} download={backup.filename}>
            <Button size="sm" variant="outline" disabled={backup.missing}>
              <Download aria-hidden="true" className="size-3.5" />
              {t('admin.backups_download')}
            </Button>
          </a>
          <Button size="sm" variant="outline" disabled={busy || backup.missing} onClick={onRollback}>
            <RotateCcw aria-hidden="true" className="size-3.5" />
            {t('admin.backups_rollback')}
          </Button>
          <Button size="sm" variant="outline" className="border-blood text-blood" onClick={onDelete}>
            <Trash2 aria-hidden="true" className="size-3.5" />
            {t('common.delete')}
          </Button>
        </div>
      </div>
      {backup.missing ? null : <ArchiveExplorer backupId={backup.id} locale={locale} />}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">{label}</dt>
      <dd className="mt-1 font-mono text-sm text-bone">{value}</dd>
    </div>
  )
}

function folderName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

function listingAt(entries: BackupArchiveEntry[], cwd: string) {
  const prefix = cwd ? `${cwd}/` : ''
  const folders = new Map<string, { name: string; path: string; files: number; bytes: number }>()
  const files: { name: string; path: string; size: number }[] = []

  for (const entry of entries) {
    if (entry.dir) {
      continue
    }
    if (cwd && !entry.path.startsWith(prefix)) {
      continue
    }
    const rest = cwd ? entry.path.slice(prefix.length) : entry.path
    if (!rest) {
      continue
    }
    const slash = rest.indexOf('/')
    if (slash === -1) {
      files.push({ name: rest, path: entry.path, size: entry.size_bytes })
      continue
    }
    const name = rest.slice(0, slash)
    const path = cwd ? `${cwd}/${name}` : name
    const current = folders.get(name) ?? { name, path, files: 0, bytes: 0 }
    current.files += 1
    current.bytes += entry.size_bytes
    folders.set(name, current)
  }

  return {
    folders: [...folders.values()].sort((left, right) => left.name.localeCompare(right.name)),
    files: files.sort((left, right) => left.name.localeCompare(right.name)),
  }
}

function ArchiveExplorer({ backupId, locale }: { backupId: string; locale: string }) {
  const { t } = useTranslation()
  const contents = useQuery(adminBackupContentsQuery(backupId))
  const [cwd, setCwd] = useState('')
  const [find, setFind] = useState('')
  const [openFiles, setOpenFiles] = useState<OpenBackupFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)

  useEffect(() => {
    setCwd('')
    setFind('')
    setOpenFiles([])
    setActivePath(null)
  }, [backupId])

  function openFile(path: string, name: string) {
    if (!isTextBackupFile(name)) {
      return
    }
    setOpenFiles((current) =>
      current.some((file) => file.path === path) ? current : [...current, { path, name }],
    )
    setActivePath(path)
  }

  function closeTab(path: string) {
    setOpenFiles((current) => {
      const next = current.filter((file) => file.path !== path)
      setActivePath((active) => {
        if (active !== path) {
          return active
        }
        return next.at(-1)?.path ?? null
      })
      return next
    })
  }

  const entries = contents.data?.entries ?? []
  const crumbs = cwd ? cwd.split('/') : []
  const searching = find.trim().length > 0

  const rows = useMemo(() => {
    if (searching) {
      const needle = find.trim().toLowerCase()
      return entries
        .filter((entry) => !entry.dir && folderName(entry.path).toLowerCase().includes(needle))
        .slice(0, 200)
        .map((entry) => ({
          kind: 'file' as const,
          name: folderName(entry.path),
          path: entry.path,
          hint: parentPath(entry.path) || t('admin.backups_contents_root'),
          size: entry.size_bytes,
        }))
    }
    const { folders, files } = listingAt(entries, cwd)
    return [
      ...folders.map((folder) => ({
        kind: 'folder' as const,
        name: folder.name,
        path: folder.path,
        hint: t('admin.backups_contents_file_count', { count: folder.files }),
        size: folder.bytes,
      })),
      ...files.map((file) => ({
        kind: 'file' as const,
        name: file.name,
        path: file.path,
        hint: null as string | null,
        size: file.size,
      })),
    ]
  }, [cwd, entries, find, searching, t])

  return (
    <div className="flex min-h-[16rem] min-h-0 flex-1 flex-col">
      <PanelHeader
        label={t('admin.backups_contents')}
        action={
          contents.data ? (
            <span className="font-mono text-[0.6875rem] text-dust">
              {t('admin.backups_contents_items', {
                folders: contents.data.dir_count,
                files: contents.data.file_count,
              })}
            </span>
          ) : null
        }
      />
      <div className="flex shrink-0 flex-col gap-2 border-b border-fence px-3 py-2">
        <nav aria-label={t('admin.backups_contents')} className="flex min-w-0 flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setCwd('')}
            className={cn(
              'font-mono text-[0.6875rem] tracking-widest uppercase',
              cwd ? 'text-dust hover:text-bone' : 'text-hazard',
            )}
          >
            {t('admin.backups_contents_root')}
          </button>
          {crumbs.map((crumb, index) => {
            const path = crumbs.slice(0, index + 1).join('/')
            return (
              <span key={path} className="flex items-center gap-1">
                <ChevronRight aria-hidden="true" className="size-3 text-dust" />
                <button
                  type="button"
                  onClick={() => setCwd(path)}
                  className={cn(
                    'font-mono text-[0.6875rem] tracking-widest uppercase',
                    index === crumbs.length - 1 ? 'text-hazard' : 'text-dust hover:text-bone',
                  )}
                >
                  {crumb}
                </button>
              </span>
            )
          })}
        </nav>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-dust"
          />
          <input
            type="search"
            value={find}
            onChange={(event) => setFind(event.target.value)}
            placeholder={t('admin.backups_contents_search')}
            aria-label={t('admin.backups_contents_search')}
            className="h-8 w-full border border-fence-bright bg-void pr-8 pl-8 font-mono text-xs text-bone placeholder:text-dust focus:border-hazard"
            autoComplete="off"
            spellCheck={false}
          />
          {find ? (
            <button
              type="button"
              onClick={() => setFind('')}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 p-1 text-dust hover:text-bone"
            >
              <X aria-hidden="true" className="size-3" />
              <span className="sr-only">{t('admin.logs_search_clear')}</span>
            </button>
          ) : null}
        </div>
      </div>
      {contents.isPending ? (
        <Skeleton className="m-3 min-h-0 flex-1" />
      ) : contents.isError ? (
        <div className="p-4">
          <FormError>{t('common.error')}</FormError>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void contents.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="p-4 text-sm text-dust">
          {searching ? t('admin.backups_contents_none') : t('admin.backups_contents_empty')}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
          {!searching && cwd ? (
            <li>
              <button
                type="button"
                onClick={() => setCwd(parentPath(cwd))}
                className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-ash-raised"
              >
                <Folder aria-hidden="true" className="size-4 shrink-0 text-dust" />
                <span className="font-mono text-sm text-dust">..</span>
                <span className="sr-only">{t('admin.backups_contents_up')}</span>
              </button>
            </li>
          ) : null}
          {rows.map((row) => (
            <li key={`${row.kind}:${row.path}`}>
              {row.kind === 'folder' ? (
                <button
                  type="button"
                  onClick={() => setCwd(row.path)}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-ash-raised"
                >
                  <Folder aria-hidden="true" className="size-4 shrink-0 text-hazard" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-sm text-bone">{row.name}</span>
                    {row.hint ? (
                      <span className="block font-mono text-[0.6875rem] text-dust">{row.hint}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 font-mono text-[0.6875rem] text-dust">
                    {formatBytes(row.size, locale)}
                  </span>
                  <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-dust" />
                </button>
              ) : (
                isTextBackupFile(row.name) ? (
                  <button
                    type="button"
                    onClick={() => openFile(row.path, row.name)}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-ash-raised"
                  >
                    <FileText aria-hidden="true" className="size-4 shrink-0 text-moss" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-sm text-bone">{row.name}</span>
                      {row.hint ? (
                        <span className="block truncate font-mono text-[0.6875rem] text-dust">{row.hint}</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 font-mono text-[0.6875rem] text-dust">
                      {formatBytes(row.size, locale)}
                    </span>
                  </button>
                ) : (
                  <div
                    className="flex items-center gap-3 px-4 py-2"
                    title={t('admin.backups_editor_binary')}
                  >
                    <File aria-hidden="true" className="size-4 shrink-0 text-dust" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-sm text-bone">{row.name}</span>
                      {row.hint ? (
                        <span className="block truncate font-mono text-[0.6875rem] text-dust">{row.hint}</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 font-mono text-[0.6875rem] text-dust">
                      {formatBytes(row.size, locale)}
                    </span>
                  </div>
                )
              )}
            </li>
          ))}
        </ul>
      )}
      <BackupEditorDialog
        backupId={backupId}
        files={openFiles}
        activePath={activePath}
        locale={locale}
        onSelect={setActivePath}
        onCloseTab={closeTab}
        onClose={() => {
          setOpenFiles([])
          setActivePath(null)
        }}
      />
    </div>
  )
}

function SchedulePane({
  schedule,
  busy,
  onSave,
}: {
  schedule: BackupSchedule
  busy: boolean
  onSave: (patch: Partial<BackupSchedule>) => void
}) {
  const { t } = useTranslation()
  const [hourly, setHourly] = useState(schedule.hourly_enabled)
  const [daily, setDaily] = useState(schedule.daily_enabled)
  const [time, setTime] = useState(schedule.daily_time.slice(0, 5))
  const [retention, setRetention] = useState({
    retention_manual: schedule.retention_manual,
    retention_scheduled: schedule.retention_scheduled,
    retention_daily: schedule.retention_daily,
    retention_pre_rollback: schedule.retention_pre_rollback,
    retention_pre_update: schedule.retention_pre_update,
    retention_pre_import: schedule.retention_pre_import,
  })

  return (
    <>
      <PanelHeader label={t('admin.backups_schedule')} />
      <form
        className="flex flex-col gap-5 p-5"
        onSubmit={(event) => {
          event.preventDefault()
          onSave({
            hourly_enabled: hourly,
            daily_enabled: daily,
            daily_time: time,
            ...retention,
          })
        }}
      >
        <p className="text-sm text-smoke">{t('admin.backups_schedule_hint')}</p>
        <label className="flex items-center gap-2 text-sm text-bone">
          <input type="checkbox" checked={hourly} onChange={(event) => setHourly(event.target.checked)} />
          {t('admin.backups_periodic')}
        </label>
        <label className="flex items-center gap-2 text-sm text-bone">
          <input type="checkbox" checked={daily} onChange={(event) => setDaily(event.target.checked)} />
          {t('admin.backups_daily')}
        </label>
        <Field
          label={t('admin.backups_daily_time')}
          type="time"
          value={time}
          onChange={(event) => setTime(event.target.value)}
          disabled={!daily}
        />
        <fieldset className="flex flex-col gap-3">
          <legend className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
            {t('admin.backups_retention')}
          </legend>
          <p className="text-xs text-dust">{t('admin.backups_keep_hint')}</p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {RETENTION.map((item) => (
              <Field
                key={item.key}
                label={t(item.label)}
                type="number"
                min={1}
                max={200}
                value={retention[item.key]}
                onChange={(event) =>
                  setRetention((currentRetention) => ({
                    ...currentRetention,
                    [item.key]: Number(event.target.value),
                  }))
                }
              />
            ))}
          </div>
        </fieldset>
        <Button type="submit" size="sm" disabled={busy}>
          {t('common.save')}
        </Button>
      </form>
    </>
  )
}

function CreateDialog({
  open,
  notes,
  notify,
  message,
  busy,
  onNotes,
  onNotify,
  onMessage,
  onClose,
  onConfirm,
}: {
  open: boolean
  notes: string
  notify: boolean
  message: string
  busy: boolean
  onNotes: (value: string) => void
  onNotify: (value: boolean) => void
  onMessage: (value: string) => void
  onClose: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()

  return (
    <ConfirmDialog
      open={open}
      size="lg"
      title={t('admin.backups_create_title')}
      description={
        <div className="flex flex-col gap-3">
          <p>{t('admin.backups_create_body')}</p>
          <TextAreaField
            label={t('admin.backups_notes')}
            value={notes}
            onChange={(event) => onNotes(event.target.value)}
            maxLength={500}
            className="min-h-20"
          />
          <label className="flex items-center gap-2 text-sm text-bone">
            <input type="checkbox" checked={notify} onChange={(event) => onNotify(event.target.checked)} />
            {t('admin.backups_notify')}
          </label>
          {notify ? (
            <Field
              label={t('admin.backups_notify_message')}
              value={message}
              onChange={(event) => onMessage(event.target.value)}
              maxLength={200}
            />
          ) : null}
        </div>
      }
      confirmLabel={t('admin.backups_create')}
      busy={busy}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  )
}

function RollbackDialog({
  backup,
  countdown,
  warning,
  busy,
  onCountdown,
  onWarning,
  onClose,
  onConfirm,
}: {
  backup: BackupRecord | null
  countdown: (typeof COUNTDOWNS)[number]
  warning: string
  busy: boolean
  onCountdown: (value: (typeof COUNTDOWNS)[number]) => void
  onWarning: (value: string) => void
  onClose: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()

  return (
    <ConfirmDialog
      open={backup !== null}
      size="lg"
      title={t('admin.backups_rollback_title')}
      description={
        <div className="flex flex-col gap-3">
          <p>{t('admin.backups_rollback_body', { filename: backup?.filename ?? '' })}</p>
          <fieldset>
            <legend className="mb-2 font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
              {t('admin.backups_countdown')}
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {COUNTDOWNS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => onCountdown(item)}
                  className={cn(
                    'border px-2 py-1 font-mono text-[0.6875rem]',
                    countdown === item
                      ? 'border-hazard bg-hazard-soft text-hazard'
                      : 'border-fence text-dust hover:border-fence-bright hover:text-bone',
                  )}
                >
                  {item === 0
                    ? t('admin.backups_now')
                    : t('admin.backups_minutes', { count: item / 60 })}
                </button>
              ))}
            </div>
          </fieldset>
          {countdown > 0 ? (
            <Field
              label={t('admin.backups_warning')}
              value={warning}
              onChange={(event) => onWarning(event.target.value)}
            />
          ) : null}
        </div>
      }
      confirmLabel={countdown === 0 ? t('admin.backups_rollback_now') : t('admin.backups_rollback_later')}
      tone="danger"
      busy={busy}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  )
}

function ImportDialog({
  open,
  file,
  confirmed,
  busy,
  locale,
  fileRef,
  onFile,
  onConfirmChange,
  onClose,
  onSubmit,
}: {
  open: boolean
  file: File | null
  confirmed: boolean
  busy: boolean
  locale: string
  fileRef: React.RefObject<HTMLInputElement | null>
  onFile: (file: File | null) => void
  onConfirmChange: (value: boolean) => void
  onClose: () => void
  onSubmit: () => void
}) {
  const { t } = useTranslation()

  return (
    <ConfirmDialog
      open={open}
      size="lg"
      title={t('admin.backups_import_title')}
      description={
        <div className="flex flex-col gap-3">
          <p>{t('admin.backups_import_body')}</p>
          <div>
            <p className="mb-2 font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
              {t('admin.backups_import_file')}
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".zip"
              onChange={(event) => onFile(event.target.files?.[0] ?? null)}
              className="block w-full font-mono text-xs text-dust file:mr-3 file:border file:border-fence file:bg-void file:px-2 file:py-1 file:font-mono file:text-xs file:tracking-widest file:text-bone file:uppercase"
            />
            {file ? (
              <p className="mt-2 font-mono text-xs text-dust">
                {file.name} · {formatBytes(file.size, locale)}
              </p>
            ) : null}
          </div>
          <div className="border border-fence bg-void px-3 py-2 text-xs leading-relaxed text-dust">
            <p>{t('admin.backups_import_help_full')}</p>
            <p className="mt-1">{t('admin.backups_import_help_world')}</p>
            <p className="mt-1">{t('admin.backups_import_help_flat')}</p>
          </div>
          <label className="flex items-center gap-2 text-sm text-bone">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => onConfirmChange(event.target.checked)}
            />
            {t('admin.backups_import_confirm')}
          </label>
        </div>
      }
      confirmLabel={t('admin.backups_import')}
      tone="danger"
      busy={busy}
      confirmDisabled={!file || !confirmed}
      onConfirm={onSubmit}
      onClose={onClose}
    />
  )
}
