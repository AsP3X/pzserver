import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LifeBuoy, Search, ShieldAlert, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { FormError, TextAreaField } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, type PlayerReport, type ReportKind, type ReportStatus } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import { fuzzyMatch } from '@/lib/fuzzy'
import { adminReportsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

type QueueFilter = 'attention' | 'handled' | 'all'
type KindFilter = 'all' | ReportKind

const QUEUE: { id: QueueFilter; label: TranslationKey }[] = [
  { id: 'attention', label: 'admin.reports_filter_attention' },
  { id: 'handled', label: 'admin.reports_filter_handled' },
  { id: 'all', label: 'common.all' },
]

const KINDS: { id: KindFilter; label: TranslationKey }[] = [
  { id: 'all', label: 'common.all' },
  { id: 'report', label: 'admin.reports_kind_report' },
  { id: 'support', label: 'admin.reports_kind_support' },
]

const STATUSES: { id: ReportStatus; label: TranslationKey }[] = [
  { id: 'open', label: 'admin.reports_status_open' },
  { id: 'investigating', label: 'admin.reports_status_investigating' },
  { id: 'resolved', label: 'admin.reports_status_resolved' },
  { id: 'rejected', label: 'admin.reports_status_rejected' },
]

function isOpen(status: string): boolean {
  return status === 'open' || status === 'investigating'
}

function statusTone(status: string): string {
  if (status === 'rejected') {
    return 'text-blood'
  }
  if (status === 'resolved') {
    return 'text-moss'
  }
  if (status === 'investigating') {
    return 'text-hazard'
  }
  return 'text-smoke'
}

/**
 * The staff queue for player reports and help tickets.
 *
 * Open and investigating first. Handling writes a status and an optional
 * reply the player can read on their own reports page.
 */
export function AdminReportsPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const searchRef = useRef<HTMLInputElement>(null)

  const { data, isPending, isError, refetch } = useQuery(adminReportsQuery)

  const [queue, setQueue] = useState<QueueFilter>('attention')
  const [kind, setKind] = useState<KindFilter>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [status, setStatus] = useState<ReportStatus>('investigating')
  const [resolution, setResolution] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reports = data?.reports ?? []
  const openCount = data?.open_count ?? 0
  const searching = query.trim().length > 0

  const visible = useMemo(() => {
    const filtered = reports.filter((report) => {
      if (queue === 'attention' && !isOpen(report.status)) {
        return false
      }
      if (queue === 'handled' && isOpen(report.status)) {
        return false
      }
      if (kind !== 'all' && report.kind !== kind) {
        return false
      }
      return true
    })

    if (!searching) {
      return filtered
    }

    return filtered
      .map((report) => {
        const haystack = [report.subject, report.body, report.author, report.accused, report.resolution]
          .filter((value): value is string => Boolean(value))
          .join(' ')
        const hit = fuzzyMatch(query, haystack)
        return hit ? { report, score: hit.score } : null
      })
      .filter((row): row is { report: PlayerReport; score: number } => row !== null)
      .sort((left, right) => right.score - left.score || right.report.id - left.report.id)
      .map((row) => row.report)
  }, [kind, query, queue, reports, searching])

  const current = visible.find((report) => report.id === selected) ?? null

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

  function select(report: PlayerReport) {
    setSelected(report.id)
    setStatus(report.status === 'open' ? 'investigating' : (report.status as ReportStatus))
    setResolution('')
    setError(null)
    setNotice(null)
  }

  const save = useMutation({
    mutationFn: () => {
      if (!current) {
        throw new Error('missing report')
      }
      return api.adminHandleReport(current.id, status, resolution || undefined)
    },
    onSuccess: async () => {
      setNotice(t('admin.reports_saved'))
      await queryClient.invalidateQueries({ queryKey: ['admin', 'reports'] })
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.players')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('admin.reports_title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">
            {t('admin.reports_description', { count: openCount })}
          </p>
        </div>
        <p className="font-mono text-[0.6875rem] text-dust">
          {t('admin.reports_counts', { open: openCount, total: reports.length })}
        </p>
      </header>

      {notice ? (
        <p role="status" className="shrink-0 border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}

      <div className="flex shrink-0 flex-col gap-3 border border-fence bg-ash px-3 py-3 lg:flex-row lg:items-end">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('admin.reports_queue')}>
          {QUEUE.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setQueue(item.id)}
              aria-pressed={queue === item.id}
              className={cn(
                'border px-2 py-1 font-mono text-[0.6875rem] tracking-widest uppercase',
                queue === item.id
                  ? 'border-hazard bg-hazard-soft text-hazard'
                  : 'border-fence text-dust hover:border-fence-bright hover:text-bone',
              )}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('admin.reports_kind')}>
          {KINDS.map((item) => (
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
            placeholder={t('admin.reports_search_placeholder')}
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
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)]">
          <Panel bracketed className="flex min-h-0 flex-col">
            <PanelHeader
              label={t('admin.reports_queue')}
              action={
                <span className="font-mono text-[0.6875rem] text-dust">
                  {t('admin.reports_showing', { count: visible.length })}
                </span>
              }
            />
            {visible.length === 0 ? (
              <p className="p-5 text-sm text-dust">{t('admin.reports_empty')}</p>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
                {visible.map((report) => (
                  <li key={report.id}>
                    <button
                      type="button"
                      onClick={() => select(report)}
                      aria-current={report.id === current?.id ? 'true' : undefined}
                      className={cn(
                        'flex w-full flex-col items-start gap-1 px-4 py-3 text-left',
                        report.id === current?.id ? 'bg-hazard-soft' : 'hover:bg-ash-raised',
                      )}
                    >
                      <span className="flex w-full items-start justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2 text-sm text-bone">
                          {report.kind === 'report' ? (
                            <ShieldAlert aria-hidden="true" className="size-4 shrink-0 text-blood" />
                          ) : (
                            <LifeBuoy aria-hidden="true" className="size-4 shrink-0 text-hazard" />
                          )}
                          <span className="truncate">{report.subject}</span>
                        </span>
                        <span
                          className={cn(
                            'shrink-0 font-mono text-[0.625rem] tracking-widest uppercase',
                            statusTone(report.status),
                          )}
                        >
                          {t(statusLabel(report.status))}
                          {report.unread ? (
                            <span className="ml-1 text-hazard">{t('admin.reports_unread')}</span>
                          ) : null}
                        </span>
                      </span>
                      <span className="font-mono text-[0.6875rem] text-dust">
                        {t('admin.reports_from', { player: report.author })}
                        {report.accused
                          ? ` · ${t('admin.reports_about', { player: report.accused })}`
                          : ''}
                        {` · ${formatRelativeTime(report.created_at, intlLocale)}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel bracketed className="flex min-h-0 flex-col overflow-y-auto">
            {current ? (
              <HandlePanel
                report={current}
                locale={intlLocale}
                status={status}
                resolution={resolution}
                busy={save.isPending}
                onStatus={setStatus}
                onResolution={setResolution}
                onSave={() => save.mutate()}
              />
            ) : (
              <>
                <PanelHeader label={t('admin.reports_handle')} />
                <p className="p-5 text-sm text-dust">{t('admin.reports_pick')}</p>
              </>
            )}
          </Panel>
        </div>
      )}
    </section>
  )
}

function statusLabel(status: string): TranslationKey {
  return STATUSES.find((item) => item.id === status)?.label ?? 'admin.reports_status_open'
}

function HandlePanel({
  report,
  locale,
  status,
  resolution,
  busy,
  onStatus,
  onResolution,
  onSave,
}: {
  report: PlayerReport
  locale: string
  status: ReportStatus
  resolution: string
  busy: boolean
  onStatus: (status: ReportStatus) => void
  onResolution: (value: string) => void
  onSave: () => void
}) {
  const { t } = useTranslation()

  return (
    <>
      <PanelHeader
        label={t('admin.reports_handle')}
        action={
          <span className={cn('font-mono text-[0.6875rem] tracking-widest uppercase', statusTone(report.status))}>
            {t(statusLabel(report.status))}
          </span>
        }
      />
      <div className="flex flex-col gap-5 p-5">
        <div>
          <p className="flex items-center gap-2 text-lg text-bone">
            {report.kind === 'report' ? (
              <ShieldAlert aria-hidden="true" className="size-5 text-blood" />
            ) : (
              <LifeBuoy aria-hidden="true" className="size-5 text-hazard" />
            )}
            {report.subject}
          </p>
          <p className="mt-1 font-mono text-[0.6875rem] text-dust">
            {t(report.kind === 'report' ? 'admin.reports_kind_report' : 'admin.reports_kind_support')}
            {' · '}
            {t('admin.reports_from', { player: report.author })}
            {report.accused ? ` · ${t('admin.reports_about', { player: report.accused })}` : ''}
          </p>
          <p className="mt-1 font-mono text-[0.625rem] text-dust">{formatDateTime(report.created_at, locale)}</p>
        </div>

        <ol className="flex flex-col gap-2">
          {(report.messages.length > 0
            ? report.messages
            : [
                {
                  id: 0,
                  report_id: report.id,
                  author_role: 'player',
                  author: report.author,
                  body: report.body,
                  created_at: report.created_at,
                },
              ]
          ).map((message) => (
            <li
              key={message.id || 'opening'}
              className={cn(
                'border px-3 py-3',
                message.author_role === 'staff'
                  ? 'border-hazard/40 bg-void'
                  : 'border-fence bg-ash-raised',
              )}
            >
              <p className="font-mono text-[0.625rem] tracking-widest text-dust uppercase">
                {message.author_role === 'staff'
                  ? (message.author || t('admin.reports_team'))
                  : message.author}
                {` · ${formatRelativeTime(message.created_at, locale)}`}
              </p>
              <p className="mt-2 whitespace-pre-wrap text-sm text-bone">{message.body}</p>
            </li>
          ))}
        </ol>

        <form
          className="flex flex-col gap-4 border-t border-fence pt-5"
          onSubmit={(event) => {
            event.preventDefault()
            onSave()
          }}
        >
          <fieldset>
            <legend className="mb-2 font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
              {t('admin.reports_status')}
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {STATUSES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onStatus(item.id)}
                  aria-pressed={status === item.id}
                  className={cn(
                    'border px-2 py-1 font-mono text-[0.6875rem] tracking-widest uppercase',
                    status === item.id
                      ? 'border-hazard bg-hazard-soft text-hazard'
                      : 'border-fence text-dust hover:border-fence-bright hover:text-bone',
                  )}
                >
                  {t(item.label)}
                </button>
              ))}
            </div>
          </fieldset>

          <TextAreaField
            label={t('admin.reports_reply')}
            value={resolution}
            onChange={(event) => onResolution(event.target.value)}
            maxLength={2000}
            hint={t('admin.reports_reply_hint')}
          />

          <Button type="submit" size="sm" disabled={busy}>
            {t('common.save')}
          </Button>
        </form>
      </div>
    </>
  )
}
