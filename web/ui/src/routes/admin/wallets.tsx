import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, type WalletTransaction } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatCoins, formatDateTime } from '@/lib/format'
import { adminWalletTransactionsQuery, adminWalletsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

const SOURCES: Record<string, TranslationKey> = {
  admin: 'economy.source_admin',
  store: 'economy.source_store',
  store_refund: 'economy.source_store_refund',
  auction_escrow: 'economy.source_auction_escrow',
  auction_refund: 'economy.source_auction_refund',
  auction_sale: 'economy.source_auction_sale',
  daily_reward: 'economy.source_daily_reward',
  quest: 'economy.source_quest',
  level: 'economy.source_level',
  vault_fee: 'economy.source_vault_fee',
  vault_upgrade: 'economy.source_vault_upgrade',
}

const FILTERS: { id: string; label: TranslationKey }[] = [
  { id: 'all', label: 'common.all' },
  { id: 'store', label: 'economy.filter_store' },
  { id: 'auction', label: 'economy.filter_auction' },
  { id: 'vault', label: 'economy.filter_vault' },
  { id: 'admin', label: 'economy.filter_admin' },
  { id: 'other', label: 'economy.filter_other' },
]

function sourceKey(source: string): TranslationKey | null {
  return SOURCES[source] ?? null
}

function matchesFilter(filter: string, source: string): boolean {
  if (filter === 'all') return true
  if (filter === 'store') return source.startsWith('store')
  if (filter === 'auction') return source.startsWith('auction')
  if (filter === 'vault') return source.startsWith('vault')
  if (filter === 'admin') return source === 'admin'
  return (
    !source.startsWith('store') &&
    !source.startsWith('auction') &&
    !source.startsWith('vault') &&
    source !== 'admin'
  )
}

/**
 * Staff view of every account's coins and the full movement list.
 */
export function AdminWalletsPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const list = useQuery(adminWalletsQuery)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [amount, setAmount] = useState('50')
  const [reason, setReason] = useState('')
  const [filter, setFilter] = useState('all')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const rows = list.data ?? []
  const current = rows.find((row) => row.user_id === selectedId) ?? rows[0] ?? null
  const ledger = useQuery(adminWalletTransactionsQuery(current?.user_id ?? ''))

  const shown = useMemo(
    () => (ledger.data ?? []).filter((row) => matchesFilter(filter, row.source)),
    [ledger.data, filter],
  )

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'wallets'] })
  }

  const adjust = useMutation({
    mutationFn: (delta: number) => {
      if (!current) throw new Error('missing wallet')
      return api.adminAdjustWallet(current.user_id, delta, reason || undefined)
    },
    onSuccess: async () => {
      setNotice(t('economy.adjusted'))
      setError(null)
      setReason('')
      await refresh()
    },
    onError: (cause) => {
      setNotice(null)
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header>
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="hazard-tape h-1 w-8" />
          <span className="eyebrow">{t('nav.group.shop')}</span>
        </div>
        <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('economy.wallets_title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-smoke">{t('economy.wallets_description')}</p>
      </header>

      {notice ? (
        <p role="status" className="border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}

      {list.isPending ? (
        <Skeleton className="min-h-0 flex-1" />
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
          <Panel bracketed className="flex min-h-0 flex-col">
            <PanelHeader
              label={t('economy.wallets_title')}
              action={
                <span className="font-mono text-[0.6875rem] text-dust">
                  {t('admin.backups_showing', { count: rows.length })}
                </span>
              }
            />
            {rows.length === 0 ? (
              <p className="p-5 text-sm text-dust">{t('economy.ledger_empty')}</p>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
                {rows.map((row) => (
                  <li key={row.user_id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(row.user_id)}
                      className={cn(
                        'flex w-full flex-col items-start gap-1 px-4 py-3 text-left',
                        row.user_id === current?.user_id ? 'bg-hazard-soft' : 'hover:bg-ash-raised',
                      )}
                    >
                      <span className="text-sm text-bone">{row.username}</span>
                      <span className="font-mono text-[0.6875rem] text-dust">
                        {t('economy.available')} {formatCoins(row.available, intlLocale)}
                        {' · '}
                        {t('economy.balance')} {formatCoins(row.balance, intlLocale)}
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
                <PanelHeader label={current.username} />
                <div className="grid gap-3 border-b border-fence p-5 sm:grid-cols-3">
                  <Fact
                    label={t('economy.available')}
                    value={formatCoins(current.available, intlLocale)}
                  />
                  <Fact
                    label={t('economy.balance')}
                    value={formatCoins(current.balance, intlLocale)}
                  />
                  <Fact
                    label={t('economy.held')}
                    value={formatCoins(current.balance - current.available, intlLocale)}
                  />
                </div>

                <form
                  className="flex flex-wrap items-end gap-3 border-b border-fence p-5"
                  onSubmit={(event) => {
                    event.preventDefault()
                    adjust.mutate(Math.abs(Number(amount) || 0))
                  }}
                >
                  <Field
                    type="number"
                    min={1}
                    label={t('economy.coins', { count: Number(amount) || 0 })}
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                  <Field
                    label={t('economy.reason')}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <Button type="submit" size="sm" disabled={adjust.isPending}>
                    {t('economy.credit')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="border-blood text-blood"
                    disabled={adjust.isPending}
                    onClick={() => adjust.mutate(-Math.abs(Number(amount) || 0))}
                  >
                    {t('economy.debit')}
                  </Button>
                </form>

                <PanelHeader
                  label={t('economy.ledger')}
                  action={
                    <span className="font-mono text-[0.6875rem] text-dust">
                      {t('economy.ledger_count', { count: shown.length })}
                    </span>
                  }
                />
                <div className="flex flex-wrap gap-1.5 px-5 pt-3">
                  {FILTERS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setFilter(item.id)}
                      className={cn(
                        'border px-2 py-1 font-mono text-[0.6875rem] tracking-widest uppercase',
                        filter === item.id
                          ? 'border-hazard bg-hazard-soft text-hazard'
                          : 'border-fence text-dust hover:border-fence-bright hover:text-bone',
                      )}
                    >
                      {t(item.label)}
                    </button>
                  ))}
                </div>
                {ledger.isPending ? (
                  <Skeleton className="m-5 h-24" />
                ) : shown.length === 0 ? (
                  <p className="p-5 text-sm text-dust">{t('economy.ledger_empty')}</p>
                ) : (
                  <LedgerList rows={shown} locale={intlLocale} />
                )}
              </>
            ) : (
              <>
                <PanelHeader label={t('economy.wallets_title')} />
                <p className="p-5 text-sm text-dust">{t('economy.ledger_empty')}</p>
              </>
            )}
          </Panel>
        </div>
      )}
    </section>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">{label}</dt>
      <dd className="mt-1 font-mono text-lg text-bone">{value}</dd>
    </div>
  )
}

function LedgerList({ rows, locale }: { rows: WalletTransaction[]; locale: string }) {
  const { t } = useTranslation()
  return (
    <ul className="divide-y divide-fence">
      {rows.map((row) => {
        const label = sourceKey(row.source)
        return (
          <li
            key={row.id}
            className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="text-sm text-bone">{row.description ?? (label ? t(label) : row.source)}</p>
              <p className="font-mono text-[0.6875rem] text-dust">
                {formatDateTime(row.created_at, locale)}
                {' · '}
                {label ? t(label) : row.source}
                {' · '}
                {t('economy.balance_after')} {formatCoins(row.balance_after, locale)}
              </p>
            </div>
            <span
              className={cn(
                'shrink-0 font-mono text-sm',
                row.kind === 'credit' ? 'text-moss' : 'text-blood',
              )}
            >
              {row.kind === 'credit' ? '+' : '−'}
              {formatCoins(row.amount, locale)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
