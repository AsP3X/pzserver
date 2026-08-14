import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError, TextAreaField } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { TabStrip } from '@/components/ui/tabs'
import {
  api,
  ApiError,
  type Automation,
  type AutomationAction,
  type AutomationInput,
  type AutomationRun,
  type AutomationScheduleKind,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import { adminAutomationRunsQuery, adminAutomationsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

type ActionGroup = 'machine' | 'world' | 'access' | 'voice' | 'events'

const GROUPS: { id: ActionGroup; label: TranslationKey }[] = [
  { id: 'machine', label: 'admin.automations_group_machine' },
  { id: 'world', label: 'admin.automations_group_world' },
  { id: 'access', label: 'admin.automations_group_access' },
  { id: 'voice', label: 'admin.automations_group_voice' },
  { id: 'events', label: 'admin.automations_group_events' },
]

const ACTIONS: {
  id: AutomationAction
  group: ActionGroup
  label: TranslationKey
  hint: TranslationKey
}[] = [
  { id: 'restart', group: 'machine', label: 'admin.automations_action_restart', hint: 'admin.automations_hint_restart' },
  { id: 'start', group: 'machine', label: 'admin.automations_action_start', hint: 'admin.automations_hint_start' },
  { id: 'stop', group: 'machine', label: 'admin.automations_action_stop', hint: 'admin.automations_hint_stop' },
  { id: 'save', group: 'world', label: 'admin.automations_action_save', hint: 'admin.automations_hint_save' },
  { id: 'backup', group: 'world', label: 'admin.automations_action_backup', hint: 'admin.automations_hint_backup' },
  { id: 'rollback', group: 'world', label: 'admin.automations_action_rollback', hint: 'admin.automations_hint_rollback' },
  { id: 'cycle', group: 'world', label: 'admin.automations_action_cycle', hint: 'admin.automations_hint_cycle' },
  { id: 'whitelist_open', group: 'access', label: 'admin.automations_action_whitelist_open', hint: 'admin.automations_hint_whitelist_open' },
  { id: 'whitelist_close', group: 'access', label: 'admin.automations_action_whitelist_close', hint: 'admin.automations_hint_whitelist_close' },
  { id: 'kick_all', group: 'access', label: 'admin.automations_action_kick_all', hint: 'admin.automations_hint_kick_all' },
  { id: 'config', group: 'access', label: 'admin.automations_action_config', hint: 'admin.automations_hint_config' },
  { id: 'broadcast', group: 'voice', label: 'admin.automations_action_broadcast', hint: 'admin.automations_hint_broadcast' },
  { id: 'rcon', group: 'voice', label: 'admin.automations_action_rcon', hint: 'admin.automations_hint_rcon' },
  { id: 'chopper', group: 'events', label: 'admin.automations_action_chopper', hint: 'admin.automations_hint_chopper' },
  { id: 'gunshot', group: 'events', label: 'admin.automations_action_gunshot', hint: 'admin.automations_hint_gunshot' },
  { id: 'rain_start', group: 'events', label: 'admin.automations_action_rain_start', hint: 'admin.automations_hint_rain_start' },
  { id: 'rain_stop', group: 'events', label: 'admin.automations_action_rain_stop', hint: 'admin.automations_hint_rain_stop' },
  { id: 'thunder', group: 'events', label: 'admin.automations_action_thunder', hint: 'admin.automations_hint_thunder' },
]

const DISRUPTIVE = new Set<AutomationAction>([
  'restart',
  'stop',
  'backup',
  'rollback',
  'cycle',
  'kick_all',
])

const KINDS: { id: AutomationScheduleKind; label: TranslationKey }[] = [
  { id: 'times', label: 'admin.automations_schedule_times' },
  { id: 'every', label: 'admin.automations_schedule_every' },
]

const WARNINGS = [0, 60, 120, 300, 600, 1800] as const

function actionLabel(action: string): TranslationKey {
  return ACTIONS.find((item) => item.id === action)?.label ?? 'admin.automations_action_restart'
}

function statusLabel(status: string): TranslationKey {
  if (status === 'error') {
    return 'admin.automations_status_error'
  }
  if (status === 'warned') {
    return 'admin.automations_status_warned'
  }
  return 'admin.automations_status_ok'
}

function statusTone(status: string): string {
  if (status === 'error') {
    return 'text-blood'
  }
  if (status === 'warned') {
    return 'text-hazard'
  }
  return 'text-moss'
}

function findAction(action: string) {
  return ACTIONS.find((item) => item.id === action)
}

function needsCopy(action: string): boolean {
  return action === 'broadcast' || action === 'rcon'
}

function optionalCopy(action: string): boolean {
  return action === 'backup' || action === 'restart' || action === 'stop' || action === 'cycle' || action === 'kick_all'
}

function defaultWarn(action: AutomationAction): number {
  return DISRUPTIVE.has(action) && action !== 'backup' ? 300 : 0
}

function splitConfig(message: string): { key: string; value: string } {
  const index = message.indexOf('=')
  if (index === -1) {
    return { key: message, value: '' }
  }
  return { key: message.slice(0, index), value: message.slice(index + 1) }
}

function joinConfig(key: string, value: string): string {
  return `${key.trim()}=${value}`
}

function messageFor(action: AutomationAction, message: string, configKey: string, configValue: string): string | null {
  if (action === 'config') {
    const joined = joinConfig(configKey, configValue)
    return joined === '=' ? null : joined
  }
  return message.trim() || null
}

function missingRequired(action: AutomationAction, message: string, configKey: string): boolean {
  if (action === 'config') {
    return configKey.trim().length === 0
  }
  return needsCopy(action) && message.trim().length === 0
}

/**
 * Clockwork for the dedicated server. Left: the jobs. Right: the selected
 * job, its timetable, and what it did last.
 */
export function AdminAutomationsPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const list = useQuery(adminAutomationsQuery)

  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [remove, setRemove] = useState<Automation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const jobs = list.data ?? []
  const current = jobs.find((item) => item.id === selected) ?? null

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'automations'] })
  }

  function fail(cause: unknown) {
    setNotice(null)
    setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
  }

  const created = useMutation({
    mutationFn: (input: AutomationInput) => api.adminCreateAutomation(input),
    onSuccess: async (job) => {
      setCreating(false)
      setSelected(job.id)
      setError(null)
      setNotice(t('admin.automations_created'))
      await refresh()
    },
    onError: fail,
  })

  const saved = useMutation({
    mutationFn: (input: AutomationInput) => {
      if (!current) {
        throw new Error('missing automation')
      }
      return api.adminUpdateAutomation(current.id, input)
    },
    onSuccess: async () => {
      setError(null)
      setNotice(t('admin.automations_saved'))
      await refresh()
    },
    onError: fail,
  })

  const ran = useMutation({
    mutationFn: () => {
      if (!current) {
        throw new Error('missing automation')
      }
      return api.adminRunAutomation(current.id)
    },
    onSuccess: async () => {
      setError(null)
      setNotice(t('admin.automations_ran'))
      await refresh()
      if (current) {
        await queryClient.invalidateQueries({ queryKey: ['admin', 'automations', current.id, 'runs'] })
      }
    },
    onError: fail,
  })

  const destroyed = useMutation({
    mutationFn: (id: string) => api.adminDeleteAutomation(id),
    onSuccess: async () => {
      setRemove(null)
      setSelected(null)
      setError(null)
      setNotice(t('admin.automations_deleted'))
      await refresh()
    },
    onError: fail,
  })

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.server')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('admin.automations_title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('admin.automations_description')}</p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setError(null)
            setCreating(true)
          }}
        >
          <Plus aria-hidden="true" className="size-3.5" />
          {t('admin.automations_new')}
        </Button>
      </header>

      {notice ? (
        <p role="status" className="shrink-0 border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}

      {list.isPending ? (
        <Skeleton className="min-h-0 flex-1" />
      ) : list.isError ? (
        <div>
          <FormError>{t('common.error')}</FormError>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void list.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)]">
          <Panel bracketed className="flex min-h-0 flex-col">
            <PanelHeader
              label={t('admin.automations_list')}
              action={
                <span className="font-mono text-[0.6875rem] text-dust">
                  {t('admin.backups_showing', { count: jobs.length })}
                </span>
              }
            />
            {jobs.length === 0 ? (
              <p className="p-5 text-sm text-dust">{t('admin.automations_empty')}</p>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
                {jobs.map((job) => (
                  <li key={job.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(job.id)}
                      aria-current={job.id === current?.id ? 'true' : undefined}
                      className={cn(
                        'flex w-full flex-col items-start gap-1 px-4 py-3 text-left',
                        job.id === current?.id ? 'bg-hazard-soft' : 'hover:bg-ash-raised',
                      )}
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="truncate text-sm text-bone">{job.name}</span>
                        <span
                          className={cn(
                            'shrink-0 font-mono text-[0.625rem] tracking-widest uppercase',
                            job.enabled ? 'text-moss' : 'text-dust',
                          )}
                        >
                          {job.enabled ? t('admin.automations_enabled') : t('admin.automations_disabled')}
                        </span>
                      </span>
                      <span className="font-mono text-[0.6875rem] text-dust">
                        {t(actionLabel(job.action))}
                        {' · '}
                        {job.schedule_kind === 'every'
                          ? t('admin.automations_summary_every', { minutes: job.every_minutes ?? 0 })
                          : t('admin.automations_summary_times', {
                              times: job.times.length > 0 ? job.times.join(', ') : '—',
                            })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel bracketed className="flex min-h-0 flex-col overflow-y-auto">
            {current ? (
              <Editor
                key={current.id}
                job={current}
                locale={intlLocale}
                busy={saved.isPending || ran.isPending}
                onSave={(input) => saved.mutate(input)}
                onRun={() => ran.mutate()}
                onDelete={() => setRemove(current)}
              />
            ) : (
              <>
                <PanelHeader label={t('admin.automations_detail')} />
                <p className="p-5 text-sm text-dust">{t('admin.automations_empty')}</p>
              </>
            )}
          </Panel>
        </div>
      )}

      <CreateDialog
        open={creating}
        busy={created.isPending}
        onClose={() => setCreating(false)}
        onCreate={(input) => created.mutate(input)}
      />

      <ConfirmDialog
        open={remove !== null}
        title={t('admin.automations_delete_title')}
        description={t('admin.automations_delete_body', { name: remove?.name ?? '' })}
        confirmLabel={t('common.delete')}
        tone="danger"
        busy={destroyed.isPending}
        onConfirm={() => remove && destroyed.mutate(remove.id)}
        onClose={() => setRemove(null)}
      />
    </section>
  )
}

function Editor({
  job,
  locale,
  busy,
  onSave,
  onRun,
  onDelete,
}: {
  job: Automation
  locale: string
  busy: boolean
  onSave: (input: AutomationInput) => void
  onRun: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const history = useQuery(adminAutomationRunsQuery(job.id))
  const [draft, setDraft] = useState(() => toDraft(job))
  const [time, setTime] = useState('04:00')
  const config = splitConfig(draft.message)

  return (
    <>
      <PanelHeader
        label={t('admin.automations_detail')}
        action={
          <span className={cn('font-mono text-[0.6875rem] uppercase', job.last_status ? statusTone(job.last_status) : 'text-dust')}>
            {job.last_status ? t(statusLabel(job.last_status)) : t('admin.automations_never')}
          </span>
        }
      />
      <form
        className="flex flex-col gap-5 p-5"
        onSubmit={(event) => {
          event.preventDefault()
          onSave({
            name: draft.name.trim(),
            enabled: draft.enabled,
            action: draft.action,
            message: messageFor(draft.action, draft.message, config.key, config.value),
            warn_seconds: draft.warn_seconds,
            warn_message: draft.warn_message.trim() || null,
            schedule_kind: draft.kind,
            times: draft.kind === 'times' ? draft.times : [],
            every_minutes: draft.kind === 'every' ? draft.every : 60,
          })
        }}
      >
        <label className="flex items-center gap-2 text-sm text-bone">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
          />
          {t('admin.automations_enabled')}
        </label>
        <Field
          label={t('admin.automations_name')}
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          maxLength={80}
        />
        <ActionPicker
          action={draft.action}
          onChange={(action) =>
            setDraft((current) => ({
              ...current,
              action,
              warn_seconds: DISRUPTIVE.has(action) ? current.warn_seconds : 0,
            }))
          }
        />
        <ActionFields
          action={draft.action}
          message={draft.message}
          onMessage={(message) => setDraft((current) => ({ ...current, message }))}
        />
        <ChipGroup
          label={t('admin.automations_schedule')}
          items={KINDS}
          value={draft.kind}
          onChange={(kind) => setDraft((current) => ({ ...current, kind }))}
        />
        {draft.kind === 'times' ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
              {t('admin.automations_times')}
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {draft.times.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      times: current.times.filter((time) => time !== item),
                    }))
                  }
                  className="border border-hazard bg-hazard-soft px-2 py-1 font-mono text-[0.6875rem] text-hazard"
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Field type="time" label={t('admin.automations_add_time')} value={time} onChange={(event) => setTime(event.target.value)} />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (!time || draft.times.includes(time)) {
                    return
                  }
                  setDraft((current) => ({ ...current, times: [...current.times, time].sort() }))
                }}
              >
                {t('admin.automations_add_time')}
              </Button>
            </div>
          </fieldset>
        ) : (
          <Field
            label={t('admin.automations_every_minutes')}
            type="number"
            min={5}
            max={10080}
            value={draft.every}
            onChange={(event) =>
              setDraft((current) => ({ ...current, every: Number(event.target.value) || 5 }))
            }
          />
        )}
        {DISRUPTIVE.has(draft.action) ? (
          <>
            <fieldset>
              <legend className="mb-2 font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
                {t('admin.automations_warn')}
              </legend>
              <div className="flex flex-wrap gap-1.5">
                {WARNINGS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setDraft((current) => ({ ...current, warn_seconds: item }))}
                    className={cn(
                      'border px-2 py-1 font-mono text-[0.6875rem]',
                      draft.warn_seconds === item
                        ? 'border-hazard bg-hazard-soft text-hazard'
                        : 'border-fence text-dust hover:border-fence-bright hover:text-bone',
                    )}
                  >
                    {item === 0 ? t('admin.backups_now') : t('admin.backups_minutes', { count: item / 60 })}
                  </button>
                ))}
              </div>
            </fieldset>
            {draft.warn_seconds > 0 ? (
              <Field
                label={t('admin.automations_warn_message')}
                value={draft.warn_message}
                onChange={(event) => setDraft((current) => ({ ...current, warn_message: event.target.value }))}
                maxLength={240}
              />
            ) : null}
          </>
        ) : null}

        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
              {t('admin.automations_next')}
            </dt>
            <dd className="mt-1 font-mono text-sm text-bone">
              {job.next_run_at ? formatDateTime(job.next_run_at, locale) : t('admin.automations_never')}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
              {t('admin.automations_last')}
            </dt>
            <dd className="mt-1 font-mono text-sm text-bone">
              {job.last_run_at ? formatDateTime(job.last_run_at, locale) : t('admin.automations_never')}
            </dd>
          </div>
        </dl>
        {job.last_error ? <FormError>{job.last_error}</FormError> : null}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            {t('common.save')}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onRun}>
            <Play aria-hidden="true" className="size-3.5" />
            {t('admin.automations_run_now')}
          </Button>
          <Button type="button" size="sm" variant="outline" className="border-blood text-blood" onClick={onDelete}>
            <Trash2 aria-hidden="true" className="size-3.5" />
            {t('common.delete')}
          </Button>
        </div>
      </form>

      <div className="border-t border-fence">
        <PanelHeader label={t('admin.automations_history')} />
        {history.isPending ? (
          <Skeleton className="m-5 h-24" />
        ) : (history.data ?? []).length === 0 ? (
          <p className="p-5 text-sm text-dust">{t('admin.automations_history_empty')}</p>
        ) : (
          <ul className="divide-y divide-fence">
            {(history.data ?? []).map((run) => (
              <HistoryRow key={run.id} run={run} locale={locale} />
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

function HistoryRow({ run, locale }: { run: AutomationRun; locale: string }) {
  const { t } = useTranslation()
  return (
    <li className="flex flex-col gap-1 px-5 py-3">
      <span className="flex items-center justify-between gap-2">
        <span className={cn('font-mono text-[0.625rem] tracking-widest uppercase', statusTone(run.status))}>
          {t(statusLabel(run.status))}
        </span>
        <span className="font-mono text-[0.6875rem] text-dust">
          {formatRelativeTime(run.started_at, locale)}
        </span>
      </span>
      {run.detail ? <span className="text-sm text-smoke">{run.detail}</span> : null}
    </li>
  )
}

function CreateDialog({
  open,
  busy,
  onClose,
  onCreate,
}: {
  open: boolean
  busy: boolean
  onClose: () => void
  onCreate: (input: AutomationInput) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('Nightly restart')
  const [action, setAction] = useState<AutomationAction>('restart')
  const [kind, setKind] = useState<AutomationScheduleKind>('times')
  const [time, setTime] = useState('04:00')
  const [every, setEvery] = useState(240)
  const [message, setMessage] = useState('')
  const [configKey, setConfigKey] = useState('MaxPlayers')
  const [configValue, setConfigValue] = useState('16')
  const [warnSeconds, setWarnSeconds] = useState(300)
  const [warnMessage, setWarnMessage] = useState('')

  function pickAction(next: AutomationAction) {
    setAction(next)
    setWarnSeconds(defaultWarn(next))
  }

  return (
    <ConfirmDialog
      open={open}
      size="xl"
      title={t('admin.automations_new')}
      description={
        <div className="flex flex-col gap-5">
          <Field label={t('admin.automations_name')} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />

          <section className="flex flex-col gap-3">
            <h3 className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
              {t('admin.automations_what')}
            </h3>
            <ActionPicker action={action} onChange={pickAction} />
            <ActionFields
              action={action}
              message={message}
              onMessage={setMessage}
              configKey={configKey}
              configValue={configValue}
              onConfigKey={setConfigKey}
              onConfigValue={setConfigValue}
            />
          </section>

          <section className="flex flex-col gap-3">
            <ChipGroup label={t('admin.automations_schedule')} items={KINDS} value={kind} onChange={setKind} />
            {kind === 'times' ? (
              <Field type="time" label={t('admin.automations_times')} value={time} onChange={(event) => setTime(event.target.value)} />
            ) : (
              <Field
                type="number"
                min={5}
                max={10080}
                label={t('admin.automations_every_minutes')}
                value={every}
                onChange={(event) => setEvery(Number(event.target.value) || 5)}
              />
            )}
          </section>

          {DISRUPTIVE.has(action) ? (
            <section className="flex flex-col gap-3">
              <fieldset>
                <legend className="mb-2 font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
                  {t('admin.automations_warn')}
                </legend>
                <div className="flex flex-wrap gap-1.5">
                  {WARNINGS.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setWarnSeconds(item)}
                      className={cn(
                        'border px-2 py-1 font-mono text-[0.6875rem]',
                        warnSeconds === item
                          ? 'border-hazard bg-hazard-soft text-hazard'
                          : 'border-fence text-dust hover:border-fence-bright hover:text-bone',
                      )}
                    >
                      {item === 0 ? t('admin.backups_now') : t('admin.backups_minutes', { count: item / 60 })}
                    </button>
                  ))}
                </div>
              </fieldset>
              {warnSeconds > 0 ? (
                <Field
                  label={t('admin.automations_warn_message')}
                  value={warnMessage}
                  onChange={(event) => setWarnMessage(event.target.value)}
                  maxLength={240}
                />
              ) : null}
            </section>
          ) : null}
        </div>
      }
      confirmLabel={t('admin.automations_new')}
      busy={busy}
      confirmDisabled={name.trim().length === 0 || missingRequired(action, message, configKey)}
      onConfirm={() =>
        onCreate({
          name: name.trim(),
          enabled: true,
          action,
          message: messageFor(action, message, configKey, configValue),
          schedule_kind: kind,
          times: kind === 'times' ? [time] : [],
          every_minutes: kind === 'every' ? every : undefined,
          warn_seconds: DISRUPTIVE.has(action) ? warnSeconds : 0,
          warn_message: warnMessage.trim() || null,
        })
      }
      onClose={onClose}
    />
  )
}

function ActionPicker({
  action,
  onChange,
}: {
  action: AutomationAction
  onChange: (action: AutomationAction) => void
}) {
  const { t } = useTranslation()
  const current = findAction(action)
  const group = current?.group ?? 'machine'
  const inGroup = ACTIONS.filter((item) => item.group === group)

  return (
    <div className="flex flex-col gap-3">
      <TabStrip
        label={t('admin.automations_what')}
        items={GROUPS.map((item) => ({ id: item.id, label: t(item.label) }))}
        active={group}
        onSelect={(next) => {
          const first = ACTIONS.find((item) => item.group === next)
          if (first) {
            onChange(first.id)
          }
        }}
      />
      <ChipGroup
        label={t('admin.automations_action')}
        items={inGroup}
        value={action}
        onChange={onChange}
      />
      {current ? <p className="text-xs text-dust">{t(current.hint)}</p> : null}
    </div>
  )
}

function ActionFields({
  action,
  message,
  onMessage,
  configKey,
  configValue,
  onConfigKey,
  onConfigValue,
}: {
  action: AutomationAction
  message: string
  onMessage: (value: string) => void
  configKey?: string
  configValue?: string
  onConfigKey?: (value: string) => void
  onConfigValue?: (value: string) => void
}) {
  const { t } = useTranslation()
  const parsed = splitConfig(message)
  const key = configKey ?? parsed.key
  const value = configValue ?? parsed.value

  if (action === 'config') {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t('admin.automations_config_key')}
          value={key}
          onChange={(event) => {
            if (onConfigKey) {
              onConfigKey(event.target.value)
              return
            }
            onMessage(joinConfig(event.target.value, value))
          }}
          maxLength={80}
        />
        <Field
          label={t('admin.automations_config_value')}
          value={value}
          onChange={(event) => {
            if (onConfigValue) {
              onConfigValue(event.target.value)
              return
            }
            onMessage(joinConfig(key, event.target.value))
          }}
          maxLength={400}
        />
      </div>
    )
  }

  if (!needsCopy(action) && !optionalCopy(action)) {
    return null
  }

  const label =
    action === 'rcon'
      ? t('admin.automations_command')
      : action === 'backup' || action === 'cycle'
        ? t('admin.automations_notes')
        : t('admin.automations_message')

  return (
    <TextAreaField
      label={label}
      value={message}
      onChange={(event) => onMessage(event.target.value)}
      maxLength={500}
      className="min-h-20"
    />
  )
}

function ChipGroup<Id extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string
  items: { id: Id; label: TranslationKey }[]
  value: Id
  onChange: (id: Id) => void
}) {
  const { t } = useTranslation()
  return (
    <fieldset>
      <legend className="mb-2 font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            aria-pressed={value === item.id}
            className={cn(
              'border px-2 py-1 font-mono text-[0.6875rem] tracking-widest uppercase',
              value === item.id
                ? 'border-hazard bg-hazard-soft text-hazard'
                : 'border-fence text-dust hover:border-fence-bright hover:text-bone',
            )}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

function toDraft(job: Automation) {
  return {
    name: job.name,
    enabled: job.enabled,
    action: (ACTIONS.some((item) => item.id === job.action) ? job.action : 'restart') as AutomationAction,
    kind: (job.schedule_kind === 'every' ? 'every' : 'times') as AutomationScheduleKind,
    times: job.times,
    every: job.every_minutes ?? 60,
    message: job.message ?? '',
    warn_seconds: job.warn_seconds,
    warn_message: job.warn_message ?? '',
  }
}
