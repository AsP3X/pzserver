import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'

import { BuyOfferDialog } from '@/components/ui/buy-offer-dialog'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, type AuctionListing, type BuyOffer } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import {
  adminAuctionBidsQuery,
  adminAuctionsQuery,
  adminBuyOffersQuery,
  adminStoreQuery,
} from '@/lib/queries'
import { storeOnSale, storeUnitPrice } from '@/lib/store-price'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

const FILTERS: { id: string; label: TranslationKey }[] = [
  { id: 'open', label: 'economy.status_live' },
  { id: 'all', label: 'common.all' },
  { id: 'offers', label: 'economy.buy_offers' },
  { id: 'collecting', label: 'economy.status_collecting' },
  { id: 'sold', label: 'economy.status_sold' },
  { id: 'filled', label: 'economy.status_filled' },
  { id: 'cancelled', label: 'economy.status_cancelled' },
  { id: 'expired', label: 'economy.status_expired' },
  { id: 'failed', label: 'economy.status_failed' },
]

type Row =
  | { key: string; kind: 'listing'; listing: AuctionListing; status: string; created: string }
  | { key: string; kind: 'offer'; offer: BuyOffer; status: string; created: string }

function statusKey(status: string): TranslationKey {
  if (status === 'collecting') return 'economy.status_collecting'
  if (status === 'sold') return 'economy.status_sold'
  if (status === 'filled') return 'economy.status_filled'
  if (status === 'expired') return 'economy.status_expired'
  if (status === 'cancelled') return 'economy.status_cancelled'
  if (status === 'failed') return 'economy.status_failed'
  return 'economy.status_live'
}

function statusTone(status: string): string {
  if (status === 'live') return 'text-moss'
  if (status === 'collecting') return 'text-hazard'
  if (status === 'filled') return 'text-moss'
  if (status === 'failed' || status === 'cancelled') return 'text-blood'
  return 'text-dust'
}

function matches(filter: string, row: Row): boolean {
  if (filter === 'all') return true
  if (filter === 'offers') return row.kind === 'offer'
  if (filter === 'open') return row.status === 'live' || row.status === 'collecting'
  if (filter === 'sold') return row.status === 'sold' || row.status === 'filled'
  return row.status === filter
}

/**
 * Staff view of the auction house. Every lot, every bid, buy offers, and a
 * pull that refunds the high bidder or returns escrowed coins.
 */
export function AdminAuctionsPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const list = useQuery(adminAuctionsQuery)
  const offerList = useQuery(adminBuyOffersQuery)
  const catalogue = useQuery(adminStoreQuery)
  const staffLots = (catalogue.data ?? []).filter((item) => item.active)
  const [filter, setFilter] = useState('open')
  const [selected, setSelected] = useState<string | null>(null)
  const [pull, setPull] = useState<AuctionListing | null>(null)
  const [pullOffer, setPullOffer] = useState<BuyOffer | null>(null)
  const [offering, setOffering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const rows = useMemo<Row[]>(() => {
    const listings = (list.data ?? []).map((listing) => ({
      key: `listing:${listing.id}`,
      kind: 'listing' as const,
      listing,
      status: listing.status,
      created: listing.created_at,
    }))
    const offers = (offerList.data ?? []).map((offer) => ({
      key: `offer:${offer.id}`,
      kind: 'offer' as const,
      offer,
      status: offer.status,
      created: offer.created_at,
    }))
    return [...listings, ...offers].sort((left, right) => right.created.localeCompare(left.created))
  }, [list.data, offerList.data])

  const lots = rows.filter((row) => matches(filter, row))
  const current = rows.find((row) => row.key === selected) ?? lots[0] ?? null
  const currentListing = current?.kind === 'listing' ? current.listing : null
  const currentOffer = current?.kind === 'offer' ? current.offer : null
  const bids = useQuery(adminAuctionBidsQuery(currentListing?.id ?? ''))

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'auctions'] })
  }

  function fail(cause: unknown) {
    setNotice(null)
    setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
  }

  const pulled = useMutation({
    mutationFn: (id: string) => api.adminCancelAuction(id),
    onSuccess: async () => {
      setPull(null)
      setError(null)
      setNotice(t('economy.cancelled'))
      await refresh()
    },
    onError: fail,
  })

  const pulledOffer = useMutation({
    mutationFn: (id: string) => api.adminCancelBuyOffer(id),
    onSuccess: async () => {
      setPullOffer(null)
      setError(null)
      setNotice(t('economy.cancelled'))
      await refresh()
    },
    onError: fail,
  })

  const posted = useMutation({
    mutationFn: api.adminPostBuyOffer,
    onSuccess: async (offer) => {
      setOffering(false)
      setSelected(`offer:${offer.id}`)
      setError(null)
      setNotice(t('economy.buy_offer_posted'))
      await refresh()
    },
    onError: fail,
  })

  const canPullListing =
    currentListing !== null &&
    (currentListing.status === 'live' || currentListing.status === 'collecting')
  const canPullOffer =
    currentOffer !== null && (currentOffer.status === 'live' || currentOffer.status === 'collecting')
  const loading = list.isPending || offerList.isPending

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.shop')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('economy.admin_auctions_title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('economy.admin_auctions_description')}</p>
        </div>
        <Button size="sm" onClick={() => setOffering(true)}>
          <Plus aria-hidden="true" className="size-3.5" />
          {t('economy.post_buy_offer')}
        </Button>
      </header>

      {notice ? (
        <p role="status" className="border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}

      {staffLots.length > 0 ? (
        <Panel bracketed className="shrink-0">
          <PanelHeader
            label={t('economy.official')}
            action={
              <Link
                to="/admin/shop"
                className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase hover:text-hazard"
              >
                {t('economy.catalogue')}
              </Link>
            }
          />
          <ul className="divide-y divide-fence">
            {staffLots.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-bone">{item.name}</span>
                  <span className="font-mono text-[0.6875rem] text-dust">{item.item_type}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end">
                  <span className="font-mono text-sm text-hazard">
                    {t('economy.coins', { count: storeUnitPrice(item) })}
                  </span>
                  {storeOnSale(item) ? (
                    <span className="font-mono text-[0.625rem] text-dust">
                      {t('economy.off', { count: item.discount_percent })}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

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

      {loading ? (
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
                  <li key={row.key}>
                    <button
                      type="button"
                      onClick={() => setSelected(row.key)}
                      className={cn(
                        'flex w-full flex-col items-start gap-1 px-4 py-3 text-left',
                        row.key === current?.key ? 'bg-hazard-soft' : 'hover:bg-ash-raised',
                      )}
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="truncate text-sm text-bone">
                          {row.kind === 'listing' ? row.listing.item_name : row.offer.item_name}
                          {(row.kind === 'listing' ? row.listing.quantity : row.offer.quantity) > 1
                            ? ` ×${row.kind === 'listing' ? row.listing.quantity : row.offer.quantity}`
                            : ''}
                        </span>
                        <span
                          className={cn(
                            'shrink-0 font-mono text-[0.625rem] tracking-widest uppercase',
                            statusTone(row.status),
                          )}
                        >
                          {t(statusKey(row.status))}
                        </span>
                      </span>
                      <span className="font-mono text-[0.6875rem] text-dust">
                        {row.kind === 'listing'
                          ? `${row.listing.seller} · ${t('economy.coins', { count: row.listing.current_price })}`
                          : `${t('economy.wants')} · ${row.offer.staff ? t('economy.staff_seller') : row.offer.buyer} · ${t('economy.coins', { count: row.offer.price })}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel bracketed className="flex min-h-0 flex-col overflow-y-auto">
            {currentListing ? (
              <>
                <PanelHeader
                  label={currentListing.item_name}
                  action={
                    <span className={cn('font-mono text-[0.6875rem] uppercase', statusTone(currentListing.status))}>
                      {t(statusKey(currentListing.status))}
                    </span>
                  }
                />
                <div className="flex flex-col gap-4 p-5">
                  <dl className="grid gap-2 text-sm sm:grid-cols-2">
                    <Fact label={t('economy.item_type')} value={currentListing.item_type} />
                    <Fact label={t('economy.seller')} value={currentListing.seller} />
                    <Fact
                      label={t('economy.current_bid')}
                      value={`${t('economy.coins', { count: currentListing.current_price })}${
                        currentListing.current_bidder ? ` · ${currentListing.current_bidder}` : ''
                      }`}
                    />
                    <Fact
                      label={t('economy.buyout')}
                      value={
                        currentListing.buyout_price
                          ? t('economy.coins', { count: currentListing.buyout_price })
                          : t('economy.no_buyout')
                      }
                    />
                    <Fact
                      label={t('economy.ends')}
                      value={formatDateTime(currentListing.ends_at, intlLocale)}
                    />
                    <Fact label={t('economy.bids')} value={String(currentListing.bid_count)} />
                  </dl>
                  {canPullListing ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-fit border-blood text-blood"
                      onClick={() => setPull(currentListing)}
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
            ) : currentOffer ? (
              <>
                <PanelHeader
                  label={currentOffer.item_name}
                  action={
                    <span className={cn('font-mono text-[0.6875rem] uppercase', statusTone(currentOffer.status))}>
                      {t(statusKey(currentOffer.status))}
                    </span>
                  }
                />
                <div className="flex flex-col gap-4 p-5">
                  <dl className="grid gap-2 text-sm sm:grid-cols-2">
                    <Fact label={t('economy.item_type')} value={currentOffer.item_type} />
                    <Fact
                      label={t('economy.buyer')}
                      value={currentOffer.staff ? t('economy.staff_seller') : currentOffer.buyer}
                    />
                    <Fact
                      label={t('economy.price')}
                      value={t('economy.coins', { count: currentOffer.price })}
                    />
                    <Fact label={t('economy.quantity')} value={String(currentOffer.quantity)} />
                    <Fact
                      label={t('economy.ends')}
                      value={formatDateTime(currentOffer.ends_at, intlLocale)}
                    />
                    {currentOffer.filler ? (
                      <Fact label={t('economy.seller')} value={currentOffer.filler} />
                    ) : null}
                  </dl>
                  {canPullOffer ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-fit border-blood text-blood"
                      onClick={() => setPullOffer(currentOffer)}
                    >
                      {t('economy.pull_offer')}
                    </Button>
                  ) : null}
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

      <ConfirmDialog
        open={pullOffer !== null}
        title={t('economy.pull_offer')}
        description={t('economy.pull_offer_body', {
          name: pullOffer?.item_name ?? '',
          buyer: pullOffer?.buyer ?? '',
        })}
        confirmLabel={t('economy.pull_offer')}
        tone="danger"
        busy={pulledOffer.isPending}
        onConfirm={() => pullOffer && pulledOffer.mutate(pullOffer.id)}
        onClose={() => setPullOffer(null)}
      />

      <BuyOfferDialog
        open={offering}
        staff
        available={0}
        busy={posted.isPending}
        onClose={() => setOffering(false)}
        onSubmit={(input) => posted.mutate(input)}
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
