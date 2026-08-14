import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Coins, Lock, Package, Search, Wallet } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { TabStrip } from '@/components/ui/tabs'
import { api, ApiError, type StoreItem, type StorePurchase } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatCoins, formatDateTime } from '@/lib/format'
import { fuzzyMatchWords } from '@/lib/fuzzy'
import { myStorePurchasesQuery, myWalletQuery, storeItemsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TabItem } from '@/components/ui/tabs'
import type { TranslationKey } from '@/i18n/locales'

const CATEGORIES: { id: string; label: TranslationKey }[] = [
  { id: 'all', label: 'common.all' },
  { id: 'weapons', label: 'economy.category_weapons' },
  { id: 'ammo', label: 'economy.category_ammo' },
  { id: 'food', label: 'economy.category_food' },
  { id: 'medical', label: 'economy.category_medical' },
  { id: 'tools', label: 'economy.category_tools' },
  { id: 'clothing', label: 'economy.category_clothing' },
  { id: 'other', label: 'economy.category_other' },
]

function categoryLabel(category: string): TranslationKey {
  return CATEGORIES.find((item) => item.id === category)?.label ?? 'economy.category_other'
}

function statusLabel(status: string): TranslationKey {
  if (status === 'delivered') return 'economy.status_delivered'
  if (status === 'queued') return 'economy.status_queued'
  if (status === 'failed') return 'economy.status_failed'
  return 'economy.status_pending'
}

function statusTone(status: string): string {
  if (status === 'delivered') return 'text-moss'
  if (status === 'queued') return 'text-hazard'
  if (status === 'failed') return 'text-blood'
  return 'text-dust'
}

function compareItems(left: StoreItem, right: StoreItem): number {
  if (left.featured !== right.featured) {
    return left.featured ? -1 : 1
  }

  if (left.sort_order !== right.sort_order) {
    return left.sort_order - right.sort_order
  }

  return left.name.localeCompare(right.name)
}

function haystack(item: StoreItem): string {
  return [item.name, item.item_type, item.description ?? '', item.category].join(' ')
}

function maxBuyable(item: StoreItem): number {
  let cap = item.stock ?? 99

  if (item.max_per_player !== null) {
    cap = Math.min(cap, item.max_per_player)
  }

  return Math.max(0, cap)
}

/**
 * Staff catalogue. Fixed prices, delivered into the pack when you are online
 * or queued until you next join.
 *
 * Same two-pane shell as the rest of the signed-in surfaces: a list on the
 * left, the selected listing (or your orders) on the right.
 */
export function ShopPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const items = useQuery(storeItemsQuery)
  const purchases = useQuery(myStorePurchasesQuery)
  const wallet = useQuery(myWalletQuery)
  const inspector = useRef<HTMLDivElement>(null)

  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(1)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const catalogue = useMemo(
    () => [...(items.data ?? [])].sort(compareItems),
    [items.data],
  )

  const tabs = useMemo<TabItem<string>[]>(() => {
    const counts = new Map<string, number>()

    for (const item of catalogue) {
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
    }

    return [
      { id: 'all', label: t('common.all'), count: catalogue.length },
      ...CATEGORIES.filter((entry) => entry.id !== 'all' && (counts.get(entry.id) ?? 0) > 0).map(
        (entry) => ({
          id: entry.id,
          label: t(entry.label),
          count: counts.get(entry.id) ?? 0,
        }),
      ),
    ]
  }, [catalogue, t])

  const active = tabs.some((tab) => tab.id === filter) ? filter : 'all'

  const visible = useMemo(() => {
    const inCategory = catalogue.filter((item) => active === 'all' || item.category === active)

    if (search.trim() === '') {
      return inCategory
    }

    return inCategory
      .map((item) => {
        const hit = fuzzyMatchWords(search, haystack(item))
        return hit ? { item, score: hit.score } : null
      })
      .filter((entry): entry is { item: StoreItem; score: number } => entry !== null)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.item)
  }, [active, catalogue, search])

  const current = visible.find((item) => item.id === selected) ?? null
  const available = wallet.data?.available ?? 0
  const cap = current ? maxBuyable(current) : 0
  const units = current ? Math.min(Math.max(1, quantity), Math.max(1, cap)) : 1
  const total = current ? current.price * units : 0
  const soldOut = current !== null && current.stock !== null && current.stock < 1
  const short = current !== null && wallet.data != null && available < total
  const canBuy = current !== null && wallet.data != null && !soldOut && !short && cap > 0

  const buy = useMutation({
    mutationFn: () => {
      if (!current) {
        throw new Error('missing item')
      }

      return api.buyStoreItem(current.id, units)
    },
    onSuccess: async () => {
      setConfirming(false)
      setError(null)
      setNotice(t('economy.bought'))
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      await queryClient.invalidateQueries({ queryKey: ['store'] })
    },
    onError: (cause) => {
      setConfirming(false)
      setNotice(null)
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  function pick(id: string) {
    setSelected((previous) => (previous === id ? null : id))
    setQuantity(1)
    setConfirming(false)

    requestAnimationFrame(() => {
      if (window.matchMedia('(max-width: 1023px)').matches) {
        inspector.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    })
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.holdings')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('economy.store_title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('economy.catalogue_description')}</p>
        </div>
        <Link
          to="/me/wallet"
          className="self-start font-mono text-[0.6875rem] tracking-widest text-dust uppercase transition-colors hover:text-hazard lg:self-auto"
        >
          {t('economy.open_wallet')}
        </Link>
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

      {items.isPending ? (
        <Skeleton className="min-h-0 flex-1" />
      ) : catalogue.length === 0 ? (
        <Panel bracketed className="flex min-h-0 flex-1 flex-col items-center justify-center p-10 text-center">
          <Package aria-hidden="true" className="size-8 text-dust" strokeWidth={1.25} />
          <p className="mt-4 text-sm text-dust">{t('economy.catalogue_empty')}</p>
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
                  {search.trim() === '' ? t('economy.catalogue_empty') : t('economy.search_empty')}
                </p>
              ) : (
                <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
                  {visible.map((item) => {
                    const empty = item.stock !== null && item.stock < 1

                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => pick(item.id)}
                          className={cn(
                            'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                            item.id === current?.id ? 'bg-hazard-soft' : 'hover:bg-ash-raised',
                            empty && 'opacity-60',
                          )}
                        >
                          <Package
                            aria-hidden="true"
                            className={cn(
                              'mt-0.5 size-4 shrink-0',
                              item.featured ? 'text-hazard' : 'text-dust',
                            )}
                            strokeWidth={1.5}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex w-full items-baseline justify-between gap-2">
                              <span className="truncate text-sm text-bone">{item.name}</span>
                              <span className="shrink-0 font-mono text-sm text-hazard">
                                {t('economy.coins', { count: item.price })}
                              </span>
                            </span>
                            <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 font-mono text-[0.6875rem] tracking-wide uppercase">
                              <span className="text-dust">{t(categoryLabel(item.category))}</span>
                              {item.quantity > 1 ? (
                                <span className="text-smoke">
                                  · {t('economy.unit_count', { count: item.quantity })}
                                </span>
                              ) : null}
                              {item.featured ? (
                                <span className="text-hazard">· {t('economy.featured')}</span>
                              ) : null}
                              {empty ? (
                                <span className="text-blood">· {t('economy.out_of_stock')}</span>
                              ) : item.stock !== null ? (
                                <span className="text-smoke">
                                  · {t('economy.stock')} {item.stock}
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Panel>

            <Panel ref={inspector} bracketed className="flex min-h-0 flex-col overflow-y-auto">
              {current ? (
                <Inspector
                  item={current}
                  quantity={units}
                  available={available}
                  soldOut={soldOut}
                  short={short}
                  canBuy={canBuy}
                  busy={buy.isPending}
                  onQuantity={setQuantity}
                  onBuy={() => setConfirming(true)}
                  purchases={(purchases.data ?? []).filter(
                    (row) => row.item_type === current.item_type || row.item_id === current.id,
                  )}
                />
              ) : (
                <Orders rows={purchases.data ?? []} pending={purchases.isPending} />
              )}
            </Panel>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirming && current !== null}
        title={current ? t('economy.buy_confirm', { name: current.name }) : t('economy.buy')}
        description={
          current
            ? t('economy.buy_body', {
                name: current.name,
                price: t('economy.coins', { count: total }),
              })
            : null
        }
        confirmLabel={t('economy.buy')}
        busy={buy.isPending}
        confirmDisabled={!canBuy}
        onConfirm={() => buy.mutate()}
        onClose={() => setConfirming(false)}
      />
    </section>
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

function Inspector({
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
  const total = item.price * quantity
  const remaining = available - total

  return (
    <>
      <PanelHeader
        label={t(categoryLabel(item.category))}
        action={
          item.featured ? (
            <span className="border border-hazard/40 bg-hazard-soft px-1.5 py-0.5 font-mono text-[0.625rem] tracking-wide text-hazard uppercase">
              {t('economy.featured')}
            </span>
          ) : null
        }
      />

      <div className="flex flex-col gap-5 p-5">
        <div>
          <h2 className="display text-2xl text-bone">{item.name}</h2>
          <p className="mt-1 font-mono text-[0.6875rem] text-dust">{item.item_type}</p>
        </div>

        {item.description ? <p className="text-sm leading-relaxed text-smoke">{item.description}</p> : null}

        <dl className="grid gap-3 sm:grid-cols-2">
          <Meta label={t('economy.price')} value={t('economy.coins', { count: item.price })} />
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

function Orders({ rows, pending }: { rows: StorePurchase[]; pending: boolean }) {
  const { t } = useTranslation()

  return (
    <>
      <PanelHeader label={t('economy.purchases')} />
      {pending ? (
        <Skeleton className="m-5 h-24" />
      ) : rows.length === 0 ? (
        <div className="p-8 text-center sm:p-10">
          <p className="text-sm text-dust">{t('economy.pick_listing')}</p>
          <p className="mt-2 text-sm text-smoke">{t('economy.purchases_empty')}</p>
        </div>
      ) : (
        <PurchaseList rows={rows} />
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
            <span className={cn('font-mono text-[0.625rem] tracking-widest uppercase', statusTone(row.status))}>
              {t(statusLabel(row.status))}
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
