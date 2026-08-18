import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError } from '@/components/ui/field'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import { api, ApiError, type BridgeFileStatus, type MoneyDeposit } from '@/lib/api'
import { formatCoins, formatRelativeTime } from '@/lib/format'
import { adminBridgeQuery, adminDepositsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

const REASONS: Record<string, TranslationKey> = {
  'admin.bridge_reason_world_live': 'admin.bridge_reason_world_live',
  'admin.bridge_reason_world_stale': 'admin.bridge_reason_world_stale',
  'admin.bridge_reason_world_absent': 'admin.bridge_reason_world_absent',
  'admin.bridge_reason_live': 'admin.bridge_reason_live',
  'admin.bridge_reason_paused': 'admin.bridge_reason_paused',
  'admin.bridge_reason_heartbeat_stale': 'admin.bridge_reason_heartbeat_stale',
  'admin.bridge_reason_heartbeat_absent': 'admin.bridge_reason_heartbeat_absent',
  'admin.bridge_reason_event_ready': 'admin.bridge_reason_event_ready',
  'admin.bridge_reason_event_waiting': 'admin.bridge_reason_event_waiting',
}

/**
 * Whether the mod is still writing, and which silences are expected.
 *
 * Live positions and stats ride the in-game clock. On an empty server with
 * PauseEmpty they stop, which is not a broken bridge — the world file keeps
 * rewriting. Deaths and account-link files appear the first time they are
 * needed.
 */
export function AdminBridgePage() {
  const { t, intlLocale } = useTranslation()
  const { data, isPending, isError, refetch } = useQuery(adminBridgeQuery)

  return (
    <Section className="py-10">
      <Container>
        <SectionHeading
          eyebrow={t('nav.group.server')}
          title={t('admin.bridge_title')}
          description={t('admin.bridge_description')}
        />

        {isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : isError ? (
          <div>
            <FormError>{t('common.error')}</FormError>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => void refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {data?.world_paused && data.world_fresh ? (
              <p
                role="status"
                className="border border-hazard/40 bg-hazard-soft px-4 py-3 text-sm text-hazard"
              >
                {t('admin.bridge_world_paused')}
              </p>
            ) : null}

            <Panel bracketed>
              <PanelHeader
                label={t('admin.bridge_files')}
                action={
                  <span
                    className="max-w-[16rem] truncate font-mono text-[0.6875rem] text-dust"
                    title={data?.directory}
                  >
                    {data?.directory}
                  </span>
                }
              />
              <ul className="divide-y divide-fence">
                {(data?.files ?? []).map((file) => (
                  <li key={file.name} className="flex items-start justify-between gap-4 px-4 py-4">
                    <div className="min-w-0">
                      <p className="font-mono text-sm text-bone">{file.name}</p>
                      <p className="mt-1 text-xs leading-relaxed text-dust">
                        {t(REASONS[file.reason] ?? 'admin.bridge_reason_unknown')}
                      </p>
                      {file.modified_at ? (
                        <p className="mt-1 font-mono text-[0.6875rem] text-dust">
                          {formatRelativeTime(file.modified_at, intlLocale)}
                        </p>
                      ) : null}
                    </div>
                    <span
                      className={cn(
                        'shrink-0 font-mono text-[0.6875rem] tracking-widest uppercase',
                        statusTone(file.status),
                      )}
                    >
                      {t(statusLabel(file.status))}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>

            <DepositsPanel />
          </div>
        )}
      </Container>
    </Section>
  )
}

/**
 * The cash-deposit queue and the rates it prices at.
 *
 * Lives on the bridge page because both halves are the mod's files rather than
 * our database: the rates are `money_deposit_config.json`, and a pending row is
 * an entry in `deposit_requests.json` the mod has not reached yet.
 */
function DepositsPanel() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isPending } = useQuery(adminDepositsQuery)

  const [noteValue, setNoteValue] = useState<string | null>(null)
  const [bundleValue, setBundleValue] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [payTarget, setPayTarget] = useState<MoneyDeposit | null>(null)

  // Null until the admin types, so a background refetch never overwrites a
  // half-edited rate under their cursor.
  const notes = noteValue ?? String(data?.rates.money_value ?? '')
  const bundles = bundleValue ?? String(data?.rates.bundle_value ?? '')

  function fail(cause: unknown) {
    setNotice(null)
    setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
  }

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'deposits'] })
  }

  const saveRates = useMutation({
    mutationFn: () =>
      api.adminSetDepositRates({
        money_value: Number(notes),
        bundle_value: Number(bundles),
      }),
    onSuccess: () => {
      setError(null)
      setNotice(t('economy.deposit_rates_saved'))
      setNoteValue(null)
      setBundleValue(null)
      refresh()
    },
    onError: fail,
  })

  const cancel = useMutation({
    mutationFn: (id: string) => api.adminCancelDeposit(id),
    onSuccess: () => {
      setError(null)
      setNotice(null)
      refresh()
    },
    onError: fail,
  })

  const payByHand = useMutation({
    mutationFn: ({ id, coins }: { id: string; coins: number }) =>
      api.adminCreditDeposit(id, coins),
    onSuccess: () => {
      setError(null)
      setPayTarget(null)
      refresh()
    },
    onError: fail,
  })

  const ratesUnchanged =
    Number(notes) === data?.rates.money_value && Number(bundles) === data?.rates.bundle_value

  return (
    <Panel bracketed>
      <PanelHeader label={t('economy.deposit_admin_title')} />

      <div className="border-b border-fence p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label={t('economy.deposit_note_value')}
            type="number"
            min={0}
            className="w-32"
            value={notes}
            onChange={(event) => setNoteValue(event.target.value)}
          />
          <Field
            label={t('economy.deposit_bundle_value')}
            type="number"
            min={0}
            className="w-32"
            value={bundles}
            onChange={(event) => setBundleValue(event.target.value)}
          />
          <Button
            size="sm"
            className="mb-0.5"
            disabled={saveRates.isPending || ratesUnchanged}
            onClick={() => saveRates.mutate()}
          >
            {saveRates.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>

        {notice ? (
          <p role="status" className="mt-3 text-sm text-moss">
            {notice}
          </p>
        ) : null}
        {error ? (
          <div className="mt-3">
            <FormError>{error}</FormError>
          </div>
        ) : null}
      </div>

      {isPending ? (
        <Skeleton className="m-4 h-24" />
      ) : (data?.deposits ?? []).length === 0 ? (
        <p className="p-4 text-sm text-dust">{t('economy.deposit_none')}</p>
      ) : (
        <ul className="divide-y divide-fence">
          {(data?.deposits ?? []).map((row) => (
            <li key={row.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="font-mono text-sm text-bone">{row.username}</p>
                <p className="mt-1 text-xs text-dust">
                  {t('economy.deposit_carrying', {
                    notes: row.note_count,
                    bundles: row.bundle_count,
                    coins: formatCoins(row.coins, intlLocale),
                  })}
                </p>
                {row.detail ? (
                  <p className="mt-1 text-xs text-hazard">{row.detail}</p>
                ) : null}
                <p className="mt-1 font-mono text-[0.6875rem] text-dust">
                  {formatRelativeTime(row.created_at, intlLocale)}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={cn(
                    'font-mono text-[0.6875rem] tracking-widest uppercase',
                    depositTone(row.status),
                  )}
                >
                  {row.status}
                </span>

                {row.status === 'pending' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={cancel.isPending}
                    onClick={() => cancel.mutate(row.id)}
                  >
                    {t('economy.deposit_cancel')}
                  </Button>
                ) : null}

                {/* Only a deposit the mod finished but we never paid. */}
                {row.status === 'failed' && row.wallet_transaction_id === null ? (
                  <Button size="sm" variant="outline" onClick={() => setPayTarget(row)}>
                    {t('economy.deposit_credit')}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={payTarget !== null}
        title={t('economy.deposit_credit')}
        description={
          payTarget
            ? t('economy.deposit_carrying', {
                notes: payTarget.note_count,
                bundles: payTarget.bundle_count,
                coins: formatCoins(
                  payTarget.note_count * payTarget.note_value +
                    payTarget.bundle_count * payTarget.bundle_value,
                  intlLocale,
                ),
              })
            : ''
        }
        confirmLabel={t('economy.deposit_credit')}
        busy={payByHand.isPending}
        onClose={() => setPayTarget(null)}
        onConfirm={() => {
          if (!payTarget) {
            return
          }

          payByHand.mutate({
            id: payTarget.id,
            coins:
              payTarget.note_count * payTarget.note_value +
              payTarget.bundle_count * payTarget.bundle_value,
          })
        }}
      />
    </Panel>
  )
}

function depositTone(status: string): string {
  if (status === 'credited') return 'text-moss'
  if (status === 'pending') return 'text-hazard'
  if (status === 'failed') return 'text-blood'
  return 'text-dust'
}

function statusLabel(status: BridgeFileStatus): TranslationKey {
  if (status === 'fresh') return 'admin.bridge_fresh'
  if (status === 'idle') return 'admin.bridge_idle'
  if (status === 'stale') return 'admin.bridge_stale'
  return 'admin.bridge_absent'
}

function statusTone(status: BridgeFileStatus): string {
  if (status === 'fresh') return 'text-moss'
  if (status === 'idle') return 'text-smoke'
  if (status === 'stale') return 'text-hazard'
  return 'text-dust'
}
