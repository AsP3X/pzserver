import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Plus, RotateCcw, Trash2, Upload } from 'lucide-react'
import { useMemo, useState, type ChangeEvent } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError, TextAreaField } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { TabStrip } from '@/components/ui/tabs'
import {
  TRANSLATION_KEYS,
  dictionaryFor,
  fallback,
  groupOf,
  isBuiltin,
  type TranslationKey,
} from '@/i18n/locales'
import { useTranslation } from '@/i18n/use-translation'
import { api, ApiError, type UiLanguage } from '@/lib/api'
import { cn } from '@/lib/cn'
import { adminLanguagesQuery, adminTranslationsQuery } from '@/lib/queries'

type Filter = 'all' | 'missing' | 'overridden'

const FILTERS: { id: Filter; label: TranslationKey }[] = [
  { id: 'all', label: 'translations.filter_all' },
  { id: 'missing', label: 'translations.filter_missing' },
  { id: 'overridden', label: 'translations.filter_overridden' },
]

interface NewLanguage {
  code: string
  name: string
  native_name: string
}

const EMPTY_LANGUAGE: NewLanguage = { code: '', name: '', native_name: '' }

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function fileValue(locale: string, key: string): string | undefined {
  if (locale === 'en') {
    return fallback[key as TranslationKey]
  }
  return dictionaryFor(locale)[key as TranslationKey]
}

export function AdminTranslationsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const languages = useQuery(adminLanguagesQuery)
  const catalog = useQuery(adminTranslationsQuery)

  const [locale, setLocale] = useState('en')
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState('all')
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newLanguage, setNewLanguage] = useState<NewLanguage>(EMPTY_LANGUAGE)
  const [removeLanguage, setRemoveLanguage] = useState<UiLanguage | null>(null)
  const [importing, setImporting] = useState(false)
  const [importText, setImportText] = useState('')

  const rows = languages.data ?? []
  const activeLocale = rows.some((item) => item.code === locale) ? locale : (rows[0]?.code ?? 'en')
  const overrides = catalog.data?.overrides[activeLocale] ?? {}
  const currentLanguage = rows.find((item) => item.code === activeLocale) ?? null

  const keys = useMemo(() => {
    const extra = Object.keys(overrides).filter((key) => !TRANSLATION_KEYS.includes(key as TranslationKey))
    return [...TRANSLATION_KEYS, ...extra]
  }, [overrides])

  const groups = useMemo(() => {
    const set = new Set(keys.map(groupOf))
    return [...set].sort()
  }, [keys])

  const entries = useMemo(() => {
    const query = search.trim().toLowerCase()
    return keys
      .map((key) => {
        const source = fallback[key as TranslationKey] ?? ''
        const file = fileValue(activeLocale, key)
        const override = overrides[key]
        const effective = override ?? file ?? ''
        const missing = effective.trim() === '' || (activeLocale !== 'en' && !file && !override)
        const overridden = override !== undefined
        return { key, source, file, override, effective, missing, overridden }
      })
      .filter((entry) => {
        if (group !== 'all' && groupOf(entry.key) !== group) return false
        if (filter === 'missing' && !entry.missing) return false
        if (filter === 'overridden' && !entry.overridden) return false
        if (!query) return true
        return (
          entry.key.toLowerCase().includes(query) ||
          entry.source.toLowerCase().includes(query) ||
          entry.effective.toLowerCase().includes(query)
        )
      })
  }, [keys, overrides, activeLocale, group, filter, search])

  const current = entries.find((entry) => entry.key === selected) ?? null
  const coverage = keys.filter((key) => {
    const value = overrides[key] ?? fileValue(activeLocale, key) ?? ''
    return value.trim() !== ''
  }).length

  function fail(cause: unknown) {
    setNotice(null)
    setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
  }

  async function refreshAll() {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'translations'] })
    await queryClient.invalidateQueries({ queryKey: ['admin', 'languages'] })
    await queryClient.invalidateQueries({ queryKey: ['i18n'] })
  }

  function pick(key: string) {
    const entry = entries.find((item) => item.key === key)
    setSelected(key)
    setDraft(entry?.override ?? entry?.file ?? entry?.source ?? '')
    setError(null)
    setNotice(null)
  }

  const saved = useMutation({
    mutationFn: () => {
      if (!current) throw new Error('missing key')
      return api.adminPutTranslation(activeLocale, current.key, draft)
    },
    onSuccess: async () => {
      setNotice(t('translations.saved'))
      setError(null)
      await refreshAll()
    },
    onError: fail,
  })

  const cleared = useMutation({
    mutationFn: () => {
      if (!current) throw new Error('missing key')
      return api.adminClearTranslation(activeLocale, current.key)
    },
    onSuccess: async () => {
      const next = current ? (current.file ?? current.source) : ''
      setDraft(next)
      setNotice(t('translations.reverted'))
      setError(null)
      await refreshAll()
    },
    onError: fail,
  })

  const createdLanguage = useMutation({
    mutationFn: () => api.adminCreateLanguage(newLanguage),
    onSuccess: async (language) => {
      setAdding(false)
      setNewLanguage(EMPTY_LANGUAGE)
      setLocale(language.code)
      setNotice(t('translations.language_added'))
      setError(null)
      await refreshAll()
    },
    onError: fail,
  })

  const updatedLanguage = useMutation({
    mutationFn: (input: { code: string; patch: { is_active?: boolean; is_default?: boolean } }) =>
      api.adminUpdateLanguage(input.code, input.patch),
    onSuccess: async () => {
      setNotice(t('translations.saved'))
      setError(null)
      await refreshAll()
    },
    onError: fail,
  })

  const deletedLanguage = useMutation({
    mutationFn: (code: string) => api.adminDeleteLanguage(code),
    onSuccess: async () => {
      setRemoveLanguage(null)
      setLocale('en')
      setNotice(t('translations.language_removed'))
      setError(null)
      await refreshAll()
    },
    onError: fail,
  })

  const imported = useMutation({
    mutationFn: (entries: Record<string, string>) =>
      api.adminImportTranslations(activeLocale, entries),
    onSuccess: async (result) => {
      setImporting(false)
      setImportText('')
      setNotice(result.message)
      setError(null)
      await refreshAll()
    },
    onError: fail,
  })

  async function exportOverrides() {
    try {
      const data = await api.adminExportTranslations(activeLocale)
      downloadJson(`knox-${activeLocale}-overrides.json`, data)
    } catch (cause) {
      fail(cause)
    }
  }

  function exportCatalog() {
    const data: Record<string, string> = {}
    for (const key of TRANSLATION_KEYS) {
      const value = overrides[key] ?? fileValue(activeLocale, key) ?? fallback[key]
      if (value) data[key] = value
    }
    for (const [key, value] of Object.entries(overrides)) {
      data[key] = value
    }
    downloadJson(`knox-${activeLocale}.json`, data)
  }

  function onImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setImportText(String(reader.result ?? ''))
      setImporting(true)
    }
    reader.readAsText(file)
    event.target.value = ''
  }

  function submitImport() {
    try {
      const parsed = JSON.parse(importText) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError(t('translations.invalid_json'))
        return
      }
      const entries: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') entries[key] = value
      }
      imported.mutate(entries)
    } catch {
      setError(t('translations.invalid_json'))
    }
  }

  const placeholders = current
    ? [...current.source.matchAll(/:([a-z0-9_]+)/gi)].map((match) => match[1])
    : []

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.system')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('translations.title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('translations.description')}</p>
        </div>
        <p className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
          {t('translations.coverage', { done: coverage, total: keys.length })}
        </p>
      </header>

      {notice ? (
        <p role="status" className="border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}

      <Panel bracketed className="shrink-0">
        <PanelHeader
          label={t('translations.languages')}
          action={
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" className="size-3.5" />
              {t('translations.add_language')}
            </Button>
          }
        />
        <div className="flex flex-wrap items-center gap-2 p-3">
          {languages.isPending ? (
            <Skeleton className="h-9 w-64" />
          ) : (
            <TabStrip
              label={t('translations.languages')}
              items={rows.map((item) => ({
                id: item.code,
                label: `${item.native_name} (${item.code})`,
                count: Object.keys(catalog.data?.overrides[item.code] ?? {}).length,
              }))}
              active={activeLocale}
              onSelect={(code) => {
                setLocale(code)
                setSelected(null)
                setDraft('')
              }}
            />
          )}
        </div>
        {currentLanguage ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-fence px-3 py-2">
            <span className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
              {currentLanguage.name}
              {currentLanguage.is_default ? ` · ${t('translations.default')}` : ''}
              {` · ${currentLanguage.is_active ? t('translations.active') : t('translations.inactive')}`}
              {isBuiltin(currentLanguage.code)
                ? ` · ${t('translations.builtin')}`
                : ` · ${t('translations.custom')}`}
            </span>
            {!currentLanguage.is_default ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  updatedLanguage.mutate({ code: currentLanguage.code, patch: { is_default: true } })
                }
              >
                {t('translations.set_default')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={currentLanguage.is_default}
              onClick={() =>
                updatedLanguage.mutate({
                  code: currentLanguage.code,
                  patch: { is_active: !currentLanguage.is_active },
                })
              }
            >
              {currentLanguage.is_active ? t('common.disabled') : t('common.enabled')}
            </Button>
            {!isBuiltin(currentLanguage.code) ? (
              <Button size="sm" variant="ghost" onClick={() => setRemoveLanguage(currentLanguage)}>
                <Trash2 aria-hidden="true" className="size-3.5" />
                {t('translations.delete_language')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Panel>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1">
          <Field
            label={t('common.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('translations.search')}
          />
        </div>
        <label className="flex min-w-[10rem] flex-col gap-2">
          <span className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
            {t('translations.group')}
          </span>
          <select
            value={group}
            onChange={(event) => setGroup(event.target.value)}
            className="h-12 border border-fence-bright bg-void px-3 font-mono text-sm text-bone"
          >
            <option value="all">{t('translations.all_groups')}</option>
            {groups.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <div role="group" aria-label={t('translations.filter')} className="flex border border-fence">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setFilter(option.id)}
              className={cn(
                'px-3 py-3 font-mono text-[0.6875rem] tracking-widest uppercase',
                filter === option.id ? 'bg-fence text-bone' : 'text-dust hover:text-bone',
              )}
            >
              {t(option.label)}
            </button>
          ))}
        </div>
        <Button size="sm" variant="outline" onClick={() => setImporting(true)}>
          <Upload aria-hidden="true" className="size-3.5" />
          {t('translations.import')}
        </Button>
        <label className="inline-flex h-9 cursor-pointer items-center gap-2 border border-fence-bright px-3 font-display text-xs tracking-wider text-bone uppercase hover:border-hazard hover:text-hazard">
          <Upload aria-hidden="true" className="size-3.5" />
          {t('translations.import_file')}
          <input type="file" accept="application/json,.json" className="sr-only" onChange={onImportFile} />
        </label>
        <Button size="sm" variant="outline" onClick={() => void exportOverrides()}>
          <Download aria-hidden="true" className="size-3.5" />
          {t('translations.export')}
        </Button>
        <Button size="sm" variant="ghost" onClick={exportCatalog}>
          {t('translations.export_catalog')}
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)]">
        <Panel bracketed className="flex min-h-0 flex-col overflow-hidden">
          <PanelHeader label={`${t('translations.keys')} (${entries.length})`} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {catalog.isPending ? (
              <div className="flex flex-col gap-2 p-3">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : entries.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-dust">{t('translations.empty')}</p>
            ) : (
              <ul>
                {entries.map((entry) => (
                  <li key={entry.key}>
                    <button
                      type="button"
                      onClick={() => pick(entry.key)}
                      className={cn(
                        'flex w-full flex-col items-start gap-1 border-b border-fence px-4 py-2.5 text-left last:border-0',
                        selected === entry.key ? 'bg-ash-raised' : 'hover:bg-ash-raised/60',
                      )}
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="font-mono text-xs text-bone">{entry.key}</span>
                        <span
                          className={cn(
                            'shrink-0 font-mono text-[0.625rem] tracking-widest uppercase',
                            entry.overridden
                              ? 'text-hazard'
                              : entry.missing
                                ? 'text-blood'
                                : 'text-dust',
                          )}
                        >
                          {entry.overridden
                            ? t('translations.overridden')
                            : entry.missing
                              ? t('translations.missing')
                              : t('translations.from_file')}
                        </span>
                      </span>
                      <span className="line-clamp-1 text-xs text-smoke">
                        {entry.effective || entry.source || '—'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>

        <Panel bracketed className="flex min-h-0 flex-col overflow-hidden">
          <PanelHeader label={current?.key ?? t('translations.no_key')} />
          {current ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
              <p className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
                {t('translations.group')}: {groupOf(current.key)}
              </p>
              <div>
                <p className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
                  {t('translations.source')}
                </p>
                <p className="mt-1 border border-fence bg-void px-3 py-2 text-sm text-bone">
                  {current.source || '—'}
                </p>
              </div>
              <div>
                <p className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
                  {t('translations.file')}
                </p>
                <p className="mt-1 border border-fence bg-void px-3 py-2 text-sm text-smoke">
                  {current.file || t('translations.no_file')}
                </p>
              </div>
              <TextAreaField
                label={t('translations.override')}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                hint={
                  placeholders.length > 0
                    ? t('translations.placeholder_hint', { names: placeholders.join(', ') })
                    : undefined
                }
                rows={6}
              />
              <div>
                <p className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
                  {t('translations.preview')}
                </p>
                <p className="mt-1 border border-fence bg-void px-3 py-2 text-sm text-bone">
                  {draft || current.effective || '—'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={saved.isPending || draft.trim() === ''}
                  onClick={() => saved.mutate()}
                >
                  {saved.isPending ? t('common.saving') : t('common.save')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDraft(current.source)}
                >
                  {t('translations.use_english')}
                </Button>
                {current.overridden ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={cleared.isPending}
                    onClick={() => cleared.mutate()}
                  >
                    <RotateCcw aria-hidden="true" className="size-3.5" />
                    {t('translations.revert')}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="px-4 py-10 text-center text-sm text-dust">{t('translations.no_key')}</p>
          )}
        </Panel>
      </div>

      <ConfirmDialog
        open={adding}
        title={t('translations.add_language')}
        size="lg"
        description={
          <div className="flex flex-col gap-3">
            <Field
              label={t('translations.code')}
              value={newLanguage.code}
              onChange={(event) =>
                setNewLanguage((current) => ({ ...current, code: event.target.value.toLowerCase() }))
              }
              placeholder="fr"
              maxLength={8}
            />
            <Field
              label={t('translations.name')}
              value={newLanguage.name}
              onChange={(event) =>
                setNewLanguage((current) => ({ ...current, name: event.target.value }))
              }
              placeholder="French"
            />
            <Field
              label={t('translations.native')}
              value={newLanguage.native_name}
              onChange={(event) =>
                setNewLanguage((current) => ({ ...current, native_name: event.target.value }))
              }
              placeholder="Français"
            />
          </div>
        }
        confirmLabel={t('translations.add_language')}
        busy={createdLanguage.isPending}
        confirmDisabled={newLanguage.code.trim().length < 2 || newLanguage.name.trim() === ''}
        onConfirm={() => createdLanguage.mutate()}
        onClose={() => {
          setAdding(false)
          setNewLanguage(EMPTY_LANGUAGE)
        }}
      />

      <ConfirmDialog
        open={removeLanguage !== null}
        title={t('translations.delete_language')}
        description={t('translations.delete_language_confirm', {
          name: removeLanguage?.native_name ?? '',
        })}
        tone="danger"
        busy={deletedLanguage.isPending}
        onConfirm={() => {
          if (removeLanguage) deletedLanguage.mutate(removeLanguage.code)
        }}
        onClose={() => setRemoveLanguage(null)}
      />

      <ConfirmDialog
        open={importing}
        title={t('translations.import')}
        size="lg"
        description={
          <div className="flex flex-col gap-3">
            <p className="text-sm text-smoke">{t('translations.import_hint')}</p>
            <TextAreaField
              label={t('translations.value')}
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              rows={12}
              className="min-h-48 font-mono"
            />
          </div>
        }
        confirmLabel={t('translations.import')}
        busy={imported.isPending}
        confirmDisabled={importText.trim() === ''}
        onConfirm={submitImport}
        onClose={() => {
          setImporting(false)
          setImportText('')
        }}
      />
    </section>
  )
}
