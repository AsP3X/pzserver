import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Coins, Lock, Package, Search, Tag, Wallet } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { TabStrip } from '@/components/ui/tabs'
import {
  api,
  ApiError,
  type AuctionListing,
  type StoreItem,
  type StorePurchase,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatCoins, formatDateTime, formatRelativeTime } from '@/lib/format'
import { fuzzyMatchWords } from '@/lib/fuzzy'
import { stackItems } from '@/lib/inventory'
import { storeOnSale, storeUnitPrice } from '@/lib/store-price'
import {
  auctionsQuery,
  myAuctionsQuery,
  myInventoryQuery,
  myStorePurchasesQuery,
  myWalletQuery,
  storeItemsQuery,
} from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TabItem } from '@/components/ui/tabs'
import type { TranslationKey } from '@/i18n/locales'

const CATEGORIES: { id: string; label: TranslationKey }[] = [
  { id: 'all', label: 'common.all' },
  { id: 'official', label: 'economy.official' },
  { id: 'player', label: 'economy.player_lots' },
  { id: 'weapons', label: 'economy.category_weapons' },
  { id: 'ammo', label: 'economy.category_ammo' },
  { id: 'food', label: 'economy.category_food' },
  { id: 'medical', label: 'economy.category_medical' },
  { id: 'tools', label: 'economy.category_tools' },
  { id: 'clothing', label: 'economy.category_clothing' },
  { id: 'other', label: 'economy.category_other' },
]

type Kind = 'store' | 'auction'

interface Lot {
  key: string
  kind: Kind
  id: string
  name: string
  itemType: string
  category: string
  featured: boolean
  onSale: boolean
  sortOrder: number
  price: number
  haystack: string
  endsAt: string | null
  store: StoreItem | null
  auction: AuctionListing | null
}

function categoryLabel(category: string): TranslationKey {
  return CATEGORIES.find((item) => item.id === category)?.label ?? 'economy.category_other'
}

function purchaseStatusLabel(status: string): TranslationKey {
  if (status === 'delivered') return 'economy.status_delivered'
  if (status === 'queued') return 'economy.status_queued'
  if (status === 'failed') return 'economy.status_failed'
  return 'economy.status_pending'
}

function purchaseStatusTone(status: string): string {
  if (status === 'delivered') return 'text-moss'
  if (status === 'queued') return 'text-hazard'
  if (status === 'failed') return 'text-blood'
  return 'text-dust'
}

function auctionStatusLabel(status: string): TranslationKey {
  if (status === 'collecting') return 'economy.status_collecting'
  if (status === 'sold') return 'economy.status_sold'
  if (status === 'expired') return 'economy.status_expired'
  if (status === 'cancelled') return 'economy.status_cancelled'
  if (status === 'failed') return 'economy.status_failed'
  return 'economy.status_live'
}

function fromStore(item: StoreItem): Lot {
  return {
    key: `store:${item.id}`,
    kind: 'store',
    id: item.id,
    name: item.name,
    itemType: item.item_type,
    category: item.category,
    featured: item.featured,
    onSale: storeOnSale(item),
    sortOrder: item.sort_order,
    price: storeUnitPrice(item),
    haystack: [item.name, item.item_type, item.description ?? '', item.category].join(' '),
    endsAt: null,
    store: item,
    auction: null,
  }
}

function fromAuction(listing: AuctionListing): Lot {
  return {
    key: `auction:${listing.id}`,
    kind: 'auction',
    id: listing.id,
    name: listing.item_name,
    itemType: listing.item_type,
    category: 'player',
    featured: false,
    onSale: false,
    sortOrder: 400,
    price: listing.current_price,
    haystack: [listing.item_name, listing.item_type, listing.seller].join(' '),
    endsAt: listing.ends_at,
    store: null,
    auction: listing,
  }
}

function compareLots(left: Lot, right: Lot): number {
  if (left.featured !== right.featured) {
    return left.featured ? -1 : 1
  }

  if (left.onSale !== right.onSale) {
    return left.onSale ? -1 : 1
  }

  if (left.kind !== right.kind) {
    return left.kind === 'auction' ? -1 : 1
  }

  if (left.kind === 'auction' && right.kind === 'auction' && left.endsAt && right.endsAt) {
    return left.endsAt.localeCompare(right.endsAt)
  }

  if (left.sortOrder !== right.sortOrder) {
    return left.sortOrder - right.sortOrder
  }

  return left.name.localeCompare(right.name)
}

function maxBuyable(item: StoreItem): number {
  let cap = item.stock ?? 99

  if (item.max_per_player !== null) {
    cap = Math.min(cap, item.max_per_player)
  }

  return Math.max(0, cap)
}

function matchesFilter(lot: Lot, filter: string): boolean {
  if (filter === 'all') {
    return true
  }

  if (filter === 'official') {
    return lot.kind === 'store'
  }

  if (filter === 'player') {
    return lot.kind === 'auction'
  }

  return lot.kind === 'store' && lot.category === filter
}

/**
 * One market: staff lots at a fixed price, and player lots you can bid on.
 *
 * Same two-pane shell as wallet and inventory — a list on the left, the
 * selected lot (or your orders) on the right.
 */
export function AuctionsPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const items = useQuery(storeItemsQuery)
  const live = useQuery(auctionsQuery)
  const mine = useQuery(myAuctionsQuery)
  const purchases = useQuery(myStorePurchasesQuery)
  const wallet = useQuery(myWalletQuery)
  const inventory = useQuery(myInventoryQuery)
  const inspector = useRef<HTMLDivElement>(null)

  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(1)
  const [bid, setBid] = useState('')
  const [listing, setListing] = useState(false)
  const [confirming, setConfirming] = useState<'buy' | 'buyout' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const stacks = useMemo(
    () => (inventory.data?.snapshot ? stackItems(inventory.data.snapshot.items) : []),
    [inventory.data],
  )

  const staffItems = useMemo(
    () => (Array.isArray(items.data) ? items.data : []),
    [items.data],
  )
  const liveLots = useMemo(() => (Array.isArray(live.data) ? live.data : []), [live.data])
  const myLots = useMemo(() => (Array.isArray(mine.data) ? mine.data : []), [mine.data])

  const lots = useMemo(() => {
    const staff = staffItems.map(fromStore)
    const player = liveLots.map(fromAuction)
    return [...staff, ...player].sort(compareLots)
  }, [liveLots, staffItems])

  const tabs = useMemo<TabItem<string>[]>(() => {
    const counts = new Map<string, number>()

    for (const lot of lots) {
      const source = lot.kind === 'store' ? 'official' : 'player'
      counts.set(source, (counts.get(source) ?? 0) + 1)
      if (lot.kind === 'store') {
        counts.set(lot.category, (counts.get(lot.category) ?? 0) + 1)
      }
    }

    return [
      { id: 'all', label: t('common.all'), count: lots.length },
      ...CATEGORIES.filter((entry) => entry.id !== 'all' && (counts.get(entry.id) ?? 0) > 0).map(
        (entry) => ({
          id: entry.id,
          label: t(entry.label),
          count: counts.get(entry.id) ?? 0,
        }),
      ),
    ]
  }, [lots, t])

  const active = tabs.some((tab) => tab.id === filter) ? filter : 'all'

  const visible = useMemo(() => {
    const inFilter = lots.filter((lot) => matchesFilter(lot, active))

    if (search.trim() === '') {
      return inFilter
    }

    return inFilter
      .map((lot) => {
        const hit = fuzzyMatchWords(search, lot.haystack)
        return hit ? { lot, score: hit.score } : null
      })
      .filter((entry): entry is { lot: Lot; score: number } => entry !== null)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.lot)
  }, [active, lots, search])

  const current = visible.find((lot) => lot.key === selected) ?? null
  const storeItem = current?.store ?? null
  const auction = current?.auction
    ? (live.data ?? []).find((row) => row.id === current.id) ?? current.auction
    : null

  const available = wallet.data?.available ?? 0
  const cap = storeItem ? maxBuyable(storeItem) : 0
  const units = storeItem ? Math.min(Math.max(1, quantity), Math.max(1, cap)) : 1
  const storeTotal = storeItem ? storeUnitPrice(storeItem) * units : 0
  const soldOut = storeItem !== null && storeItem.stock !== null && storeItem.stock < 1
  const shortStore = storeItem !== null && wallet.data != null && available < storeTotal
  const canBuyStore = storeItem !== null && wallet.data != null && !soldOut && !shortStore && cap > 0
  const loading = lots.length === 0 && (items.isPending || live.isPending)
  const queryError =
    items.error instanceof ApiError
      ? items.error.message
      : live.error instanceof ApiError
        ? live.error.message
        : items.error || live.error
          ? t('auth.unexpected_error')
          : null

  async function refreshMarket() {
    await queryClient.invalidateQueries({ queryKey: ['me'] })
    await queryClient.invalidateQueries({ queryKey: ['store'] })
    await queryClient.invalidateQueries({ queryKey: ['auctions'] })
  }

  function fail(cause: unknown) {
    setConfirming(null)
    setNotice(null)
    setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
  }

  const buy = useMutation({
    mutationFn: () => {
      if (!storeItem) {
        throw new Error('missing item')
      }

      return api.buyStoreItem(storeItem.id, units)
    },
    onSuccess: async () => {
      setConfirming(null)
      setError(null)
      setNotice(t('economy.bought'))
      await refreshMarket()
    },
    onError: fail,
  })

  const placed = useMutation({
    mutationFn: () => {
      if (!auction) {
        throw new Error('missing listing')
      }

      return api.bidAuction(auction.id, Number(bid) || auction.next_bid)
    },
    onSuccess: async (row) => {
      setBid(String(row.next_bid))
      setError(null)
      setNotice(t('economy.bid_placed'))
      await refreshMarket()
    },
    onError: fail,
  })

  const bought = useMutation({
    mutationFn: () => {
      if (!auction) {
        throw new Error('missing listing')
      }

      return api.buyoutAuction(auction.id)
    },
    onSuccess: async () => {
      setConfirming(null)
      setError(null)
      setNotice(t('economy.bought'))
      await refreshMarket()
    },
    onError: fail,
  })

  const cancelled = useMutation({
    mutationFn: (id: string) => api.cancelAuction(id),
    onSuccess: async () => {
      setSelected(null)
      setError(null)
      setNotice(t('economy.cancelled'))
      await refreshMarket()
    },
    onError: fail,
  })

  function pick(key: string, next: Lot) {
    setSelected((previous) => (previous === key ? null : key))
    setQuantity(1)
    setConfirming(null)
    if (next.auction) {
      setBid(String(next.auction.next_bid))
    }

    requestAnimationFrame(() => {
      if (window.matchMedia('(max-width: 1023px)').matches) {
        inspector.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    })
  }

  const confirmTitle =
    confirming === 'buy' && storeItem
      ? t('economy.buy_confirm', { name: storeItem.name })
      : confirming === 'buyout' && auction
        ? t('economy.buy_confirm', { name: auction.item_name })
        : t('economy.buy')

  const confirmBody =
    confirming === 'buy' && storeItem
      ? t('economy.buy_body', {
          name: storeItem.name,
          price: t('economy.coins', { count: storeTotal }),
        })
      : confirming === 'buyout' && auction?.buyout_price
        ? t('economy.buy_body', {
            name: auction.item_name,
            price: t('economy.coins', { count: auction.buyout_price }),
          })
        : null

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.holdings')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('economy.auction_title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('economy.auction_description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/me/wallet"
            className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase transition-colors hover:text-hazard"
          >
            {t('economy.open_wallet')}
          </Link>
          <Button size="sm" onClick={() => setListing(true)}>
            {t('economy.list_item')}
          </Button>
        </div>
      </header>

      {wallet.isPending ? (
        <Skeleton className="h-20 shrink-0" />
      ) : wallet.data ? (
        <Panel bracketed className="shrink-0">
          <div className="grid divide-y divide-fence sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <Fact
              label={t('economy.available')}
              value={formatCoins(wallet.data.available, intlLocale)}
              icon={Coins}
            />
            <Fact
              label={t('economy.held')}
              value={formatCoins(wallet.data.held, intlLocale)}
              icon={Lock}
            />
            <Fact
              label={t('economy.balance')}
              value={formatCoins(wallet.data.balance, intlLocale)}
              icon={Wallet}
            />
          </div>
        </Panel>
      ) : null}

      {notice ? (
        <p role="status" className="border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}
      {queryError ? <FormError>{queryError}</FormError> : null}

      {loading ? (
        <Skeleton className="min-h-0 flex-1" />
      ) : lots.length === 0 && myLots.length === 0 ? (
        <Panel bracketed className="flex min-h-0 flex-1 flex-col items-center justify-center p-10 text-center">
          <Tag aria-hidden="true" className="size-8 text-dust" strokeWidth={1.25} />
          <p className="mt-4 text-sm text-dust">{t('economy.market_empty')}</p>
          <p className="mt-2 max-w-md text-sm text-smoke">{t('economy.house_fee')}</p>
        </Panel>
      ) : (
        <>
          <label className="relative block shrink-0">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-dust"
              strokeWidth={1.5}
            />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('economy.search')}
              aria-label={t('economy.search')}
              className="h-11 w-full border border-fence-bright bg-void pr-3 pl-9 font-mono text-sm text-bone transition-colors placeholder:text-dust focus:border-hazard"
            />
          </label>

          <TabStrip
            items={tabs}
            active={active}
            onSelect={setFilter}
            label={t('economy.category')}
            className="shrink-0"
          />

          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(16rem,26rem)_minmax(0,1fr)]">
            <Panel bracketed className="flex min-h-0 flex-col">
              <PanelHeader
                label={t('economy.browse')}
                action={
                  <span className="font-mono text-[0.6875rem] text-dust">
                    {t('admin.backups_showing', { count: visible.length })}
                  </span>
                }
              />
              {visible.length === 0 ? (
                <p className="p-5 text-sm text-dust">
                  {search.trim() === '' ? t('economy.market_empty') : t('economy.search_empty')}
                </p>
              ) : (
                <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
                  {visible.map((lot) => (
                    <LotRow
                      key={lot.key}
                      lot={lot}
                      active={lot.key === current?.key}
                      onPick={() => pick(lot.key, lot)}
                    />
                  ))}
                </ul>
              )}
            </Panel>

            <Panel ref={inspector} bracketed className="flex min-h-0 flex-col overflow-y-auto">
              {storeItem ? (
                <StoreInspector
                  item={storeItem}
                  quantity={units}
                  available={available}
                  soldOut={soldOut}
                  short={shortStore}
                  canBuy={canBuyStore}
                  busy={buy.isPending}
                  onQuantity={setQuantity}
                  onBuy={() => setConfirming('buy')}
                  purchases={(purchases.data ?? []).filter(
                    (row) => row.item_type === storeItem.item_type || row.item_id === storeItem.id,
                  )}
                />
              ) : auction ? (
                <AuctionInspector
                  listing={auction}
                  bid={bid}
                  busy={placed.isPending || bought.isPending || cancelled.isPending}
                  onBid={setBid}
                  onPlace={() => placed.mutate()}
                  onBuyout={() => setConfirming('buyout')}
                  onCancel={() => cancelled.mutate(auction.id)}
                />
              ) : (
                <Desk
                  listings={mine.data ?? []}
                  purchases={purchases.data ?? []}
                  pending={mine.isPending || purchases.isPending}
                />
              )}
            </Panel>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirming !== null && (storeItem !== null || auction !== null)}
        title={confirmTitle}
        description={confirmBody}
        confirmLabel={confirming === 'buyout' ? t('economy.buy_now') : t('economy.buy')}
        busy={buy.isPending || bought.isPending}
        confirmDisabled={confirming === 'buy' ? !canBuyStore : auction?.buyout_price == null}
        onConfirm={() => {
          if (confirming === 'buy') {
            buy.mutate()
          } else if (confirming === 'buyout') {
            bought.mutate()
          }
        }}
        onClose={() => setConfirming(null)}
      />

      <ListDialog
        open={listing}
        stacks={stacks}
        onClose={() => setListing(false)}
        onListed={async () => {
          setListing(false)
          setNotice(t('economy.listed'))
          await refreshMarket()
        }}
        onError={fail}
      />
    </section>
  )
}

function LotRow({
  lot,
  active,
  onPick,
}: {
  lot: Lot
  active: boolean
  onPick: () => void
}) {
  const { t, intlLocale } = useTranslation()
  const empty = lot.store !== null && lot.store.stock !== null && lot.store.stock < 1
  const Icon = lot.kind === 'store' ? Package : Tag

  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className={cn(
          'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
          active ? 'bg-hazard-soft' : 'hover:bg-ash-raised',
          empty && 'opacity-60',
        )}
      >
        <Icon
          aria-hidden="true"
          className={cn('mt-0.5 size-4 shrink-0', lot.featured ? 'text-hazard' : 'text-dust')}
          strokeWidth={1.5}
        />
        <span className="min-w-0 flex-1">
          <span className="flex w-full items-baseline justify-between gap-2">
            <span className="truncate text-sm text-bone">
              {lot.name}
              {lot.kind === 'auction' && lot.auction && lot.auction.quantity > 1
                ? ` ×${lot.auction.quantity}`
                : null}
            </span>
            <span className="flex shrink-0 items-baseline gap-1.5 font-mono text-sm">
              {lot.onSale && lot.store ? (
                <span className="text-dust line-through">
                  {t('economy.coins', { count: lot.store.price })}
                </span>
              ) : null}
              <span className="text-hazard">{t('economy.coins', { count: lot.price })}</span>
            </span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 font-mono text-[0.6875rem] tracking-wide uppercase">
            {lot.kind === 'store' ? (
              <>
                <span className="text-hazard">{t('economy.official')}</span>
                <span className="text-dust">{t(categoryLabel(lot.category))}</span>
                {lot.store && lot.store.quantity > 1 ? (
                  <span className="text-smoke">
                    · {t('economy.unit_count', { count: lot.store.quantity })}
                  </span>
                ) : null}
                {lot.onSale && lot.store ? (
                  <span className="text-hazard">
                    · {t('economy.off', { count: lot.store.discount_percent })}
                  </span>
                ) : null}
                {lot.featured ? (
                  <span className="text-hazard">· {t('economy.featured')}</span>
                ) : null}
                {empty ? (
                  <span className="text-blood">· {t('economy.out_of_stock')}</span>
                ) : lot.store?.stock !== null && lot.store?.stock !== undefined ? (
                  <span className="text-smoke">
                    · {t('economy.stock')} {lot.store.stock}
                  </span>
                ) : null}
              </>
            ) : (
              <>
                <span className="text-smoke">{t(auctionStatusLabel(lot.auction?.status ?? 'live'))}</span>
                <span className="text-dust">
                  · {lot.auction?.seller ?? t('economy.seller')}
                </span>
                {lot.endsAt ? (
                  <span className="text-smoke">· {formatRelativeTime(lot.endsAt, intlLocale)}</span>
                ) : null}
              </>
            )}
          </span>
        </span>
      </button>
    </li>
  )
}

function Fact({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: string
  icon: typeof Coins
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <Icon aria-hidden="true" className="mt-1 size-4 shrink-0 text-dust" strokeWidth={1.5} />
      <div className="min-w-0">
        <div className="display text-2xl text-bone tabular-nums">{value}</div>
        <div className="mt-1 font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
          {label}
        </div>
      </div>
    </div>
  )
}

function StoreInspector({
  item,
  quantity,
  available,
  soldOut,
  short,
  canBuy,
  busy,
  onQuantity,
  onBuy,
  purchases,
}: {
  item: StoreItem
  quantity: number
  available: number
  soldOut: boolean
  short: boolean
  canBuy: boolean
  busy: boolean
  onQuantity: (value: number) => void
  onBuy: () => void
  purchases: StorePurchase[]
}) {
  const { t } = useTranslation()
  const cap = maxBuyable(item)
  const unit = storeUnitPrice(item)
  const total = unit * quantity
  const remaining = available - total
  const onSale = storeOnSale(item)

  return (
    <>
      <PanelHeader
        label={t(categoryLabel(item.category))}
        action={
          <span className="border border-hazard/40 bg-hazard-soft px-1.5 py-0.5 font-mono text-[0.625rem] tracking-wide text-hazard uppercase">
            {onSale
              ? t('economy.off', { count: item.discount_percent })
              : item.featured
                ? t('economy.featured')
                : t('economy.official')}
          </span>
        }
      />

      <div className="flex flex-col gap-5 p-5">
        <div>
          <h2 className="display text-2xl text-bone">{item.name}</h2>
          <p className="mt-1 font-mono text-[0.6875rem] text-dust">{item.item_type}</p>
        </div>

        {item.description ? <p className="text-sm leading-relaxed text-smoke">{item.description}</p> : null}

        <dl className="grid gap-3 sm:grid-cols-2">
          <Meta
            label={t('economy.price')}
            value={
              onSale
                ? `${t('economy.coins', { count: unit })} (${t('economy.off', { count: item.discount_percent })})`
                : t('economy.coins', { count: item.price })
            }
          />
          <Meta
            label={t('economy.stock')}
            value={item.stock === null ? t('economy.stock_unlimited') : String(item.stock)}
          />
          {item.quantity > 1 ? (
            <Meta
              label={t('economy.quantity')}
              value={t('economy.unit_count', { count: item.quantity })}
            />
          ) : null}
          {item.max_per_player !== null ? (
            <Meta label={t('economy.max_per_player')} value={String(item.max_per_player)} />
          ) : null}
          <Meta label={t('economy.seller')} value={t('economy.staff_seller')} />
        </dl>

        <p className="text-xs text-dust">{t('economy.delivery_hint')}</p>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          {cap > 1 ? (
            <Field
              type="number"
              min={1}
              max={cap}
              label={t('economy.quantity')}
              value={quantity}
              onChange={(event) => onQuantity(Number(event.target.value) || 1)}
              className="sm:max-w-32"
            />
          ) : null}
          <Button size="sm" disabled={!canBuy || busy} onClick={onBuy} className="sm:ml-auto">
            <Coins aria-hidden="true" className="size-3.5" />
            {t('economy.buy')}
            {quantity > 1 ? ` · ${t('economy.coins', { count: total })}` : ''}
          </Button>
        </div>

        {soldOut ? (
          <p className="font-mono text-xs text-blood">{t('economy.out_of_stock')}</p>
        ) : short ? (
          <p className="font-mono text-xs text-blood">{t('economy.cannot_afford')}</p>
        ) : (
          <p className="font-mono text-[0.6875rem] text-dust">
            {t('economy.after_purchase', {
              count: t('economy.coins', { count: remaining }),
            })}
          </p>
        )}
      </div>

      {purchases.length > 0 ? (
        <div className="border-t border-fence">
          <PanelHeader label={t('economy.purchases')} />
          <PurchaseList rows={purchases.slice(0, 8)} />
        </div>
      ) : null}
    </>
  )
}

function AuctionInspector({
  listing,
  bid,
  busy,
  onBid,
  onPlace,
  onBuyout,
  onCancel,
}: {
  listing: AuctionListing
  bid: string
  busy: boolean
  onBid: (value: string) => void
  onPlace: () => void
  onBuyout: () => void
  onCancel: () => void
}) {
  const { t, intlLocale } = useTranslation()

  return (
    <>
      <PanelHeader
        label={t(auctionStatusLabel(listing.status))}
        action={
          listing.mine ? (
            <span className="font-mono text-[0.625rem] tracking-wide text-dust uppercase">
              {t('economy.mine')}
            </span>
          ) : null
        }
      />

      <div className="flex flex-col gap-5 p-5">
        <div>
          <h2 className="display text-2xl text-bone">
            {listing.item_name}
            {listing.quantity > 1 ? ` ×${listing.quantity}` : ''}
          </h2>
          <p className="mt-1 font-mono text-[0.6875rem] text-dust">{listing.item_type}</p>
        </div>

        <dl className="grid gap-3 sm:grid-cols-2">
          <Meta label={t('economy.seller')} value={listing.seller} />
          <Meta
            label={t('economy.current_bid')}
            value={t('economy.coins', { count: listing.current_price })}
          />
          <Meta
            label={t('economy.buyout')}
            value={
              listing.buyout_price
                ? t('economy.coins', { count: listing.buyout_price })
                : t('economy.no_buyout')
            }
          />
          <Meta label={t('economy.ends')} value={formatDateTime(listing.ends_at, intlLocale)} />
          {listing.condition !== null ? (
            <Meta label={t('economy.condition')} value={String(listing.condition)} />
          ) : null}
          <Meta label={t('economy.bids')} value={String(listing.bid_count)} />
        </dl>

        <p className="text-xs text-dust">{t('economy.house_fee')}</p>

        {listing.status === 'live' && !listing.mine ? (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <Field
                type="number"
                min={listing.next_bid}
                label={t('economy.bid_amount')}
                value={bid}
                onChange={(event) => onBid(event.target.value)}
                className="sm:max-w-40"
              />
              <Button size="sm" disabled={busy} onClick={onPlace} className="sm:ml-auto">
                <Coins aria-hidden="true" className="size-3.5" />
                {t('economy.bid')}
              </Button>
            </div>
            {listing.buyout_price ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={onBuyout}>
                {t('economy.buy_now')}
                {` · ${t('economy.coins', { count: listing.buyout_price })}`}
              </Button>
            ) : null}
          </>
        ) : null}

        {listing.mine && (listing.status === 'live' || listing.status === 'collecting') ? (
          <Button
            size="sm"
            variant="outline"
            className="self-start border-blood text-blood"
            disabled={busy}
            onClick={onCancel}
          >
            {t('economy.cancel_listing')}
          </Button>
        ) : null}
      </div>
    </>
  )
}

function Desk({
  listings,
  purchases,
  pending,
}: {
  listings: AuctionListing[]
  purchases: StorePurchase[]
  pending: boolean
}) {
  const { t } = useTranslation()

  return (
    <>
      <PanelHeader label={t('economy.my_listings')} />
      {pending ? (
        <Skeleton className="m-5 h-24" />
      ) : listings.length === 0 && purchases.length === 0 ? (
        <div className="p-8 text-center sm:p-10">
          <p className="text-sm text-dust">{t('economy.pick_listing')}</p>
          <p className="mt-2 text-sm text-smoke">{t('economy.purchases_empty')}</p>
        </div>
      ) : (
        <>
          {listings.length === 0 ? (
            <p className="p-5 text-sm text-dust">{t('economy.no_listings')}</p>
          ) : (
            <ul className="divide-y divide-fence">
              {listings.slice(0, 8).map((row) => (
                <li key={row.id} className="flex items-start justify-between gap-3 px-5 py-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-bone">
                      {row.item_name}
                      {row.quantity > 1 ? ` ×${row.quantity}` : ''}
                    </span>
                    <span className="font-mono text-[0.6875rem] text-dust">{row.seller}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[0.625rem] tracking-widest text-hazard uppercase">
                    {t(auctionStatusLabel(row.status))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-fence">
            <PanelHeader label={t('economy.purchases')} />
            {purchases.length === 0 ? (
              <p className="p-5 text-sm text-dust">{t('economy.purchases_empty')}</p>
            ) : (
              <PurchaseList rows={purchases} />
            )}
          </div>
        </>
      )}
    </>
  )
}

function PurchaseList({ rows }: { rows: StorePurchase[] }) {
  const { t, intlLocale } = useTranslation()

  return (
    <ul className="divide-y divide-fence">
      {rows.map((row) => (
        <li key={row.id} className="flex items-start justify-between gap-3 px-5 py-3">
          <span className="min-w-0">
            <span className="block truncate text-sm text-bone">
              {row.item_name}
              {row.quantity > 1 ? ` ×${row.quantity}` : ''}
            </span>
            <span className="font-mono text-[0.6875rem] text-dust">
              {formatDateTime(row.created_at, intlLocale)}
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end gap-0.5">
            <span
              className={cn(
                'font-mono text-[0.625rem] tracking-widest uppercase',
                purchaseStatusTone(row.status),
              )}
            >
              {t(purchaseStatusLabel(row.status))}
            </span>
            <span className="font-mono text-[0.6875rem] text-dust">
              {t('economy.coins', { count: row.total_price })}
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">{label}</dt>
      <dd className="mt-1 font-mono text-sm text-bone">{value}</dd>
    </div>
  )
}

function ListDialog({
  open,
  stacks,
  onClose,
  onListed,
  onError,
}: {
  open: boolean
  stacks: { full_type: string; name: string; count: number; condition: number | null }[]
  onClose: () => void
  onListed: () => Promise<void>
  onError: (cause: unknown) => void
}) {
  const { t } = useTranslation()
  const [itemType, setItemType] = useState('')
  const [name, setName] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [start, setStart] = useState(10)
  const [buyout, setBuyout] = useState('')
  const [hours, setHours] = useState(24)
  const picked = stacks.find((item) => item.full_type === itemType)

  const create = useMutation({
    mutationFn: () =>
      api.listAuction({
        item_type: itemType,
        item_name: name || picked?.name,
        quantity,
        condition: picked?.condition ?? null,
        start_price: start,
        buyout_price: buyout ? Number(buyout) : null,
        hours,
      }),
    onSuccess: () => void onListed(),
    onError,
  })

  return (
    <ConfirmDialog
      open={open}
      size="lg"
      title={t('economy.list_item')}
      description={
        <div className="flex flex-col gap-3">
          <p className="text-xs text-dust">{t('economy.offline_list')}</p>
          {stacks.length > 0 ? (
            <fieldset>
              <legend className="mb-2 font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
                {t('nav.inventory')}
              </legend>
              <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                {stacks.slice(0, 40).map((item) => (
                  <button
                    key={item.full_type}
                    type="button"
                    onClick={() => {
                      setItemType(item.full_type)
                      setName(item.name)
                      setQuantity(1)
                    }}
                    className={cn(
                      'border px-2 py-1 font-mono text-[0.6875rem]',
                      itemType === item.full_type
                        ? 'border-hazard bg-hazard-soft text-hazard'
                        : 'border-fence text-dust hover:text-bone',
                    )}
                  >
                    {item.name} ×{item.count}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}
          <Field
            label={t('economy.item_type')}
            value={itemType}
            onChange={(event) => setItemType(event.target.value)}
          />
          <Field label={t('economy.item_name')} value={name} onChange={(event) => setName(event.target.value)} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              type="number"
              min={1}
              max={picked?.count ?? 50}
              label={t('economy.quantity')}
              value={quantity}
              onChange={(event) => setQuantity(Number(event.target.value) || 1)}
            />
            <Field
              type="number"
              min={1}
              label={t('economy.start_price')}
              value={start}
              onChange={(event) => setStart(Number(event.target.value) || 1)}
            />
            <Field
              type="number"
              min={start}
              label={t('economy.buyout')}
              value={buyout}
              onChange={(event) => setBuyout(event.target.value)}
            />
            <fieldset>
              <legend className="mb-2 font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
                {t('economy.duration')}
              </legend>
              <div className="flex gap-1.5">
                {[12, 24, 48].map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setHours(item)}
                    className={cn(
                      'border px-2 py-1 font-mono text-[0.6875rem]',
                      hours === item
                        ? 'border-hazard bg-hazard-soft text-hazard'
                        : 'border-fence text-dust',
                    )}
                  >
                    {t('economy.duration_hours', { count: item })}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
        </div>
      }
      confirmLabel={t('economy.list_item')}
      busy={create.isPending}
      confirmDisabled={itemType.trim().length < 3 || start < 1}
      onConfirm={() => create.mutate()}
      onClose={onClose}
    />
  )
}
