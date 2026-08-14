import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LifeBuoy, Plus, ShieldAlert } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FormError, TextAreaField } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, type PlayerReport, type ReportKind, type ReportStatus } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import { myReportsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

const STATUSES: { id: ReportStatus; label: TranslationKey }[] = [
  { id: 'open', label: 'admin.reports_status_open' },
  { id: 'investigating', label: 'admin.reports_status_investigating' },
  { id: 'resolved', label: 'admin.reports_status_resolved' },
  { id: 'rejected', label: 'admin.reports_status_rejected' },
]

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

function statusLabel(status: string): TranslationKey {
  return STATUSES.find((item) => item.id === status)?.label ?? 'admin.reports_status_open'
}

/**
 * Player reports: a conversation with the team.
 *
 * Same use of the shell as the staff page (header + two full-height panes)
 * but nothing of a queue — no filters, no status tools, no search. New report
 * and the thread occupy the right pane. The reply sits at the bottom so the
 * conversation can grow.
 */
export function PlayerReportsPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isPending, isError, refetch } = useQuery(myReportsQuery)

  const [selected, setSelected] = useState<number | null>(null)
  const [filing, setFiling] = useState(false)
  const [reply, setReply] = useState('')
  const [kind, setKind] = useState<ReportKind>('report')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [accused, setAccused] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const reports = data ?? []
  const unread = reports.filter((report) => report.unread).length
  const current = useMemo(
    () => (filing ? null : (reports.find((report) => report.id === selected) ?? null)),
    [filing, reports, selected],
  )

  const send = useMutation({
    mutationFn: () => {
      if (!current) {
        throw new Error('missing report')
      }
      return api.replyMyReport(current.id, reply)
    },
    onSuccess: async () => {
      setReply('')
      setNotice(t('me.reports_sent'))
      await queryClient.invalidateQueries({ queryKey: ['me', 'reports'] })
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  const create = useMutation({
    mutationFn: () =>
      api.fileReport({
        kind,
        subject,
        body,
        accused: kind === 'report' ? accused : undefined,
      }),
    onSuccess: async (report) => {
      setFiling(false)
      setSubject('')
      setBody('')
      setAccused('')
      setSelected(report.id)
      setNotice(t('me.reports_filed'))
      await queryClient.invalidateQueries({ queryKey: ['me', 'reports'] })
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  function open(report: PlayerReport) {
    setSelected(report.id)
    setFiling(false)
    setReply('')
    setError(null)
    setNotice(null)
    if (report.unread) {
      void api.readMyReport(report.id).then(() =>
        queryClient.invalidateQueries({ queryKey: ['me', 'reports'] }),
      )
    }
  }

  function startFiling() {
    setFiling(true)
    setError(null)
    setNotice(null)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('me.reports_eyebrow')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('me.reports_title')}</h1>
          <p className="mt-2 max-w-xl text-sm text-smoke">{t('me.reports_description')}</p>
        </div>
        <div className="flex items-center gap-3">
          {unread > 0 ? (
            <p className="font-mono text-[0.6875rem] text-hazard">
              {t('me.reports_unread_count', { count: unread })}
            </p>
          ) : (
            <p className="font-mono text-[0.6875rem] text-dust">
              {t('me.reports_count', { count: reports.length })}
            </p>
          )}
          <Button size="sm" variant={filing ? 'outline' : 'primary'} onClick={() => (filing ? setFiling(false) : startFiling())}>
            {filing ? (
              t('common.cancel')
            ) : (
              <>
                <Plus aria-hidden="true" className="size-3.5" />
                {t('me.reports_new')}
              </>
            )}
          </Button>
        </div>
      </header>

      {notice ? (
        <p role="status" className="shrink-0 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}

      {isPending ? (
        <Skeleton className="min-h-0 flex-1" />
      ) : isError ? (
        <div>
          <p className="text-sm text-dust">{t('common.error')}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(17rem,24rem)_minmax(0,1fr)]">
          <Panel bracketed className="flex min-h-0 flex-col">
            <PanelHeader label={t('me.reports_list')} />
            {reports.length === 0 ? (
              <p className="p-5 text-sm text-dust">{t('me.reports_empty')}</p>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
                {reports.map((report) => (
                  <li key={report.id}>
                    <button
                      type="button"
                      onClick={() => open(report)}
                      aria-current={report.id === current?.id ? 'true' : undefined}
                      className={cn(
                        'flex w-full flex-col items-start gap-1 px-4 py-3 text-left',
                        report.id === current?.id ? 'bg-hazard-soft' : 'hover:bg-ash-raised',
                      )}
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2 text-sm text-bone">
                          {report.kind === 'report' ? (
                            <ShieldAlert aria-hidden="true" className="size-4 shrink-0 text-blood" />
                          ) : (
                            <LifeBuoy aria-hidden="true" className="size-4 shrink-0 text-hazard" />
                          )}
                          <span className="truncate">{report.subject}</span>
                          {report.unread ? (
                            <span
                              className="size-1.5 shrink-0 rounded-full bg-hazard"
                              aria-label={t('me.reports_unread')}
                            />
                          ) : null}
                        </span>
                        <span
                          className={cn(
                            'shrink-0 font-mono text-[0.625rem] tracking-widest uppercase',
                            statusTone(report.status),
                          )}
                        >
                          {t(statusLabel(report.status))}
                        </span>
                      </span>
                      <span className="line-clamp-1 w-full font-mono text-[0.6875rem] text-dust">
                        {report.last_message_preview ?? report.body}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel bracketed className="flex min-h-0 flex-col">
            {filing ? (
              <ComposePane
                kind={kind}
                subject={subject}
                accused={accused}
                body={body}
                busy={create.isPending}
                onKind={setKind}
                onSubject={setSubject}
                onAccused={setAccused}
                onBody={setBody}
                onSubmit={() => {
                  setError(null)
                  create.mutate()
                }}
              />
            ) : current ? (
              <ThreadPane
                report={current}
                locale={intlLocale}
                reply={reply}
                busy={send.isPending}
                onReply={setReply}
                onSend={() => {
                  setError(null)
                  send.mutate()
                }}
              />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <PanelHeader label={t('me.reports_thread')} />
                <p className="p-5 text-sm text-dust">{t('me.reports_pick')}</p>
              </div>
            )}
          </Panel>
        </div>
      )}
    </section>
  )
}

function ThreadPane({
  report,
  locale,
  reply,
  busy,
  onReply,
  onSend,
}: {
  report: PlayerReport
  locale: string
  reply: string
  busy: boolean
  onReply: (value: string) => void
  onSend: () => void
}) {
  const { t } = useTranslation()
  const messages =
    report.messages.length > 0
      ? report.messages
      : [
          {
            id: 0,
            report_id: report.id,
            author_role: 'player' as const,
            author: report.author,
            body: report.body,
            created_at: report.created_at,
          },
        ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-fence px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-base text-bone sm:text-lg">
              {report.kind === 'report' ? (
                <ShieldAlert aria-hidden="true" className="size-4 shrink-0 text-blood" />
              ) : (
                <LifeBuoy aria-hidden="true" className="size-4 shrink-0 text-hazard" />
              )}
              <span className="truncate">{report.subject}</span>
            </p>
            <p className="mt-1 font-mono text-[0.6875rem] text-dust">
              {t(report.kind === 'report' ? 'admin.reports_kind_report' : 'admin.reports_kind_support')}
              {report.accused ? ` · ${t('admin.reports_about', { player: report.accused })}` : ''}
              {` · ${formatDateTime(report.created_at, locale)}`}
            </p>
          </div>
          <span
            className={cn(
              'shrink-0 font-mono text-[0.6875rem] tracking-widest uppercase',
              statusTone(report.status),
            )}
          >
            {t(statusLabel(report.status))}
          </span>
        </div>
      </div>

      <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {messages.map((message) => {
          const staff = message.author_role === 'staff'
          return (
            <li key={message.id || 'opening'} className={cn('flex', staff ? 'justify-start' : 'justify-end')}>
              <div
                className={cn(
                  'max-w-[min(36rem,92%)] border px-4 py-3',
                  staff ? 'border-hazard/40 bg-void' : 'border-fence bg-ash-raised',
                )}
              >
                <p className="font-mono text-[0.625rem] tracking-widest text-dust uppercase">
                  {staff ? t('admin.reports_team') : t('me.reports_you')}
                  {` · ${formatRelativeTime(message.created_at, locale)}`}
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-bone">{message.body}</p>
              </div>
            </li>
          )
        })}
      </ol>

      <form
        className="shrink-0 border-t border-fence bg-ash px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault()
          onSend()
        }}
      >
        <TextAreaField
          label={t('me.reports_reply')}
          value={reply}
          onChange={(event) => onReply(event.target.value)}
          maxLength={2000}
        />
        <Button type="submit" size="sm" className="mt-3" disabled={busy || reply.trim() === ''}>
          {t('me.reports_send')}
        </Button>
      </form>
    </div>
  )
}

function ComposePane({
  kind,
  subject,
  accused,
  body,
  busy,
  onKind,
  onSubject,
  onAccused,
  onBody,
  onSubmit,
}: {
  kind: ReportKind
  subject: string
  accused: string
  body: string
  busy: boolean
  onKind: (kind: ReportKind) => void
  onSubject: (value: string) => void
  onAccused: (value: string) => void
  onBody: (value: string) => void
  onSubmit: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader label={t('me.reports_new')} />
      <form
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5 sm:p-6"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('admin.reports_kind')}>
          {(['report', 'support'] as ReportKind[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onKind(item)}
              aria-pressed={kind === item}
              className={cn(
                'border px-3 py-1.5 font-mono text-[0.6875rem] tracking-widest uppercase',
                kind === item
                  ? 'border-hazard bg-hazard-soft text-hazard'
                  : 'border-fence text-dust hover:text-bone',
              )}
            >
              {t(item === 'report' ? 'admin.reports_kind_report' : 'admin.reports_kind_support')}
            </button>
          ))}
        </div>
        <Field
          label={t('me.reports_subject')}
          value={subject}
          onChange={(event) => onSubject(event.target.value)}
          maxLength={150}
          required
        />
        {kind === 'report' ? (
          <Field
            label={t('me.reports_accused')}
            value={accused}
            onChange={(event) => onAccused(event.target.value)}
            maxLength={50}
            required
          />
        ) : null}
        <div className="flex min-h-40 flex-1 flex-col">
          <TextAreaField
            label={t('me.reports_body')}
            value={body}
            onChange={(event) => onBody(event.target.value)}
            maxLength={5000}
            required
            className="min-h-40 flex-1"
          />
        </div>
        <Button type="submit" size="sm" disabled={busy}>
          {t('me.reports_submit')}
        </Button>
      </form>
    </div>
  )
}
