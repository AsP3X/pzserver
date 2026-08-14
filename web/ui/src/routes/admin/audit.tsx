import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { Field } from '@/components/ui/field'
import { FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { type AuditEntry } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import { adminAuditActionsQuery, adminAuditQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

/**
 * The staff ledger. Left: what happened. Right: the selected row, including
 * the redacted request body.
 */
export function AdminAuditPage() {
  const { t, intlLocale } = useTranslation()
  const [actor, setActor] = useState('')
  const [action, setAction] = useState('')
  const [target, setTarget] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const filter = useMemo(
    () => ({
      actor: actor.trim() || undefined,
      action: action || undefined,
      target: target.trim() || undefined,
    }),
    [actor, action, target],
  )

  const list = useQuery(adminAuditQuery(filter))
  const verbs = useQuery(adminAuditActionsQuery)
  const rows = list.data ?? []
  const current = rows.find((row) => row.id === selected) ?? rows[0] ?? null

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header>
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="hazard-tape h-1 w-8" />
          <span className="eyebrow">{t('nav.group.system')}</span>
        </div>
        <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('admin.audit_title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-smoke">{t('admin.audit_description')}</p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label={t('admin.audit_actor')}
          value={actor}
          onChange={(event) => setActor(event.target.value)}
        />
        <label className="flex flex-col gap-2">
          <span className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
            {t('admin.audit_action')}
          </span>
          <select
            value={action}
            onChange={(event) => setAction(event.target.value)}
            className="h-12 border border-fence-bright bg-void px-3 font-mono text-sm text-bone"
          >
            <option value="">{t('admin.audit_all_actions')}</option>
            {(verbs.data ?? []).map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <Field
          label={t('admin.audit_target')}
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        />
      </div>

      {list.isError ? <FormError>{t('common.error')}</FormError> : null}

      {list.isPending ? (
        <Skeleton className="min-h-0 flex-1" />
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(18rem,28rem)_minmax(0,1fr)]">
          <Panel bracketed className="flex min-h-0 flex-col">
            <PanelHeader
              label={t('admin.audit_title')}
              action={
                <span className="font-mono text-[0.6875rem] text-dust">
                  {t('admin.backups_showing', { count: rows.length })}
                </span>
              }
            />
            {rows.length === 0 ? (
              <p className="p-5 text-sm text-dust">{t('admin.audit_empty')}</p>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
                {rows.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(row.id)}
                      className={cn(
                        'flex w-full flex-col items-start gap-1 px-4 py-3 text-left',
                        row.id === current?.id ? 'bg-hazard-soft' : 'hover:bg-ash-raised',
                      )}
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="truncate font-mono text-sm text-bone">{row.action}</span>
                        <span
                          className={cn(
                            'shrink-0 font-mono text-[0.625rem]',
                            row.status >= 400 ? 'text-blood' : 'text-moss',
                          )}
                        >
                          {row.status}
                        </span>
                      </span>
                      <span className="font-mono text-[0.6875rem] text-dust">
                        {row.actor}
                        {row.target ? ` · ${row.target}` : ''}
                        {' · '}
                        {formatRelativeTime(row.created_at, intlLocale)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel bracketed className="overflow-y-auto">
            {current ? <Detail row={current} locale={intlLocale} /> : (
              <>
                <PanelHeader label={t('admin.audit_details')} />
                <p className="p-5 text-sm text-dust">{t('admin.audit_empty')}</p>
              </>
            )}
          </Panel>
        </div>
      )}
    </section>
  )
}

function Detail({ row, locale }: { row: AuditEntry; locale: string }) {
  const { t } = useTranslation()
  const body = JSON.stringify(row.details, null, 2)

  return (
    <>
      <PanelHeader label={row.action} />
      <dl className="grid gap-3 p-5 sm:grid-cols-2">
        <Fact label={t('admin.audit_actor')} value={row.actor} />
        <Fact label={t('admin.audit_when')} value={formatDateTime(row.created_at, locale)} />
        <Fact label={t('admin.audit_status')} value={String(row.status)} />
        <Fact label={t('admin.audit_target')} value={row.target ?? '—'} />
        <Fact label={t('admin.audit_ip')} value={row.ip_address ?? '—'} />
        <Fact label={t('admin.audit_path')} value={`${row.method} ${row.path}`} />
      </dl>
      <div className="border-t border-fence p-5">
        <p className="mb-2 font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
          {t('admin.audit_details')}
        </p>
        <pre className="overflow-x-auto border border-fence bg-void p-3 font-mono text-[0.75rem] leading-relaxed text-smoke">
          {body}
        </pre>
      </div>
    </>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">{label}</dt>
      <dd className="mt-1 break-all font-mono text-sm text-bone">{value}</dd>
    </div>
  )
}
