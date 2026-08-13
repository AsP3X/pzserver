import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LifeBuoy, ShieldAlert } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FormError, TextAreaField } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Container, Section, SectionHeading } from '@/components/ui/section'
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

/**
 * The player's own tickets — web layout.
 *
 * Two panes on a wide screen: the list stays put while the thread scrolls.
 * Filing a new ticket is a third panel, not a modal over the conversation.
 */
export function PlayerReportsPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isPending, isError, refetch } = useQuery(myReportsQuery)

  const [selected, setSelected] = useState<number | null>(null)
  const [reply, setReply] = useState('')
  const [filing, setFiling] = useState(false)
  const [kind, setKind] = useState<ReportKind>('report')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [accused, setAccused] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const reports = data ?? []
  const current = useMemo(
    () => reports.find((report) => report.id === selected) ?? null,
    [reports, selected],
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
    setError(null)
    setNotice(null)
    if (report.unread) {
      void api.readMyReport(report.id).then(() =>
        queryClient.invalidateQueries({ queryKey: ['me', 'reports'] }),
      )
    }
  }

  return (
    <Section className="flex min-h-0 flex-1 flex-col py-8 sm:py-10">
      <Container className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionHeading
          eyebrow={t('me.reports_eyebrow')}
          title={t('me.reports_title')}
          description={t('me.reports_description')}
        />
        <Button size="sm" variant={filing ? 'outline' : 'primary'} onClick={() => setFiling((open) => !open)}>
          {filing ? t('common.cancel') : t('me.reports_new')}
        </Button>
      </div>

      {notice ? <p className="text-sm text-moss">{notice}</p> : null}
      {error ? <FormError>{error}</FormError> : null}

      {filing ? (
        <Panel bracketed className="max-w-2xl">
          <PanelHeader label={t('me.reports_new')} />
          <form
            className="flex flex-col gap-4 p-5"
            onSubmit={(event) => {
              event.preventDefault()
              setError(null)
              create.mutate()
            }}
          >
            <div className="flex flex-wrap gap-1.5">
              {(['report', 'support'] as ReportKind[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setKind(item)}
                  aria-pressed={kind === item}
                  className={cn(
                    'border px-2 py-1 font-mono text-[0.6875rem] tracking-widest uppercase',
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
              onChange={(event) => setSubject(event.target.value)}
              maxLength={150}
              required
            />
            {kind === 'report' ? (
              <Field
                label={t('me.reports_accused')}
                value={accused}
                onChange={(event) => setAccused(event.target.value)}
                maxLength={50}
                required
              />
            ) : null}
            <TextAreaField
              label={t('me.reports_body')}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={5000}
              required
            />
            <Button type="submit" size="sm" disabled={create.isPending}>
              {t('me.reports_submit')}
            </Button>
          </form>
        </Panel>
      ) : null}

      {isPending ? (
        <Skeleton className="min-h-80 flex-1" />
      ) : isError ? (
        <div className="p-5">
          <p className="text-sm text-dust">{t('common.error')}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
          <Panel bracketed className="flex min-h-0 flex-col">
            <PanelHeader
              label={t('me.reports_list')}
              action={
                <span className="font-mono text-[0.6875rem] text-dust">
                  {t('me.reports_count', { count: reports.length })}
                </span>
              }
            />
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
                            <span className="size-1.5 shrink-0 rounded-full bg-hazard" aria-label={t('me.reports_unread')} />
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
                      <span className="line-clamp-1 font-mono text-[0.6875rem] text-dust">
                        {report.last_message_preview ?? report.body}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel bracketed className="flex min-h-0 flex-col overflow-y-auto">
            {current ? (
              <>
                <PanelHeader
                  label={current.subject}
                  action={
                    <span className={cn('font-mono text-[0.6875rem] tracking-widest uppercase', statusTone(current.status))}>
                      {t(statusLabel(current.status))}
                    </span>
                  }
                />
                <div className="flex flex-col gap-4 p-5">
                  <p className="font-mono text-[0.6875rem] text-dust">
                    {current.accused
                      ? t('admin.reports_about', { player: current.accused })
                      : t('admin.reports_kind_support')}
                    {' · '}
                    {formatDateTime(current.created_at, intlLocale)}
                  </p>
                  <ol className="flex flex-col gap-2">
                    {(current.messages.length > 0
                      ? current.messages
                      : [
                          {
                            id: 0,
                            report_id: current.id,
                            author_role: 'player',
                            author: current.author,
                            body: current.body,
                            created_at: current.created_at,
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
                            ? t('admin.reports_team')
                            : t('me.reports_you')}
                          {` · ${formatRelativeTime(message.created_at, intlLocale)}`}
                        </p>
                        <p className="mt-2 whitespace-pre-wrap text-sm text-bone">{message.body}</p>
                      </li>
                    ))}
                  </ol>
                  <form
                    className="flex flex-col gap-3 border-t border-fence pt-4"
                    onSubmit={(event) => {
                      event.preventDefault()
                      setError(null)
                      send.mutate()
                    }}
                  >
                    <TextAreaField
                      label={t('me.reports_reply')}
                      value={reply}
                      onChange={(event) => setReply(event.target.value)}
                      maxLength={2000}
                    />
                    <Button type="submit" size="sm" disabled={send.isPending || reply.trim() === ''}>
                      {t('me.reports_send')}
                    </Button>
                  </form>
                </div>
              </>
            ) : (
              <>
                <PanelHeader label={t('me.reports_thread')} />
                <p className="p-5 text-sm text-dust">{t('me.reports_pick')}</p>
              </>
            )}
          </Panel>
        </div>
      )}
      </Container>
    </Section>
  )
}

function statusLabel(status: string): TranslationKey {
  return STATUSES.find((item) => item.id === status)?.label ?? 'admin.reports_status_open'
}
