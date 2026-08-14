import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, type VaultSettings } from '@/lib/api'
import { cn } from '@/lib/cn'
import { adminVaultQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

/**
 * Staff controls for the player locker: size, retrieve fee, upgrade price.
 */
export function AdminVaultPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const data = useQuery(adminVaultQuery)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState<VaultSettings | null>(null)

  const settings = draft ?? data.data?.settings ?? null
  const rows = data.data?.vaults ?? []

  const save = useMutation({
    mutationFn: (input: VaultSettings) => api.adminUpdateVault(input),
    onSuccess: async () => {
      setNotice(t('economy.saved'))
      setError(null)
      setDraft(null)
      await queryClient.invalidateQueries({ queryKey: ['admin', 'vault'] })
    },
    onError: (cause) => {
      setNotice(null)
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  function patch<K extends keyof VaultSettings>(key: K, value: VaultSettings[K]) {
    if (!settings) return
    setDraft({ ...settings, [key]: value })
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header>
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="hazard-tape h-1 w-8" />
          <span className="eyebrow">{t('nav.group.shop')}</span>
        </div>
        <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('vault.admin_title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-smoke">{t('vault.admin_description')}</p>
      </header>

      {notice ? (
        <p role="status" className="border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}

      {data.isPending || !settings ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(18rem,28rem)_minmax(0,1fr)]">
          <Panel bracketed className="flex min-h-0 flex-col overflow-y-auto">
            <PanelHeader label={t('vault.settings')} />
            <form
              className="flex flex-col gap-3 p-4"
              onSubmit={(event) => {
                event.preventDefault()
                save.mutate(settings)
              }}
            >
              <label className="flex items-center gap-2 text-sm text-bone">
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(event) => patch('enabled', event.target.checked)}
                />
                {t('vault.enabled')}
              </label>
              <Field
                type="number"
                min={1}
                max={2000}
                label={t('vault.default_slots')}
                value={settings.default_slots}
                onChange={(event) => patch('default_slots', Number(event.target.value) || 1)}
              />
              <Field
                type="number"
                min={1}
                max={2000}
                label={t('vault.max_slots')}
                value={settings.max_slots}
                onChange={(event) => patch('max_slots', Number(event.target.value) || 1)}
              />
              <Field
                type="number"
                min={1}
                max={200}
                label={t('vault.upgrade_increment')}
                value={settings.slot_upgrade_increment}
                onChange={(event) =>
                  patch('slot_upgrade_increment', Number(event.target.value) || 1)
                }
              />
              <Field
                type="number"
                min={1}
                label={t('vault.upgrade_cost')}
                value={settings.slot_upgrade_cost}
                onChange={(event) =>
                  patch('slot_upgrade_cost', Number(event.target.value) || 1)
                }
              />
              <Field
                type="number"
                min={0}
                label={t('vault.fee_flat')}
                value={settings.withdraw_fee_flat}
                onChange={(event) =>
                  patch('withdraw_fee_flat', Number(event.target.value) || 0)
                }
              />
              <Field
                type="number"
                min={0}
                label={t('vault.fee_per_item')}
                value={settings.withdraw_fee_per_item}
                onChange={(event) =>
                  patch('withdraw_fee_per_item', Number(event.target.value) || 0)
                }
              />
              <Button type="submit" size="sm" disabled={save.isPending}>
                {t('common.save')}
              </Button>
            </form>
          </Panel>

          <Panel bracketed className="flex min-h-0 flex-col">
            <PanelHeader
              label={t('vault.occupancy')}
              action={
                <span className="font-mono text-[0.6875rem] text-dust">
                  {rows.length}
                </span>
              }
            />
            {rows.length === 0 ? (
              <p className="p-6 text-sm text-dust">{t('vault.occupancy_empty')}</p>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
                {rows.map((row) => (
                  <li
                    key={row.user_id}
                    className="flex items-baseline justify-between gap-3 px-4 py-3"
                  >
                    <span className="truncate text-sm text-bone">{row.username}</span>
                    <span
                      className={cn(
                        'shrink-0 font-mono text-xs tabular-nums',
                        row.used >= row.total ? 'text-hazard' : 'text-dust',
                      )}
                    >
                      {row.used} / {row.total}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </section>
  )
}
