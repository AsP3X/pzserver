import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, type AuctionListing } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import { adminAuctionBidsQuery, adminAuctionsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

const FILTERS: { id: string; label: TranslationKey }[] = [
  { id: 'open', label: 'economy.status_live' },
  { id: 'all', label: 'common.all' },
  { id: 'collecting', label: 'economy.status_collecting' },
  { id: 'sold', label: 'economy.status_sold' },
  { id: 'cancelled', label: 'economy.status_cancelled' },
  { id: 'expired', label: 'economy.status_expired' },
  { id: 'failed', label: 'economy.status_failed' },
]

function statusKey(status: string): TranslationKey {
  if (status === 'collecting') return 'economy.status_collecting'
  if (status === 'sold') return 'economy.status_sold'
  if (status === 'expired') return 'economy.status_expired'
  if (status === 'cancelled') return 'economy.status_cancelled'
  if (status === 'failed') return 'economy.status_failed'
  return 'economy.status_live'
}

function statusTone(status: string): string {
  if (status === 'live') return 'text-moss'
  if (status === 'collecting') return 'text-hazard'
  if (status === 'failed' || status === 'cancelled') return 'text-blood'
  return 'text-dust'
}

function matches(filter: string, status: string): boolean {
  if (filter === 'all') return true
  if (filter === 'open') return status === 'live' || status === 'collecting'
  return status === filter
}

/**
 * Staff view of the auction house. Every lot, every bid, and a pull that
 * refunds the high bidder and sends the item home.
 */
export function AdminAuctionsPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const list = useQuery(adminAuctionsQuery)
  const [filter, setFilter] = useState('open')
  const [selected, setSelected] = useState<string | null>(null)
  const [pull, setPull] = useState<AuctionListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const lots = (list.data ?? []).filter((row) => matches(filter, row.status))
  const current = (list.data ?? []).find((row) => row.id === selected) ?? lots[0] ?? null
  const bids = useQuery(adminAuctionBidsQuery(current?.id ?? ''))

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'auctions'] })
  }

  const pulled = useMutation({
    mutationFn: (id: string) => api.adminCancelAuction(id),
    onSuccess: async () => {
      setPull(null)
      setError(null)
      setNotice(t('economy.cancelled'))
      await refresh()
    },
    onError: (cause) => {
      setNotice(null)
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  const canPull = current !== null && (current.status === 'live' || current.status === 'collecting')

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header>
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="hazard-tape h-1 w-8" />
          <span className="eyebrow">{t('nav.group.shop')}</span>
        </div>
        <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('economy.admin_auctions_title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-smoke">{t('economy.admin_auctions_description')}</p>
      </header>

      {notice ? (
        <p role="status" className="border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}

      <div className="flex flex-wrap gap-1.5">
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

      {list.isPending ? (
        <Skeleton className="min-h-0 flex-1" />
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(16rem,24rem)_minmax(0,1fr)]">
          <Panel bracketed className="flex min-h-0 flex-col">
            <PanelHeader
              label={t('economy.listings')}
              action={
                <span className="font-mono text-[0.6875rem] text-dust">
                  {t('admin.backups_showing', { count: lots.length })}
                </span>
              }
            />
            {lots.length === 0 ? (
              <p className="p-5 text-sm text-dust">{t('economy.admin_auctions_empty')}</p>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
                {lots.map((row) => (
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
                        <span className="truncate text-sm text-bone">
                          {row.item_name}
                          {row.quantity > 1 ? ` ×${row.quantity}` : ''}
                        </span>
                        <span className={cn('shrink-0 font-mono text-[0.625rem] tracking-widest uppercase', statusTone(row.status))}>
                          {t(statusKey(row.status))}
                        </span>
                      </span>
                      <span className="font-mono text-[0.6875rem] text-dust">
                        {row.seller} · {t('economy.coins', { count: row.current_price })}
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
                  label={current.item_name}
                  action={
                    <span className={cn('font-mono text-[0.6875rem] uppercase', statusTone(current.status))}>
                      {t(statusKey(current.status))}
                    </span>
                  }
                />
                <div className="flex flex-col gap-4 p-5">
                  <dl className="grid gap-2 text-sm sm:grid-cols-2">
                    <Fact label={t('economy.item_type')} value={current.item_type} />
                    <Fact label={t('economy.seller')} value={current.seller} />
                    <Fact
                      label={t('economy.current_bid')}
                      value={`${t('economy.coins', { count: current.current_price })}${
                        current.current_bidder ? ` · ${current.current_bidder}` : ''
                      }`}
                    />
                    <Fact
                      label={t('economy.buyout')}
                      value={
                        current.buyout_price
                          ? t('economy.coins', { count: current.buyout_price })
                          : t('economy.no_buyout')
                      }
                    />
                    <Fact label={t('economy.ends')} value={formatDateTime(current.ends_at, intlLocale)} />
                    <Fact label={t('economy.bids')} value={String(current.bid_count)} />
                  </dl>
                  {canPull ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-fit border-blood text-blood"
                      onClick={() => setPull(current)}
                    >
                      {t('economy.pull_listing')}
                    </Button>
                  ) : null}
                </div>
                <div className="border-t border-fence">
                  <PanelHeader label={t('economy.bids')} />
                  {bids.isPending ? (
                    <Skeleton className="m-5 h-20" />
                  ) : (bids.data ?? []).length === 0 ? (
                    <p className="p-5 text-sm text-dust">{t('economy.bids_empty')}</p>
                  ) : (
                    <ul className="divide-y divide-fence">
                      {(bids.data ?? []).map((bid) => (
                        <li key={bid.id} className="flex items-center justify-between gap-3 px-5 py-3">
                          <span className="text-sm text-bone">{bid.bidder}</span>
                          <span className="font-mono text-[0.6875rem] text-dust">
                            {t('economy.coins', { count: bid.amount })} · {formatRelativeTime(bid.created_at, intlLocale)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            ) : (
              <>
                <PanelHeader label={t('economy.listings')} />
                <p className="p-5 text-sm text-dust">{t('economy.admin_auctions_empty')}</p>
              </>
            )}
          </Panel>
        </div>
      )}

      <ConfirmDialog
        open={pull !== null}
        title={t('economy.pull_listing')}
        description={t('economy.pull_body', { name: pull?.item_name ?? '', seller: pull?.seller ?? '' })}
        confirmLabel={t('economy.pull_listing')}
        tone="danger"
        busy={pulled.isPending}
        onConfirm={() => pull && pulled.mutate(pull.id)}
        onClose={() => setPull(null)}
      />
    </section>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">{label}</dt>
      <dd className="mt-1 font-mono text-sm text-bone">{value}</dd>
    </div>
  )
}
