import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  RotateCcw,
  Search,
  Shield,
} from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError, TextAreaField } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, type ModEntry, type WorkshopLookup } from '@/lib/api'
import { cn } from '@/lib/cn'
import { fuzzyMatch } from '@/lib/fuzzy'
import { parseModImport } from '@/lib/parse-mod-import'
import { adminModsQuery, serverStatusQuery } from '@/lib/queries'
import { useCopy } from '@/lib/use-copy'
import { useTranslation, type TranslationContextValue } from '@/i18n/use-translation'

type LookupState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; details: WorkshopLookup }
  | { status: 'missing' }
  | { status: 'error'; message: string }

/**
 * WorkshopItems= and Mods= as a load list you can search, reorder and grow.
 *
 * The two ini lines stay independent in the file — PZ loads them that way —
 * but the page still shows them as rows so an operator can see the order
 * the dedicated server will try first.
 */
export function AdminModsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isPending, isError, refetch } = useQuery(adminModsQuery)
  const status = useQuery(serverStatusQuery)
  const { copied, copy } = useCopy()

  const [query, setQuery] = useState('')
  const [workshopId, setWorkshopId] = useState('')
  const [modId, setModId] = useState('')
  const [mapFolder, setMapFolder] = useState('')
  const [lookup, setLookup] = useState<LookupState>({ status: 'idle' })
  const [importText, setImportText] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [removing, setRemoving] = useState<ModEntry | null>(null)
  const [updating, setUpdating] = useState<ModEntry | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingDeps, setPendingDeps] = useState<WorkshopLookup[] | null>(null)

  const mods = data ?? []
  const searching = query.trim().length > 0

  const visible = useMemo(() => {
    const source = data ?? []
    if (!searching) {
      return source.map((entry, index) => ({ entry, index }))
    }
    return source
      .map((entry, index) => {
        const haystack = `${entry.mod_id} ${entry.workshop_id} ${entry.installed_version ?? ''}`
        const hit = fuzzyMatch(query, haystack)
        return hit ? { entry, index, score: hit.score } : null
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((left, right) => right.score - left.score || left.index - right.index)
  }, [data, query, searching])

  useEffect(() => {
    const trimmed = workshopId.trim()
    if (trimmed === '') {
      setLookup({ status: 'idle' })
      return
    }

    let cancelled = false
    const handle = window.setTimeout(() => {
      setLookup({ status: 'loading' })
      void api
        .adminLookupMod(trimmed)
        .then((details) => {
          if (cancelled) {
            return
          }
          if (!details.found) {
            setLookup({ status: 'missing' })
            return
          }
          setLookup({ status: 'ready', details })
          setModId((current) => current || details.mod_ids[0] || current)
          setMapFolder((current) => current || details.map_folders[0] || current)
        })
        .catch((cause) => {
          if (cancelled) {
            return
          }
          setLookup({
            status: 'error',
            message: cause instanceof ApiError ? cause.message : 'lookup failed',
          })
        })
    }, 400)

    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [workshopId])

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'mods'] })
    await queryClient.invalidateQueries({ queryKey: ['admin', 'config'] })
  }

  const finishAdd = async () => {
    setWorkshopId('')
    setModId('')
    setMapFolder('')
    setLookup({ status: 'idle' })
    setPendingDeps(null)
    setNotice(t('admin.mods_added'))
    await invalidate()
  }

  const add = useMutation({
    mutationFn: () => api.adminAddMod(workshopId.trim(), modId.trim(), mapFolder.trim() || undefined),
    onSuccess: finishAdd,
  })

  const addWithDeps = useMutation({
    mutationFn: async (missing: WorkshopLookup[]) => {
      await api.adminImportMods({
        workshop_ids: missing.map((entry) => entry.workshop_id),
        mod_ids: missing.flatMap((entry) => entry.mod_ids),
        map_folders: missing.flatMap((entry) => entry.map_folders),
      })
      return api.adminAddMod(workshopId.trim(), modId.trim(), mapFolder.trim() || undefined)
    },
    onSuccess: finishAdd,
  })

  const checkDeps = useMutation({
    mutationFn: () => api.adminModDependencies(workshopId.trim()),
    onSuccess: (missing) => {
      if (missing.length === 0) {
        add.mutate()
        return
      }
      setPendingDeps(missing)
    },
  })

  const remove = useMutation({
    mutationFn: (entry: ModEntry) => api.adminRemoveMod(entry.workshop_id || entry.mod_id),
    onSuccess: async () => {
      setRemoving(null)
      setNotice(t('admin.mods_removed'))
      await invalidate()
    },
    onError: () => setRemoving(null),
  })

  const reorder = useMutation({
    mutationFn: (next: ModEntry[]) => api.adminReorderMods(next),
    onSuccess: async () => {
      setNotice(t('admin.mods_reordered'))
      await invalidate()
    },
  })

  const updateMod = useMutation({
    mutationFn: (entry: ModEntry) => api.adminUpdateMod(entry.workshop_id),
    onSuccess: async () => {
      setUpdating(null)
      setNotice(t('admin.mods_updated'))
      await invalidate()
    },
    onError: () => setUpdating(null),
  })

  const imported = useMutation({
    mutationFn: async () => {
      const parsed = parseModImport(importText)
      let workshopIds = parsed.workshopIds
      let modIds = parsed.modIds
      const mapFolders = [...parsed.mapFolders]

      if (parsed.mode === 'ids') {
        modIds = []
        for (const id of parsed.workshopIds) {
          const details = await api.adminLookupMod(id)
          if (details.found) {
            modIds.push(...details.mod_ids)
            mapFolders.push(...details.map_folders)
          }
        }
        workshopIds = parsed.workshopIds
      }

      return api.adminImportMods({
        workshop_ids: workshopIds,
        mod_ids: modIds,
        map_folders: mapFolders,
      })
    },
    onSuccess: async () => {
      setImportText('')
      setImportOpen(false)
      setNotice(t('admin.mods_imported'))
      await invalidate()
    },
  })

  const restart = useMutation({
    mutationFn: () => api.adminRestart(),
    onSuccess: () => {
      setRestarting(false)
      setNotice(t('admin.mods_restarted'))
      void queryClient.invalidateQueries({ queryKey: ['server'] })
    },
    onError: () => setRestarting(false),
  })

  function move(index: number, delta: number) {
    const next = [...mods]
    const target = index + delta
    if (target < 0 || target >= next.length) {
      return
    }
    const [row] = next.splice(index, 1)
    if (!row) {
      return
    }
    next.splice(target, 0, row)
    reorder.mutate(next)
  }

  const adding = add.isPending || addWithDeps.isPending || checkDeps.isPending

  const error =
    [
      add.error,
      addWithDeps.error,
      checkDeps.error,
      remove.error,
      reorder.error,
      updateMod.error,
      imported.error,
      restart.error,
    ].find(Boolean) instanceof ApiError
      ? ([
          add.error,
          addWithDeps.error,
          checkDeps.error,
          remove.error,
          reorder.error,
          updateMod.error,
          imported.error,
          restart.error,
        ].find(Boolean) as ApiError).message
      : [
            add.error,
            addWithDeps.error,
            checkDeps.error,
            remove.error,
            reorder.error,
            updateMod.error,
            imported.error,
            restart.error,
          ].find(Boolean)
        ? t('auth.unexpected_error')
        : null

  const parsedImport = importText.trim() ? parseModImport(importText) : null

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.server')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('admin.mods_title')}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-mono text-[0.6875rem] text-dust">
            {t('admin.mods_count', { count: mods.length })}
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
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <Panel bracketed className="flex min-h-0 flex-col">
            <div className="flex shrink-0 flex-col gap-3 border-b border-fence px-3 py-3 sm:flex-row sm:items-center">
              <PanelHeader label={t('admin.mods_loaded')} className="border-0 p-0" />
              <div className="relative min-w-0 flex-1">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-dust"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('admin.mods_search')}
                  autoComplete="off"
                  className="h-10 w-full border border-fence-bright bg-void pr-3 pl-10 font-mono text-sm text-bone placeholder:text-dust focus:border-hazard"
                />
              </div>
            </div>

            {visible.length === 0 ? (
              <p className="p-5 text-sm text-dust">
                {mods.length === 0 ? t('admin.mods_empty') : t('common.none_found')}
              </p>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full min-w-[44rem] text-left text-sm">
                  <caption className="sr-only">{t('admin.mods_loaded')}</caption>
                  <thead className="sticky top-0 bg-ash font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
                    <tr className="border-b border-fence">
                      <th scope="col" className="w-12 px-3 py-2">
                        #
                      </th>
                      <th scope="col" className="px-3 py-2">
                        {t('admin.mods_mod_id')}
                      </th>
                      <th scope="col" className="px-3 py-2">
                        {t('admin.mods_workshop_id')}
                      </th>
                      <th scope="col" className="px-3 py-2">
                        {t('admin.mods_version')}
                      </th>
                      <th scope="col" className="px-3 py-2 text-right">
                        {t('common.actions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-fence">
                    {visible.map(({ entry, index }) => (
                      <tr key={`${entry.workshop_id}-${entry.mod_id}-${index}`}>
                        <td className="px-3 py-3 font-mono text-dust tabular-nums">{index + 1}</td>
                        <td className="px-3 py-3">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-bone">{entry.mod_id || '—'}</span>
                            {entry.protected ? (
                              <span className="inline-flex items-center gap-1 font-mono text-[0.625rem] tracking-widest text-dust uppercase">
                                <Shield aria-hidden="true" className="size-3" />
                                {t('admin.mods_protected')}
                              </span>
                            ) : null}
                            {!entry.mod_id || !entry.workshop_id ? (
                              <span className="font-mono text-[0.625rem] tracking-widest text-hazard uppercase">
                                {t('admin.mods_unpaired')}
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          {entry.workshop_id ? (
                            <span className="flex items-center gap-2 font-mono text-xs text-smoke">
                              <a
                                href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${entry.workshop_id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:text-hazard"
                              >
                                {entry.workshop_id}
                                <ExternalLink
                                  aria-hidden="true"
                                  className="ml-1 inline size-3 align-text-top"
                                />
                                <span className="sr-only">{t('admin.mods_open_workshop')}</span>
                              </a>
                              <button
                                type="button"
                                onClick={() => void copy(entry.workshop_id)}
                                className="text-dust hover:text-bone"
                              >
                                <Copy aria-hidden="true" className="size-3.5" />
                                <span className="sr-only">
                                  {copied ? t('status.copied') : t('status.copy')}
                                </span>
                              </button>
                            </span>
                          ) : (
                            <span className="text-dust">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <span className="flex flex-col gap-0.5">
                            <span className="font-mono text-xs text-smoke">
                              {modVersionLabel(entry, t)}
                            </span>
                            {entry.update_available ? (
                              <span className="font-mono text-[0.625rem] tracking-widest text-hazard uppercase">
                                {t('admin.mods_update_available')}
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={searching || index === 0 || reorder.isPending}
                              onClick={() => move(index, -1)}
                            >
                              <ArrowUp aria-hidden="true" className="size-3.5" />
                              <span className="sr-only">{t('admin.mods_move_up')}</span>
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={searching || index === mods.length - 1 || reorder.isPending}
                              onClick={() => move(index, 1)}
                            >
                              <ArrowDown aria-hidden="true" className="size-3.5" />
                              <span className="sr-only">{t('admin.mods_move_down')}</span>
                            </Button>
                            {entry.workshop_id && entry.update_available ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={updateMod.isPending}
                                onClick={() => {
                                  setNotice(null)
                                  setUpdating(entry)
                                }}
                              >
                                <Download aria-hidden="true" className="size-3.5" />
                                {entry.cached
                                  ? t('admin.mods_update')
                                  : t('admin.mods_download')}
                              </Button>
                            ) : null}
                            {entry.protected ? null : (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-blood hover:text-blood"
                                onClick={() => {
                                  setNotice(null)
                                  setRemoving(entry)
                                }}
                              >
                                {t('admin.mods_remove')}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="shrink-0 border-t border-fence px-4 py-3 text-xs text-dust">
              {searching ? t('admin.mods_reorder_disabled') : t('admin.mods_restart_hint')}
            </p>
          </Panel>

          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
            <Panel bracketed className="shrink-0">
              <PanelHeader label={t('admin.mods_add')} />
              <form
                className="flex flex-col gap-4 p-5"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault()
                  setNotice(null)
                  checkDeps.mutate()
                }}
              >
                <Field
                  label={t('admin.mods_workshop_id')}
                  value={workshopId}
                  onChange={(event) => setWorkshopId(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  hint={t('admin.mods_workshop_hint')}
                />

                <LookupPreview state={lookup} onPick={setModId} selected={modId} />

                <Field
                  label={t('admin.mods_mod_id')}
                  value={modId}
                  onChange={(event) => setModId(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                {lookup.status === 'ready' && lookup.details.map_folders.length > 0 ? (
                  <Field
                    label={t('admin.mods_map_folder')}
                    value={mapFolder}
                    onChange={(event) => setMapFolder(event.target.value)}
                    autoComplete="off"
                    hint={t('admin.mods_map_hint')}
                  />
                ) : null}
                <Button
                  type="submit"
                  size="sm"
                  disabled={!workshopId.trim() || !modId.trim() || adding}
                >
                  {checkDeps.isPending ? t('admin.mods_deps_checking') : t('admin.mods_add')}
                </Button>
              </form>
            </Panel>

            <Panel bracketed className="shrink-0">
              <button
                type="button"
                className="flex w-full items-center justify-between px-4 py-2.5 text-left"
                onClick={() => setImportOpen((open) => !open)}
                aria-expanded={importOpen}
              >
                <span className="eyebrow">{t('admin.mods_import')}</span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn('size-4 text-dust transition-transform', importOpen && 'rotate-180')}
                />
              </button>
              {importOpen ? (
                <form
                  className="flex flex-col gap-4 border-t border-fence p-5"
                  onSubmit={(event) => {
                    event.preventDefault()
                    setNotice(null)
                    imported.mutate()
                  }}
                >
                  <TextAreaField
                    label={t('admin.mods_import_paste')}
                    value={importText}
                    onChange={(event) => setImportText(event.target.value)}
                    hint={t('admin.mods_import_hint')}
                    className="min-h-36"
                  />
                  {parsedImport ? (
                    <p className="font-mono text-[0.6875rem] text-dust">
                      {t('admin.mods_import_preview', {
                        workshop: parsedImport.workshopIds.length,
                        mods: parsedImport.modIds.length,
                      })}
                    </p>
                  ) : null}
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!importText.trim() || imported.isPending}
                  >
                    {imported.isPending ? t('common.saving') : t('admin.mods_import_apply')}
                  </Button>
                </form>
              ) : null}
            </Panel>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingDeps !== null}
        title={t('admin.mods_deps_title')}
        size="lg"
        confirmLabel={t('admin.mods_deps_yes')}
        cancelLabel={t('admin.mods_deps_no')}
        busy={addWithDeps.isPending || add.isPending}
        description={
          <div className="flex flex-col gap-3">
            <p>{t('admin.mods_deps_description')}</p>
            <ul className="flex flex-col gap-2 border border-fence bg-void px-3 py-2">
              {(pendingDeps ?? []).map((entry) => (
                <li key={entry.workshop_id} className="text-sm">
                  <span className="text-bone">
                    {entry.title.trim() || t('admin.mods_lookup_untitled')}
                  </span>
                  <span className="mt-0.5 block font-mono text-[0.6875rem] text-dust">
                    {entry.workshop_id}
                    {entry.mod_ids.length > 0 ? ` · ${entry.mod_ids.join(', ')}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        }
        onConfirm={() => pendingDeps && addWithDeps.mutate(pendingDeps)}
        onClose={() => {
          if (addWithDeps.isPending || add.isPending) {
            return
          }
          const skip = pendingDeps
          setPendingDeps(null)
          if (skip) {
            add.mutate()
          }
        }}
      />

      <ConfirmDialog
        open={updating !== null}
        title={
          updating?.cached ? t('admin.mods_update') : t('admin.mods_download')
        }
        description={t('admin.mods_update_confirm', {
          name: updating?.mod_id || updating?.workshop_id || '',
        })}
        confirmLabel={
          updateMod.isPending
            ? t('admin.mods_updating')
            : updating?.cached
              ? t('admin.mods_update')
              : t('admin.mods_download')
        }
        busy={updateMod.isPending}
        onConfirm={() => updating && updateMod.mutate(updating)}
        onClose={() => {
          if (!updateMod.isPending) {
            setUpdating(null)
          }
        }}
      />

      <ConfirmDialog
        open={removing !== null}
        title={t('admin.mods_remove')}
        description={t('admin.mods_remove_confirm', {
          name: removing?.mod_id || removing?.workshop_id || '',
        })}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
        onClose={() => {
          if (!remove.isPending) {
            setRemoving(null)
          }
        }}
      />

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

/// Anything with a digit except a calendar date. Steam install days are not
/// versions; `1.35`, `42-1.4.3` and `1.3.14.0-B42UNSTABLE` are.
function isModVersion(value: string): boolean {
  const core = value.trim()
  if (!core || !/\d/.test(core)) {
    return false
  }
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(core)) {
    return false
  }
  if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(core)) {
    return false
  }
  return true
}

function modVersionLabel(entry: ModEntry, t: TranslationContextValue['t']): string {
  const version = entry.installed_version?.trim()
  if (version && isModVersion(version)) {
    return version
  }
  if (entry.update_available && !entry.cached) {
    return t('admin.mods_not_cached')
  }
  return '—'
}

function LookupPreview({
  state,
  onPick,
  selected,
}: {
  state: LookupState
  onPick: (id: string) => void
  selected: string
}) {
  const { t } = useTranslation()

  if (state.status === 'idle') {
    return null
  }
  if (state.status === 'loading') {
    return <p className="text-xs text-dust">{t('admin.mods_lookup_loading')}</p>
  }
  if (state.status === 'missing') {
    return <p className="text-xs text-hazard">{t('admin.mods_lookup_missing')}</p>
  }
  if (state.status === 'error') {
    return <p className="text-xs text-blood">{state.message}</p>
  }

  return (
    <div className="border border-fence bg-void p-3">
      <p className="text-sm text-bone">{state.details.title || t('admin.mods_lookup_untitled')}</p>
      {state.details.mod_ids.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t('admin.mods_suggested')}>
          {state.details.mod_ids.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onPick(id)}
              aria-pressed={selected === id}
              className={cn(
                'border px-2 py-1 font-mono text-[0.6875rem]',
                selected === id
                  ? 'border-hazard bg-hazard-soft text-hazard'
                  : 'border-fence text-smoke hover:border-fence-bright hover:text-bone',
              )}
            >
              {id}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-dust">{t('admin.mods_lookup_no_ids')}</p>
      )}
    </div>
  )
}
