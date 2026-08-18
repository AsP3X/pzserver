import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Backpack,
  Box,
  Package,
  RefreshCw,
  Search,
  Tag,
  Vault,
  Weight,
} from 'lucide-react'

import { Bar } from '@/components/ui/bar'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { TabPanel, TabStrip } from '@/components/ui/tabs'
import { api, ApiError, type InventoryHold } from '@/lib/api'
import { cn } from '@/lib/cn'
import { conditionTone, wearFraction, wearPercent } from '@/lib/condition-tone'
import { formatNumber, formatRelativeTime } from '@/lib/format'
import {
  ALL_ITEMS,
  cargoCount,
  groupByContainer,
  matchesSearch,
  POCKETS,
  stackItems,
} from '@/lib/inventory'
import { StoreInVaultDialog } from '@/routes/me/vault'
import { myInventoryQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TabItem } from '@/components/ui/tabs'
import type { InventorySnapshot } from '@/lib/api'
import type { StackedItem } from '@/lib/inventory'

/**
 * What the player is carrying.
 *
 * Same two-pane shell as the store and vault: bags and pockets on the left,
 * the selected stack on the right. The reading is a snapshot, so the age is
 * part of the header rather than hidden.
 */
export function InventoryPage() {
  const { t, intlLocale } = useTranslation()
  const inspector = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState('')
  const [selectedBag, setSelectedBag] = useState<string>(ALL_ITEMS)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [listing, setListing] = useState<StackedItem | null>(null)
  const [storing, setStoring] = useState<StackedItem | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data, isPending } = useQuery(myInventoryQuery)
  const snapshot = data?.snapshot ?? null
  const holds = data?.holds ?? []

  const groups = useMemo(
    () => (snapshot ? groupByContainer(snapshot.items, snapshot.containers) : []),
    [snapshot],
  )

  const names = useMemo(
    () =>
      new Map(
        groups.map((group) => [
          group.container.id,
          group.container.id === POCKETS ? t('inventory.pockets') : group.container.name,
        ]),
      ),
    [groups, t],
  )

  const everything = useMemo(() => (snapshot ? stackItems(snapshot.items) : []), [snapshot])
  const total = useMemo(
    () => (snapshot ? snapshot.items.reduce((sum, item) => sum + item.count, 0) : 0),
    [snapshot],
  )

  const tabs = useMemo<TabItem<string>[]>(
    () => [
      { id: ALL_ITEMS, label: t('inventory.all_items'), count: total },
      ...groups.map((group) => ({
        id: group.container.id,
        label: names.get(group.container.id) ?? group.container.name,
        count: group.totalCount,
        depth: group.depth,
      })),
    ],
    [groups, names, t, total],
  )

  const active = tabs.some((tab) => tab.id === selectedBag) ? selectedBag : ALL_ITEMS
  const group = groups.find((entry) => entry.container.id === active) ?? null
  const shown = (group?.items ?? everything).filter((item) => matchesSearch(item, search))
  const current = shown.find((item) => item.key === selectedKey) ?? shown[0] ?? null

  const elsewhere =
    search !== '' && shown.length === 0
      ? everything.filter((item) => matchesSearch(item, search)).length
      : 0

  function pick(type: string) {
    setSelectedKey(type)
    requestAnimationFrame(() => {
      if (window.matchMedia('(max-width: 1023px)').matches) {
        inspector.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    })
  }

  function openBag(id: string) {
    setSelectedBag(id)
    setSelectedKey(null)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.survivor')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('inventory.title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('inventory.description')}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link
            to="/me/vault"
            className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase transition-colors hover:text-hazard"
          >
            {t('inventory.open_vault')}
          </Link>
          <Link
            to="/auctions"
            className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase transition-colors hover:text-hazard"
          >
            {t('inventory.open_auctions')}
          </Link>
        </div>
      </header>

      {isPending ? (
        <Skeleton className="min-h-0 flex-1" />
      ) : !snapshot ? (
        <Panel bracketed className="flex min-h-0 flex-1 flex-col items-center justify-center p-10 text-center">
          <Backpack aria-hidden="true" className="size-8 text-dust" strokeWidth={1.25} />
          <h2 className="display mt-4 text-2xl text-bone">{t('inventory.empty_title')}</h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-smoke">
            {t('inventory.empty_body')}
          </p>
        </Panel>
      ) : (
        <>
          <Load
            snapshot={snapshot}
            reportedAt={data?.reported_at ?? null}
            online={data?.online ?? false}
            holds={holds}
            onNotice={setNotice}
            onError={setError}
          />

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
              placeholder={t('inventory.search')}
              aria-label={t('inventory.search')}
              className="h-11 w-full border border-fence-bright bg-void pr-3 pl-9 font-mono text-sm text-bone transition-colors placeholder:text-dust focus:border-hazard"
            />
          </label>

          <TabStrip
            items={tabs}
            active={active}
            onSelect={(id) => {
              setSelectedBag(id)
              setSelectedKey(null)
            }}
            label={t('inventory.containers')}
            className="shrink-0"
          />

          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(16rem,26rem)_minmax(0,1fr)]">
            <Panel bracketed className="flex min-h-0 flex-col">
              <PanelHeader
                label={
                  group
                    ? (names.get(group.container.id) ?? group.container.name)
                    : t('inventory.all_items')
                }
                action={
                  group && group.container.weight !== null && group.container.capacity !== null ? (
                    <span className="font-mono text-[0.6875rem] tabular-nums text-dust">
                      {decimal(group.container.weight, intlLocale)} /{' '}
                      {decimal(group.container.capacity, intlLocale)}
                      {group.container.worn ? ` · ${t('inventory.worn')}` : ''}
                    </span>
                  ) : (
                    <span className="font-mono text-[0.6875rem] text-dust">
                      {t('inventory.item_count', { count: formatNumber(shown.length, intlLocale) })}
                    </span>
                  )
                }
              />
              <TabPanel id={active} className="flex min-h-0 flex-1 flex-col">
                {shown.length === 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
                    <p className="text-sm text-dust">
                      {search === '' ? t('inventory.container_empty') : t('inventory.no_matches')}
                    </p>
                    {elsewhere > 0 ? (
                      <>
                        <p className="mt-2 text-sm text-smoke">
                          {elsewhere === 1
                            ? t('inventory.match_elsewhere_one')
                            : t('inventory.matches_elsewhere_other', {
                                count: formatNumber(elsewhere, intlLocale),
                              })}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-4"
                          onClick={() => {
                            setSelectedBag(ALL_ITEMS)
                            setSelectedKey(null)
                          }}
                        >
                          {t('inventory.show_all_matches')}
                        </Button>
                      </>
                    ) : null}
                  </div>
                ) : (
                  <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
                    {shown.map((item) => {
                      const inside =
                        item.opens && snapshot
                          ? cargoCount(snapshot.items, item.opens)
                          : 0
                      return (
                        <li key={item.key}>
                          <button
                            type="button"
                            onClick={() => pick(item.key)}
                            aria-current={current?.key === item.key ? 'true' : undefined}
                            className={cn(
                              'flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-ash-raised',
                              current?.key === item.key ? 'bg-hazard-soft' : '',
                            )}
                          >
                            {item.opens ? (
                              <Box
                                aria-hidden="true"
                                className="mt-0.5 size-4 shrink-0 text-hazard"
                                strokeWidth={1.5}
                              />
                            ) : (
                              <Package
                                aria-hidden="true"
                                className="mt-0.5 size-4 shrink-0 text-dust"
                                strokeWidth={1.5}
                              />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline gap-1.5">
                                <span className="truncate text-sm text-bone">{item.name}</span>
                                {item.count > 1 ? (
                                  <span className="shrink-0 font-mono text-xs text-smoke">
                                    ×{item.count}
                                  </span>
                                ) : null}
                              </span>
                              <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 font-mono text-[0.6875rem] tracking-wide uppercase">
                                <span className="text-dust">{item.category}</span>
                                {!group && item.where.length > 0 ? (
                                  <span className="text-smoke">
                                    ·{' '}
                                    {item.where
                                      .map((id) => names.get(id))
                                      .filter((name) => name !== undefined)
                                      .join(', ')}
                                  </span>
                                ) : null}
                                {inside > 0 ? (
                                  <span className="text-hazard">
                                    · {t('inventory.bag_inside', { count: inside })}
                                  </span>
                                ) : null}
                              </span>
                            </span>
                            {item.condition === null ? null : (
                              <span className="mt-0.5 flex w-16 shrink-0 items-center gap-2 sm:w-20">
                                <Bar className="flex-1" fraction={wearFraction(item.condition)} />
                                <span
                                  className={cn(
                                    'w-8 text-right font-mono text-[0.6875rem] tabular-nums',
                                    conditionTone(wearPercent(item.condition)),
                                  )}
                                >
                                  {wearPercent(item.condition)}%
                                </span>
                              </span>
                            )}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </TabPanel>
            </Panel>

            <Panel ref={inspector} bracketed className="flex min-h-0 flex-col overflow-y-auto">
              {current ? (
                <Inspector
                  item={current}
                  locations={
                    group
                      ? null
                      : current.where
                          .map((id) => names.get(id))
                          .filter((name) => name !== undefined)
                          .join(', ')
                  }
                  inside={
                    current.opens && snapshot
                      ? cargoCount(snapshot.items, current.opens)
                      : 0
                  }
                  onOpen={
                    current.opens && names.has(current.opens)
                      ? () => openBag(current.opens!)
                      : null
                  }
                  onStore={() => setStoring(current)}
                  onList={() => setListing(current)}
                />
              ) : (
                <p className="p-6 text-sm text-dust">{t('inventory.pick')}</p>
              )}
            </Panel>
          </div>
        </>
      )}

      <ListFromPack
        key={listing?.key ?? 'none'}
        item={listing}
        onClose={() => setListing(null)}
        onListed={() => setListing(null)}
      />
      <StoreInVaultDialog
        key={storing ? `vault-${storing.key}` : 'vault-none'}
        item={storing}
        onClose={() => setStoring(null)}
        onStored={() => setStoring(null)}
      />
    </section>
  )
}

function decimal(value: number, locale: string): string {
  return value.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

function Load({
  snapshot,
  reportedAt,
  online,
  holds,
  onNotice,
  onError,
}: {
  snapshot: InventorySnapshot
  reportedAt: string | null
  online: boolean
  holds: InventoryHold[]
  onNotice: (value: string | null) => void
  onError: (value: string | null) => void
}) {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()

  const refresh = useMutation({
    mutationFn: api.refreshInventory,
    onSuccess: () => {
      onError(null)
      onNotice(t('inventory.refresh_queued'))
      void queryClient.invalidateQueries({ queryKey: ['me', 'inventory'] })
    },
    onError: (cause) => {
      onNotice(null)
      onError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  const total = snapshot.items.reduce((sum, item) => sum + item.count, 0)
  const overloaded = snapshot.weight > snapshot.max_weight
  const loadFraction = snapshot.max_weight > 0 ? snapshot.weight / snapshot.max_weight : 0

  return (
    <Panel bracketed className="shrink-0">
      <div className="grid divide-y divide-fence sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex items-center gap-1.5 font-mono text-[0.625rem] tracking-widest text-dust uppercase">
              <Weight aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
              {t('gear.carry_load')}
            </span>
            <span
              className={cn(
                'font-mono text-sm tabular-nums',
                overloaded ? 'text-blood' : 'text-bone',
              )}
            >
              {decimal(snapshot.weight, intlLocale)} / {decimal(snapshot.max_weight, intlLocale)}
            </span>
          </div>
          <div
            className="mt-2"
            role="meter"
            aria-label={t('gear.carry_load')}
            aria-valuemin={0}
            aria-valuemax={Math.round(snapshot.max_weight)}
            aria-valuenow={Math.round(snapshot.weight)}
          >
            <Bar className="mt-0" fraction={loadFraction} invert />
          </div>
          {overloaded ? (
            <p className="mt-2 font-mono text-[0.6875rem] text-blood">{t('inventory.overloaded')}</p>
          ) : null}
        </div>
        <Fact
          label={t('inventory.load')}
          value={t('inventory.item_count', { count: formatNumber(total, intlLocale) })}
          icon={Package}
        />
        <div className="flex items-center justify-between gap-3 p-4">
          <div>
            <p className="font-mono text-[0.625rem] tracking-widest text-dust uppercase">
              {t('inventory.age')}
            </p>
            <p className="mt-1 font-mono text-sm text-bone">
              {online ? t('inventory.online_now') : t('inventory.offline_now')}
            </p>
            {reportedAt ? (
              <p className="mt-1 font-mono text-[0.6875rem] text-dust">
                {formatRelativeTime(reportedAt, intlLocale)}
              </p>
            ) : null}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refresh.mutate()}
            disabled={!online || refresh.isPending}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn('size-3.5', refresh.isPending && 'animate-spin')}
            />
            {t('inventory.refresh')}
          </Button>
        </div>
      </div>
      {!online ? (
        <p className="border-t border-fence px-4 py-2 text-xs text-dust">{t('inventory.offline_ok')}</p>
      ) : null}
      {holds.length > 0 ? (
        <div className="border-t border-fence px-4 py-3">
          <p className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
            {t('inventory.holds')}
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {holds.map((hold) => (
              <li key={`${hold.kind}-${hold.item_type}`} className="font-mono text-[0.6875rem] text-smoke">
                {hold.item_name} ×{hold.quantity}
                {' · '}
                {hold.kind.endsWith('_give') || hold.kind === 'store_give'
                  ? t('inventory.hold_give')
                  : t('inventory.hold_take')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  )
}

function Inspector({
  item,
  locations,
  inside,
  onOpen,
  onStore,
  onList,
}: {
  item: StackedItem
  locations: string | null
  inside: number
  onOpen: (() => void) | null
  onStore: () => void
  onList: () => void
}) {
  const { t } = useTranslation()

  return (
    <>
      <PanelHeader
        label={item.category}
        action={
          item.equipped ? (
            <span className="border border-hazard/40 bg-hazard-soft px-1.5 py-0.5 font-mono text-[0.625rem] tracking-wide text-hazard uppercase">
              {t('inventory.equipped')}
            </span>
          ) : item.opens ? (
            <span className="flex items-center gap-1 font-mono text-[0.625rem] tracking-widest text-dust uppercase">
              <Box aria-hidden="true" className="size-3" strokeWidth={1.5} />
              {t('inventory.containers')}
            </span>
          ) : null
        }
      />
      <div className="flex flex-col gap-5 p-5">
        <div>
          <h2 className="display text-2xl text-bone">{item.name}</h2>
          <p className="mt-1 font-mono text-[0.6875rem] text-dust">{item.full_type}</p>
        </div>

        {item.condition === null ? null : (
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[0.625rem] tracking-widest text-dust uppercase">
                {t('economy.condition')}
              </span>
              <span
                className={cn(
                  'font-mono text-sm tabular-nums',
                  conditionTone(wearPercent(item.condition)),
                )}
              >
                {wearPercent(item.condition)}%
              </span>
            </div>
            <Bar className="mt-2" fraction={wearFraction(item.condition)} />
          </div>
        )}

        <dl className="grid gap-3 sm:grid-cols-2">
          <Meta label={t('economy.quantity')} value={`×${item.count}`} />
          <Meta label={t('inventory.category')} value={item.category} />
          {locations ? <Meta label={t('inventory.where')} value={locations} /> : null}
          {inside > 0 ? (
            <Meta label={t('inventory.bag_inside', { count: inside })} value={String(inside)} />
          ) : null}
        </dl>

        {item.opens ? (
          <p className="text-xs leading-relaxed text-dust">{t('inventory.store_bag_hint')}</p>
        ) : (
          <p className="text-xs leading-relaxed text-dust">{t('inventory.list_hint')}</p>
        )}

        <div className="flex flex-wrap gap-2">
          {onOpen ? (
            <Button variant="outline" onClick={onOpen}>
              <Box aria-hidden="true" className="size-3.5" />
              {t('inventory.look_inside')}
            </Button>
          ) : null}
          <Button variant="outline" onClick={onStore}>
            <Vault aria-hidden="true" className="size-3.5" />
            {t('inventory.store_vault')}
          </Button>
          <Button onClick={onList}>
            <Tag aria-hidden="true" className="size-3.5" />
            {t('inventory.list')}
          </Button>
        </div>
      </div>
    </>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[0.625rem] tracking-widest text-dust uppercase">{label}</dt>
      <dd className="mt-1 text-sm text-bone">{value}</dd>
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
  icon: typeof Package
}) {
  return (
    <div className="flex items-center gap-3 p-4">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-dust" strokeWidth={1.5} />
      <div>
        <p className="font-mono text-[0.625rem] tracking-widest text-dust uppercase">{label}</p>
        <p className="mt-1 font-mono text-sm text-bone">{value}</p>
      </div>
    </div>
  )
}

function ListFromPack({
  item,
  onClose,
  onListed,
}: {
  item: StackedItem | null
  onClose: () => void
  onListed: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [quantity, setQuantity] = useState(1)
  const [start, setStart] = useState(10)
  const [buyout, setBuyout] = useState('')
  const [hours, setHours] = useState(24)
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => {
      if (!item) throw new Error('missing item')
      return api.listAuction({
        item_type: item.full_type,
        item_name: item.name,
        quantity,
        condition: item.condition,
        start_price: start,
        buyout_price: buyout ? Number(buyout) : null,
        hours,
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me', 'inventory'] })
      await queryClient.invalidateQueries({ queryKey: ['auctions'] })
      onListed()
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  return (
    <ConfirmDialog
      open={item !== null}
      size="lg"
      title={item ? item.name : t('economy.list_item')}
      description={
        <div className="flex flex-col gap-3">
          <p className="text-xs text-dust">{t('economy.offline_list')}</p>
          {error ? <p className="text-sm text-blood">{error}</p> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              type="number"
              min={1}
              max={item?.count ?? 1}
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
          </div>
          <div className="flex gap-1.5">
            {[12, 24, 48].map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setHours(value)}
                className={cn(
                  'border px-2 py-1 font-mono text-[0.6875rem]',
                  hours === value
                    ? 'border-hazard bg-hazard-soft text-hazard'
                    : 'border-fence text-dust',
                )}
              >
                {t('economy.duration_hours', { count: value })}
              </button>
            ))}
          </div>
        </div>
      }
      confirmLabel={t('economy.list_item')}
      busy={create.isPending}
      confirmDisabled={item === null || start < 1}
      onConfirm={() => create.mutate()}
      onClose={onClose}
    />
  )
}
