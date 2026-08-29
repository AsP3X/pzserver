import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Coins, Lock, Package, Search, Vault, Wallet } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'

import { Bar } from '@/components/ui/bar'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { TabPanel, TabStrip } from '@/components/ui/tabs'
import {
  api,
  ApiError,
  type VaultItem,
  type VaultMove,
} from '@/lib/api'
import { cn } from '@/lib/cn'
import { conditionTone } from '@/lib/condition-tone'
import { formatCoins, formatRelativeTime } from '@/lib/format'
import { fuzzyMatchWords } from '@/lib/fuzzy'
import { cargoCount, matchesSearch, stackItems } from '@/lib/inventory'
import { myInventoryQuery, myVaultQuery, myWalletQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TabItem } from '@/components/ui/tabs'
import type { TranslationKey } from '@/i18n/locales'
import type { StackedItem } from '@/lib/inventory'

type Surface = 'stored' | 'pack'

/**
 * The player's locker outside the game world.
 *
 * Store is free. Retrieve costs coins. Capacity is a bought upgrade, so the
 * page leads with how full it is and what a retrieve will cost.
 */
export function VaultPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const inspector = useRef<HTMLDivElement>(null)
  const vault = useQuery(myVaultQuery)
  const pack = useQuery(myInventoryQuery)
  const [surface, setSurface] = useState<Surface>('stored')
  const [search, setSearch] = useState('')
  const [selectedStored, setSelectedStored] = useState<string | null>(null)
  const [selectedPack, setSelectedPack] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(1)
  const [confirm, setConfirm] = useState<'retrieve' | 'upgrade' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const view = vault.data
  const items = view?.items ?? []
  const carried = useMemo(
    () => (pack.data?.snapshot ? stackItems(pack.data.snapshot.items) : []),
    [pack.data],
  )

  const storedShown = useMemo(
    () =>
      items.filter(
        (item) =>
          search === '' ||
          fuzzyMatchWords(search, `${item.item_name} ${item.item_type} ${item.category}`),
      ),
    [items, search],
  )
  const packShown = useMemo(
    () => carried.filter((item) => matchesSearch(item, search)),
    [carried, search],
  )

  const stored = items.find((item) => item.id === selectedStored) ?? storedShown[0] ?? null
  const fromPack =
    carried.find((item) => item.key === selectedPack) ?? packShown[0] ?? null

  const tabs: TabItem<Surface>[] = [
    { id: 'stored', label: t('vault.stored'), count: items.length },
    { id: 'pack', label: t('vault.from_pack'), count: carried.length },
  ]

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['me', 'vault'] })
    await queryClient.invalidateQueries({ queryKey: ['me', 'inventory'] })
    await queryClient.invalidateQueries({ queryKey: ['me', 'wallet'] })
  }

  function fail(cause: unknown) {
    setNotice(null)
    setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
  }

  const store = useMutation({
    mutationFn: () => {
      if (!fromPack) throw new Error('missing item')
      return api.storeInVault({
        item_type: fromPack.full_type,
        item_name: fromPack.name,
        category: fromPack.category,
        condition: fromPack.condition,
        quantity: fromPack.opens ? 1 : quantity,
        container_id: fromPack.opens,
      })
    },
    onSuccess: async () => {
      setNotice(t('vault.stored_ok'))
      setError(null)
      await refresh()
    },
    onError: fail,
  })

  const retrieve = useMutation({
    mutationFn: () => {
      if (!stored) throw new Error('missing item')
      return api.retrieveFromVault(stored.id, quantity)
    },
    onSuccess: async () => {
      setConfirm(null)
      setNotice(t('vault.retrieve_ok'))
      setError(null)
      await refresh()
    },
    onError: fail,
  })

  const upgrade = useMutation({
    mutationFn: api.upgradeVault,
    onSuccess: async () => {
      setConfirm(null)
      setNotice(t('vault.upgraded'))
      setError(null)
      await refresh()
    },
    onError: fail,
  })

  function pickStored(id: string) {
    setSelectedStored(id)
    setQuantity(1)
    requestAnimationFrame(() => {
      if (window.matchMedia('(max-width: 1023px)').matches) {
        inspector.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    })
  }

  function pickPack(type: string) {
    setSelectedPack(type)
    setQuantity(1)
    requestAnimationFrame(() => {
      if (window.matchMedia('(max-width: 1023px)').matches) {
        inspector.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    })
  }

  const retrieveUnits =
    stored && stored.cargo_count > 0 ? 1 + stored.cargo_count : quantity
  const retrieveFee =
    stored?.held || !view ? 0 : view.fees.flat + view.fees.per_item * retrieveUnits
  const canAfford = (view?.wallet.available ?? 0) >= retrieveFee
  const canUpgrade =
    view !== undefined &&
    !view.capacity.at_max &&
    view.wallet.available >= view.capacity.upgrade_cost
  const room = view ? view.capacity.total - view.capacity.used - view.capacity.reserved : 0

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.holdings')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('vault.title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('vault.description')}</p>
        </div>
        <Link
          to="/me/inventory"
          className="self-start font-mono text-[0.6875rem] tracking-widest text-dust uppercase transition-colors hover:text-hazard lg:self-auto"
        >
          {t('nav.inventory')}
        </Link>
      </header>

      {vault.isPending ? (
        <Skeleton className="h-24 shrink-0" />
      ) : vault.isError || !view ? (
        <FormError>{t('common.error')}</FormError>
      ) : !view.enabled ? (
        <Panel bracketed className="flex min-h-0 flex-1 flex-col items-center justify-center p-10 text-center">
          <Lock aria-hidden="true" className="size-8 text-dust" strokeWidth={1.25} />
          <h2 className="display mt-4 text-2xl text-bone">{t('vault.disabled')}</h2>
          <p className="mx-auto mt-3 max-w-md text-sm text-smoke">{t('vault.disabled_desc')}</p>
        </Panel>
      ) : (
        <>
          <Panel bracketed className="shrink-0">
            <div className="grid divide-y divide-fence lg:grid-cols-[minmax(0,1fr)_auto] lg:divide-x lg:divide-y-0">
              <div className="p-4 sm:p-5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-smoke">{t('vault.capacity')}</span>
                  <span className="font-mono text-sm tabular-nums text-bone">
                    {view.capacity.used + view.capacity.reserved} / {view.capacity.total}
                  </span>
                </div>
                <div
                  className="mt-2"
                  role="meter"
                  aria-label={t('vault.capacity')}
                  aria-valuemin={0}
                  aria-valuemax={view.capacity.total}
                  aria-valuenow={view.capacity.used + view.capacity.reserved}
                >
                  <Bar
                    fraction={
                      view.capacity.total > 0
                        ? (view.capacity.used + view.capacity.reserved) / view.capacity.total
                        : 0
                    }
                  />
                </div>
                <p className="mt-2 font-mono text-[0.6875rem] text-dust">
                  {t('vault.free_slots', { count: Math.max(0, room) })}
                  {view.capacity.reserved > 0
                    ? ` · ${t('vault.reserved', { count: view.capacity.reserved })}`
                    : ''}
                </p>
              </div>
              <div className="flex flex-col justify-between gap-3 p-4 sm:p-5 lg:w-72">
                <p className="text-xs leading-relaxed text-dust">{t('vault.fee_note', {
                  flat: formatCoins(view.fees.flat, intlLocale),
                  per: formatCoins(view.fees.per_item, intlLocale),
                })}</p>
                {view.capacity.at_max ? (
                  <p className="font-mono text-[0.6875rem] text-dust">{t('vault.at_max')}</p>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canUpgrade || upgrade.isPending}
                    onClick={() => setConfirm('upgrade')}
                  >
                    {t('vault.upgrade', {
                      count: view.capacity.upgrade_increment,
                      cost: formatCoins(view.capacity.upgrade_cost, intlLocale),
                    })}
                  </Button>
                )}
                {!view.capacity.at_max && !canUpgrade ? (
                  <p className="text-xs text-dust">{t('vault.need_coins')}</p>
                ) : null}
              </div>
            </div>
            <div className="grid border-t border-fence divide-y divide-fence sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <Fact
                label={t('economy.available')}
                value={formatCoins(view.wallet.available, intlLocale)}
                icon={Coins}
              />
              <Fact
                label={t('economy.held')}
                value={formatCoins(view.wallet.held, intlLocale)}
                icon={Lock}
              />
              <Fact
                label={t('economy.balance')}
                value={formatCoins(view.wallet.balance, intlLocale)}
                icon={Wallet}
              />
            </div>
          </Panel>

          {notice ? (
            <p role="status" className="border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
              {notice}
            </p>
          ) : null}
          {error ? <FormError>{error}</FormError> : null}

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
              placeholder={t('vault.search')}
              aria-label={t('vault.search')}
              className="h-11 w-full border border-fence-bright bg-void pr-3 pl-9 font-mono text-sm text-bone transition-colors placeholder:text-dust focus:border-hazard"
            />
          </label>

          <TabStrip
            items={tabs}
            active={surface}
            onSelect={setSurface}
            label={t('vault.title')}
            className="shrink-0"
          />

          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(16rem,26rem)_minmax(0,1fr)]">
            <Panel bracketed className="flex min-h-0 flex-col">
              <TabPanel id={surface} className="flex min-h-0 flex-1 flex-col">
                {surface === 'stored' ? (
                  storedShown.length === 0 ? (
                    <Empty
                      title={t('vault.empty')}
                      body={t('vault.empty_desc')}
                      action={
                        <Button size="sm" variant="outline" onClick={() => setSurface('pack')}>
                          {t('vault.from_pack')}
                        </Button>
                      }
                    />
                  ) : (
                    <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
                      {storedShown.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => pickStored(item.id)}
                            aria-current={stored?.id === item.id ? 'true' : undefined}
                            className={cn(
                              'flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-ash-raised',
                              stored?.id === item.id ? 'bg-hazard-soft' : '',
                              item.held ? 'border-l-2 border-hazard' : '',
                            )}
                          >
                            <Package
                              aria-hidden="true"
                              className="mt-0.5 size-4 shrink-0 text-dust"
                              strokeWidth={1.5}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline gap-1.5">
                                <span className="truncate text-sm text-bone">{item.item_name}</span>
                                <span className="shrink-0 font-mono text-xs text-smoke">
                                  ×{item.quantity}
                                </span>
                              </span>
                              <span className="mt-0.5 font-mono text-[0.6875rem] tracking-wide text-dust uppercase">
                                {item.held ? `${t('vault.held')} · ` : ''}
                                {item.category}
                                {item.cargo_count > 0
                                  ? ` · ${t('vault.cargo', { count: item.cargo_count })}`
                                  : ''}
                              </span>
                            </span>
                            <Condition value={item.condition_bp} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                ) : packShown.length === 0 ? (
                  <Empty title={t('vault.pack_empty')} body={t('vault.pack_empty_desc')} />
                ) : (
                  <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
                    {packShown.map((item) => (
                      <li key={item.key}>
                        <button
                          type="button"
                          onClick={() => pickPack(item.key)}
                          aria-current={fromPack?.key === item.key ? 'true' : undefined}
                          className={cn(
                            'flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-ash-raised',
                            fromPack?.key === item.key ? 'bg-hazard-soft' : '',
                          )}
                        >
                          <Package
                            aria-hidden="true"
                            className="mt-0.5 size-4 shrink-0 text-dust"
                            strokeWidth={1.5}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-1.5">
                              <span className="truncate text-sm text-bone">{item.name}</span>
                              <span className="shrink-0 font-mono text-xs text-smoke">
                                ×{item.count}
                              </span>
                            </span>
                            <span className="mt-0.5 font-mono text-[0.6875rem] tracking-wide text-dust uppercase">
                              {item.category}
                            </span>
                          </span>
                          {item.condition === null ? null : <Condition value={item.condition} />}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </TabPanel>
            </Panel>

            <div ref={inspector} className="flex min-h-0 flex-col">
            <Panel bracketed className="flex min-h-0 flex-1 flex-col">
              {surface === 'stored' ? (
                stored ? (
                  <InspectStored
                    item={stored}
                    quantity={stored.cargo_count > 0 ? 1 : quantity}
                    max={stored.cargo_count > 0 ? 1 : stored.quantity}
                    fee={retrieveFee}
                    canAfford={canAfford}
                    locale={intlLocale}
                    busy={retrieve.isPending}
                    onQuantity={setQuantity}
                    onRetrieve={() => setConfirm('retrieve')}
                  />
                ) : (
                  <p className="p-6 text-sm text-dust">{t('vault.pick_stored')}</p>
                )
              ) : fromPack ? (
                <InspectPack
                  item={fromPack}
                  quantity={fromPack.opens ? 1 : quantity}
                  inside={
                    fromPack.opens && pack.data?.snapshot
                      ? cargoCount(pack.data.snapshot.items, fromPack.opens)
                      : 0
                  }
                  tight={room <= 0}
                  busy={store.isPending}
                  onQuantity={setQuantity}
                  onStore={() => store.mutate()}
                />
              ) : (
                <p className="p-6 text-sm text-dust">{t('vault.pick_pack')}</p>
              )}

              <History moves={view.moves} locale={intlLocale} />
            </Panel>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirm === 'retrieve' && stored !== null}
        title={t('vault.retrieve_confirm', { name: stored?.item_name ?? '' })}
        description={t('vault.retrieve_body', {
          count: quantity,
          name: stored?.item_name ?? '',
          fee: formatCoins(retrieveFee, intlLocale),
        })}
        confirmLabel={t('vault.retrieve')}
        busy={retrieve.isPending}
        confirmDisabled={!canAfford}
        onConfirm={() => retrieve.mutate()}
        onClose={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm === 'upgrade' && view !== undefined}
        title={t('vault.upgrade_confirm')}
        description={
          view
            ? t('vault.upgrade_body', {
                count: view.capacity.upgrade_increment,
                cost: formatCoins(view.capacity.upgrade_cost, intlLocale),
              })
            : ''
        }
        confirmLabel={t('vault.upgrade_pay')}
        busy={upgrade.isPending}
        onConfirm={() => upgrade.mutate()}
        onClose={() => setConfirm(null)}
      />
    </section>
  )
}

function InspectStored({
  item,
  quantity,
  max,
  fee,
  canAfford,
  locale,
  busy,
  onQuantity,
  onRetrieve,
}: {
  item: VaultItem
  quantity: number
  max: number
  fee: number
  canAfford: boolean
  locale: string
  busy: boolean
  onQuantity: (value: number) => void
  onRetrieve: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4 p-5">
      <PanelHeader label={item.item_name} />
      <p className="font-mono text-[0.6875rem] text-dust">
        {item.item_type} · {item.category}
      </p>
      <Condition value={item.condition_bp} wide />
      {item.cargo_count > 0 ? (
        <p className="text-sm text-smoke">{t('vault.cargo_fee', { count: item.cargo_count })}</p>
      ) : (
        <Field
          type="number"
          min={1}
          max={max}
          label={t('economy.quantity')}
          value={quantity}
          onChange={(event) =>
            onQuantity(Math.min(max, Math.max(1, Number(event.target.value) || 1)))
          }
        />
      )}
      {item.held ? (
        <p className="border border-hazard/40 bg-hazard-soft px-3 py-2 text-sm text-hazard">
          {t('vault.held_hint')}
        </p>
      ) : (
        <p className="text-sm text-smoke">
          {t('vault.retrieve_fee', { fee: formatCoins(fee, locale) })}
        </p>
      )}
      <Button
        disabled={busy || !canAfford}
        onClick={onRetrieve}
        aria-label={t('vault.retrieve_named', {
          name: item.item_name,
          fee: formatCoins(fee, locale),
        })}
      >
        {t('vault.retrieve')}
      </Button>
      {!canAfford ? <p className="text-xs text-dust">{t('vault.need_coins')}</p> : null}
      <p className="text-xs text-dust">{t('vault.retrieve_hint')}</p>
    </div>
  )
}

function InspectPack({
  item,
  quantity,
  inside,
  tight,
  busy,
  onQuantity,
  onStore,
}: {
  item: StackedItem
  quantity: number
  inside: number
  tight: boolean
  busy: boolean
  onQuantity: (value: number) => void
  onStore: () => void
}) {
  const { t } = useTranslation()
  const max = item.count
  const packed = Boolean(item.opens)
  return (
    <div className="flex flex-col gap-4 p-5">
      <PanelHeader label={item.name} />
      <p className="font-mono text-[0.6875rem] text-dust">
        {item.full_type} · {item.category}
      </p>
      {item.condition === null ? null : <Condition value={item.condition} wide />}
      {packed ? (
        <p className="text-sm text-smoke">
          {inside > 0 ? t('vault.cargo_fee', { count: inside }) : t('vault.one_bag')}
        </p>
      ) : (
        <Field
          type="number"
          min={1}
          max={max}
          label={t('economy.quantity')}
          value={quantity}
          onChange={(event) =>
            onQuantity(Math.min(max, Math.max(1, Number(event.target.value) || 1)))
          }
        />
      )}
      <p className="text-sm text-moss">{t('vault.store_free')}</p>
      <Button
        disabled={busy}
        onClick={onStore}
        aria-label={t('vault.store_named', { name: item.name })}
      >
        {t('vault.store')}
      </Button>
      {tight ? <p className="text-xs text-dust">{t('vault.full')}</p> : null}
    </div>
  )
}

function History({ moves, locale }: { moves: VaultMove[]; locale: string }) {
  const { t } = useTranslation()
  if (moves.length === 0) {
    return (
      <div className="border-t border-fence px-5 py-4">
        <p className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
          {t('vault.recent')}
        </p>
        <p className="mt-2 text-xs text-dust">{t('vault.no_history')}</p>
      </div>
    )
  }

  const statusKey: Record<string, TranslationKey> = {
    pending: 'economy.status_pending',
    done: 'economy.status_delivered',
    failed: 'economy.status_failed',
    partial: 'vault.status_partial',
  }

  return (
    <div className="border-t border-fence px-5 py-4">
      <p className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
        {t('vault.recent')}
      </p>
      <ol className="mt-2 flex flex-col gap-2">
        {moves.map((move) => (
          <li key={move.id} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="min-w-0 truncate text-smoke">
              {move.direction === 'store' ? t('vault.store') : t('vault.retrieve')}
              {' · '}
              {move.item_name} ×{move.requested}
            </span>
            <span className="shrink-0 font-mono text-dust">
              {t(statusKey[move.status] ?? 'economy.status_pending')}
              {' · '}
              {formatRelativeTime(move.created_at, locale)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function Condition({ value, wide = false }: { value: number; wide?: boolean }) {
  return (
    <span className={cn('flex items-center gap-2', wide ? 'w-full' : 'w-16 sm:w-20')}>
      <Bar className="flex-1" fraction={value / 100} />
      <span
        className={cn(
          'w-9 text-right font-mono text-xs tabular-nums',
          conditionTone(value),
        )}
      >
        {Math.round(value)}%
      </span>
    </span>
  )
}

function Empty({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <Vault aria-hidden="true" className="size-8 text-dust" strokeWidth={1.25} />
      <h2 className="display mt-4 text-xl text-bone">{title}</h2>
      <p className="mt-2 max-w-sm text-sm text-dust">{body}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
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
    <div className="flex items-center gap-3 px-4 py-3">
      <Icon aria-hidden="true" className="size-4 text-dust" strokeWidth={1.5} />
      <div>
        <p className="font-mono text-[0.625rem] tracking-widest text-dust uppercase">{label}</p>
        <p className="font-mono text-sm text-bone">{value}</p>
      </div>
    </div>
  )
}

export function StoreInVaultDialog({
  item,
  onClose,
  onStored,
}: {
  item: StackedItem | null
  onClose: () => void
  onStored: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [quantity, setQuantity] = useState(1)
  const [error, setError] = useState<string | null>(null)

  const store = useMutation({
    mutationFn: () => {
      if (!item) throw new Error('missing item')
      return api.storeInVault({
        item_type: item.full_type,
        item_name: item.name,
        category: item.category,
        condition: item.condition,
        quantity: item.opens ? 1 : quantity,
        container_id: item.opens,
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me', 'vault'] })
      await queryClient.invalidateQueries({ queryKey: ['me', 'inventory'] })
      await queryClient.invalidateQueries({ queryKey: myWalletQuery.queryKey })
      onStored()
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  return (
    <ConfirmDialog
      open={item !== null}
      title={item ? item.name : t('vault.store')}
      description={
        <div className="flex flex-col gap-3">
          <p className="text-xs text-dust">
            {item?.opens ? t('vault.one_bag') : t('vault.store_free')}
          </p>
          {error ? <p className="text-sm text-blood">{error}</p> : null}
          {item?.opens ? null : (
            <Field
              type="number"
              min={1}
              max={item?.count ?? 1}
              label={t('economy.quantity')}
              value={quantity}
              onChange={(event) => setQuantity(Number(event.target.value) || 1)}
            />
          )}
        </div>
      }
      confirmLabel={t('vault.store')}
      busy={store.isPending}
      confirmDisabled={item === null}
      onConfirm={() => store.mutate()}
      onClose={onClose}
    />
  )
}
