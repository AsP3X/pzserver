import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Clock, Crosshair, Download, Play, RotateCcw, Save, Server, Skull, Square, Trash2, Users } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Field, FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Sparkline } from '@/components/ui/sparkline'
import { StatTile } from '@/components/ui/stat-tile'
import { StatusPill } from '@/components/ui/status-pill'
import { api, ApiError, type UpdateReport } from '@/lib/api'
import { formatNumber, formatUptime } from '@/lib/format'
import {
  adminUpdateStatusQuery,
  serverHistoryQuery,
  serverStatusQuery,
  statsSummaryQuery,
} from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

/**
 * What an operator wants on opening the panel: is it up, who is on it, and has
 * anything changed. Controls live in their own sections — this page reports.
 */
export function AdminOverviewPage() {
  const { t, intlLocale } = useTranslation()
  const { data: status, isPending: statusPending } = useQuery(serverStatusQuery)
  const { data: stats } = useQuery(statsSummaryQuery)
  const { data: history } = useQuery(serverHistoryQuery)

  return (
    <Section className="py-10">
      <Container className="max-w-none">
        <SectionHeading
          eyebrow={t('nav.surface_admin')}
          title={t('admin.overview_title')}
          description={t('admin.overview_description')}
        />

        <div className="grid gap-6 xl:grid-cols-3">
          <Panel bracketed className="xl:col-span-2">
            <PanelHeader
              label={t('admin.server')}
              action={
                <StatusPill
                  state={statusPending ? undefined : status?.state}
                  label={
                    statusPending
                      ? t('status.checking')
                      : status
                        ? t(`status.${status.state}`)
                        : t('status.offline')
                  }
                />
              }
            />

            <div className="grid grid-cols-2 divide-x divide-y divide-fence 2xl:grid-cols-4 2xl:divide-y-0">
              <StatTile
                label={t('status.players_online')}
                value={
                  status
                    ? `${status.player_count}${status.max_players ? ` / ${status.max_players}` : ''}`
                    : undefined
                }
                icon={Users}
              />
              <StatTile
                label={t('status.uptime')}
                value={
                  status
                    ? status.uptime_seconds === null
                      ? '—'
                      : formatUptime(status.uptime_seconds, {
                          days: t('common.days_short'),
                          hours: t('common.hours_short'),
                          minutes: t('common.minutes_short'),
                        })
                    : undefined
                }
                icon={Clock}
              />
              <StatTile
                label={t('admin.container')}
                value={status ? status.container.replace('_', ' ') : undefined}
                icon={Server}
              />
              <StatTile
                label={t('admin.feed')}
                value={status ? t(`status.source_${status.data_source}`) : undefined}
                icon={Activity}
              />
            </div>

            <div className="border-t border-fence px-4 py-4">
              <span className="eyebrow">{t('status.activity_24h')}</span>
              {history && history.length > 1 ? (
                <Sparkline
                  className="mt-3"
                  values={history.map((sample) => sample.player_count)}
                  label={t('status.activity_24h')}
                />
              ) : (
                <p className="mt-3 text-xs text-dust">{t('status.no_activity')}</p>
              )}
            </div>
          </Panel>

          <Panel bracketed className="h-fit">
            <PanelHeader label={t('admin.world')} />

            <div className="grid grid-cols-2 divide-x divide-y divide-fence">
              <StatTile
                label={t('stats.total_players')}
                value={stats ? formatNumber(stats.total_players, intlLocale) : undefined}
                icon={Users}
              />
              <StatTile
                label={t('stats.deaths')}
                value={stats ? formatNumber(stats.total_deaths, intlLocale) : undefined}
                icon={Skull}
              />
              <StatTile
                label={t('stats.zombie_kills')}
                value={stats ? formatNumber(stats.total_zombie_kills, intlLocale) : undefined}
                icon={Crosshair}
              />
              <StatTile
                label={t('stats.pvp_kills')}
                value={stats ? formatNumber(stats.total_pvp_kills, intlLocale) : undefined}
                icon={Crosshair}
              />
            </div>
          </Panel>
        </div>

        <ServerControls />

        <Panel className="mt-6 border-dashed p-5">
          <p className="text-sm text-smoke">{t('admin.under_construction')}</p>
        </Panel>
      </Container>
    </Section>
  )
}

type PendingAction = 'stop' | 'restart' | 'save' | null

/**
 * Why the server is not serving, when the container itself looks fine.
 *
 * A halted install leaves the container up with the game deliberately held
 * down, which the status service can only report as `starting` — outwardly
 * identical to a slow world load. This banner is the only thing that tells
 * those two apart.
 */
function UpdateHealthBanner({ report }: { report?: UpdateReport }) {
  const { t } = useTranslation()

  if (!report || report.verdict === 'ok' || report.verdict === 'unknown') {
    return null
  }

  // `unverifiable` is the one bad verdict that still boots. It means we lost
  // the ability to tell whether the build is stale, not that it is — so it
  // warns in hazard yellow rather than alarming in blood red.
  const halted = !report.booted
  const title =
    report.verdict === 'unverifiable'
      ? t('admin.update.health_unverifiable_title')
      : halted
        ? t('admin.update.health_halted_title')
        : t('admin.update.health_stale_title')

  return (
    <div
      role="alert"
      className={
        halted
          ? 'border border-blood/40 bg-blood-soft px-3 py-2 text-sm text-blood'
          : 'border border-hazard/40 bg-hazard-soft px-3 py-2 text-sm text-hazard'
      }
    >
      <p className="font-semibold">{title}</p>
      {report.installed_build || report.target_build ? (
        <p className="mt-1 font-mono text-xs">
          {t('admin.update.health_builds', {
            installed: report.installed_build ?? '?',
            target: report.target_build ?? '?',
          })}
        </p>
      ) : null}
      {report.diagnosis ? <p className="mt-1 text-bone">{report.diagnosis}</p> : null}
      {report.auto_repaired ? (
        <p className="mt-1 text-bone">{t('admin.update.health_repairing')}</p>
      ) : null}
    </div>
  )
}

function ServerControls() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const { data: status } = useQuery(serverStatusQuery)
  const [pending, setPending] = useState<PendingAction>(null)
  const [wiping, setWiping] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [branch, setBranch] = useState('public')
  const [includeConfig, setIncludeConfig] = useState(false)
  const [wipeTyped, setWipeTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const running = status?.container === 'running'

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['server'] })
  }

  const start = useMutation({
    mutationFn: () => api.adminStart(),
    onSuccess: invalidate,
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error')),
  })

  const act = useMutation({
    mutationFn: async (action: Exclude<PendingAction, null>) => {
      if (action === 'stop') return api.adminStop()
      if (action === 'restart') return api.adminRestart()
      return api.adminSave()
    },
    onSuccess: () => {
      setPending(null)
      invalidate()
    },
    onError: (cause) => {
      setPending(null)
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  const updateStatus = useQuery(adminUpdateStatusQuery)

  const update = useMutation({
    mutationFn: () => api.adminUpdateServer({ branch, message: t('admin.update.broadcast') }),
    onSuccess: (result) => {
      setUpdating(false)
      setError(null)
      setNotice(result.message)
      invalidate()
    },
    onError: (cause) => {
      setUpdating(false)
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  const wipe = useMutation({
    mutationFn: () =>
      api.adminWipe({
        confirm: true,
        include_config: includeConfig,
        message: t('admin.wipe.broadcast'),
      }),
    onSuccess: (result) => {
      setWiping(false)
      setIncludeConfig(false)
      setWipeTyped('')
      setError(null)
      setNotice(result.message)
      invalidate()
      void queryClient.invalidateQueries()
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  return (
    <Panel bracketed className="mt-6">
      <PanelHeader label={t('admin.controls')} />
      <div className="flex flex-col gap-4 p-5">
        <p className="text-sm text-smoke">{t('admin.controls_hint')}</p>
        <UpdateHealthBanner report={updateStatus.data?.report} />
        {error ? <FormError>{error}</FormError> : null}
        {notice ? (
          <p role="status" className="border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
            {notice}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              setError(null)
              start.mutate()
            }}
            disabled={running || start.isPending}
          >
            <Play aria-hidden="true" className="size-3.5" />
            {t('admin.action.start')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setError(null)
              setPending('stop')
            }}
            disabled={!running || act.isPending}
          >
            <Square aria-hidden="true" className="size-3.5" />
            {t('admin.action.stop')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setError(null)
              setPending('restart')
            }}
            disabled={!running || act.isPending}
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
            {t('admin.action.restart')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setError(null)
              setPending('save')
            }}
            disabled={!running || act.isPending}
          >
            <Save aria-hidden="true" className="size-3.5" />
            {t('admin.action.save')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setError(null)
              setNotice(null)
              setBranch(updateStatus.data?.branch ?? 'public')
              setUpdating(true)
            }}
            disabled={update.isPending}
          >
            <Download aria-hidden="true" className="size-3.5" />
            {t('admin.update.button')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-blood text-blood hover:border-blood hover:text-blood"
            onClick={() => {
              setError(null)
              setNotice(null)
              setIncludeConfig(false)
              setWipeTyped('')
              setWiping(true)
            }}
            disabled={wipe.isPending}
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
            {t('admin.wipe.button')}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={pending !== null}
        title={
          pending === 'stop'
            ? t('admin.action.stop')
            : pending === 'restart'
              ? t('admin.action.restart')
              : t('admin.action.save')
        }
        description={
          pending === 'stop'
            ? t('admin.action.stop_confirm')
            : pending === 'restart'
              ? t('admin.action.restart_confirm')
              : t('admin.action.save_confirm')
        }
        tone={pending === 'stop' ? 'danger' : 'primary'}
        busy={act.isPending}
        onConfirm={() => pending && act.mutate(pending)}
        onClose={() => {
          if (!act.isPending) {
            setPending(null)
          }
        }}
      />

      <ConfirmDialog
        open={updating}
        title={t('admin.update.title')}
        size="lg"
        tone="danger"
        confirmLabel={t('admin.update.confirm')}
        busy={update.isPending}
        description={
          <div className="flex flex-col gap-3">
            <p>{t('admin.update.description')}</p>
            <label className="flex flex-col gap-2">
              <span className="eyebrow">{t('admin.update.branch')}</span>
              <select
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                className="h-11 border border-fence-bright bg-void px-3 font-mono text-sm text-bone"
              >
                {(updateStatus.data?.branches ?? ['public']).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            {updateStatus.data?.report.installed_build ? (
              <p className="text-sm text-dust">
                {t('admin.update.installed_build')}:{' '}
                <span className="font-mono text-bone">
                  {updateStatus.data.report.installed_build}
                </span>
                {updateStatus.data.report.last_updated
                  ? `, ${t('admin.update.health_last_checked', {
                      when: new Date(
                        updateStatus.data.report.last_updated * 1000,
                      ).toLocaleString(intlLocale),
                    })}`
                  : ''}
              </p>
            ) : null}
            <p className="text-sm text-dust">{t('admin.update.warning')}</p>
          </div>
        }
        onConfirm={() => update.mutate()}
        onClose={() => {
          if (!update.isPending) {
            setUpdating(false)
          }
        }}
      />

      <ConfirmDialog
        open={wiping}
        title={t('admin.wipe.title')}
        size="lg"
        tone="danger"
        confirmLabel={t('admin.wipe.confirm')}
        busy={wipe.isPending}
        confirmDisabled={wipeTyped.trim().toUpperCase() !== 'WIPE'}
        description={
          <div className="flex flex-col gap-3">
            <p>{t('admin.wipe.description')}</p>
            <ul className="list-disc pl-5 text-sm text-smoke">
              <li>{t('admin.wipe.destroys')}</li>
              <li>{t('admin.wipe.keeps')}</li>
            </ul>
            <label className="flex items-start gap-2 text-sm text-bone">
              <input
                type="checkbox"
                className="mt-1"
                checked={includeConfig}
                onChange={(event) => setIncludeConfig(event.target.checked)}
              />
              <span>{t('admin.wipe.include_config')}</span>
            </label>
            {includeConfig ? (
              <p className="border border-blood/40 bg-blood-soft px-3 py-2 text-sm text-blood">
                {t('admin.wipe.include_config_warning')}
              </p>
            ) : null}
            <Field
              label={t('admin.wipe.type_wipe')}
              value={wipeTyped}
              onChange={(event) => setWipeTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        }
        onConfirm={() => wipe.mutate()}
        onClose={() => {
          if (!wipe.isPending) {
            setWiping(false)
            setIncludeConfig(false)
            setWipeTyped('')
          }
        }}
      />
    </Panel>
  )
}
