import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError } from '@/components/ui/field'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, type AuctionListing } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import { stackItems } from '@/lib/inventory'
import { auctionsQuery, myAuctionsQuery, myInventoryQuery, myWalletQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

function statusKey(status: string): TranslationKey {
  if (status === 'collecting') return 'economy.status_collecting'
  if (status === 'sold') return 'economy.status_sold'
  if (status === 'expired') return 'economy.status_expired'
  if (status === 'cancelled') return 'economy.status_cancelled'
  if (status === 'failed') return 'economy.status_failed'
  return 'economy.status_live'
}

/**
 * Player-to-player market. The item leaves the pack first, then others bid.
 */
export function AuctionsPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const live = useQuery(auctionsQuery)
  const mine = useQuery(myAuctionsQuery)
  const wallet = useQuery(myWalletQuery)
  const inventory = useQuery(myInventoryQuery)
  const [listing, setListing] = useState(false)
  const [selected, setSelected] = useState<AuctionListing | null>(null)
  const [bid, setBid] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const stacks = useMemo(
    () => (inventory.data?.snapshot ? stackItems(inventory.data.snapshot.items) : []),
    [inventory.data],
  )

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['auctions'] })
    await queryClient.invalidateQueries({ queryKey: ['me', 'wallet'] })
  }

  function fail(cause: unknown) {
    setNotice(null)
    setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
  }

  const placed = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('missing listing')
      return api.bidAuction(selected.id, Number(bid) || selected.next_bid)
    },
    onSuccess: async (row) => {
      setSelected(row)
      setBid(String(row.next_bid))
      setError(null)
      setNotice(t('economy.bid_placed'))
      await refresh()
    },
    onError: fail,
  })

  const bought = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('missing listing')
      return api.buyoutAuction(selected.id)
    },
    onSuccess: async (row) => {
      setSelected(row)
      setError(null)
      setNotice(t('economy.bought'))
      await refresh()
    },
    onError: fail,
  })

  const cancelled = useMutation({
    mutationFn: (id: string) => api.cancelAuction(id),
    onSuccess: async () => {
      setSelected(null)
      setError(null)
      setNotice(t('economy.cancelled'))
      await refresh()
    },
    onError: fail,
  })

  return (
    <Section>
      <Container>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <SectionHeading
            eyebrow={t('nav.group.holdings')}
            title={t('economy.auction_title')}
            description={t('economy.auction_description')}
          />
          <Button size="sm" onClick={() => setListing(true)}>
            {t('economy.list_item')}
          </Button>
        </div>

        {wallet.data ? (
          <p className="mb-3 font-mono text-sm text-smoke">
            {t('economy.available')}: {t('economy.coins', { count: wallet.data.available })}
            <span className="ml-3 text-dust">{t('economy.house_fee')}</span>
          </p>
        ) : null}

        {notice ? (
          <p role="status" className="mb-3 border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
            {notice}
          </p>
        ) : null}
        {error ? <FormError>{error}</FormError> : null}

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
          <Panel bracketed>
            <PanelHeader label={t('economy.listings')} />
            {live.isPending ? (
              <Skeleton className="m-5 h-32" />
            ) : (live.data ?? []).length === 0 ? (
              <p className="p-5 text-sm text-dust">{t('economy.no_listings')}</p>
            ) : (
              <ul className="divide-y divide-fence">
                {(live.data ?? []).map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(row)
                        setBid(String(row.next_bid))
                      }}
                      className={cn(
                        'flex w-full flex-col items-start gap-1 px-4 py-3 text-left',
                        selected?.id === row.id ? 'bg-hazard-soft' : 'hover:bg-ash-raised',
                      )}
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="text-sm text-bone">
                          {row.item_name}
                          {row.quantity > 1 ? ` ×${row.quantity}` : ''}
                        </span>
                        <span className="font-mono text-[0.625rem] tracking-widest uppercase text-hazard">
                          {t(statusKey(row.status))}
                        </span>
                      </span>
                      <span className="font-mono text-[0.6875rem] text-dust">
                        {t('economy.coins', { count: row.current_price })} · {row.seller}
                        {' · '}
                        {formatRelativeTime(row.ends_at, intlLocale)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel bracketed>
            {selected ? (
              <div className="flex flex-col gap-4 p-5">
                <div>
                  <h2 className="text-xl text-bone">{selected.item_name}</h2>
                  <p className="font-mono text-[0.6875rem] text-dust">{selected.item_type}</p>
                </div>
                <dl className="grid gap-2 text-sm">
                  <Row label={t('economy.seller')} value={selected.seller} />
                  <Row
                    label={t('economy.current_bid')}
                    value={t('economy.coins', { count: selected.current_price })}
                  />
                  <Row
                    label={t('economy.buyout')}
                    value={
                      selected.buyout_price
                        ? t('economy.coins', { count: selected.buyout_price })
                        : t('economy.no_buyout')
                    }
                  />
                  <Row label={t('economy.ends')} value={formatDateTime(selected.ends_at, intlLocale)} />
                </dl>
                {selected.status === 'live' && !selected.mine ? (
                  <>
                    <Field
                      type="number"
                      min={selected.next_bid}
                      label={t('economy.bid_amount')}
                      value={bid}
                      onChange={(event) => setBid(event.target.value)}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={placed.isPending}
                        onClick={() => placed.mutate()}
                      >
                        {t('economy.bid')}
                      </Button>
                      {selected.buyout_price ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={bought.isPending}
                          onClick={() => bought.mutate()}
                        >
                          {t('economy.buy_now')}
                        </Button>
                      ) : null}
                    </div>
                  </>
                ) : null}
                {selected.mine && (selected.status === 'live' || selected.status === 'collecting') ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-blood text-blood"
                    disabled={cancelled.isPending}
                    onClick={() => cancelled.mutate(selected.id)}
                  >
                    {t('economy.cancel_listing')}
                  </Button>
                ) : null}
              </div>
            ) : (
              <>
                <PanelHeader label={t('economy.my_listings')} />
                {(mine.data ?? []).length === 0 ? (
                  <p className="p-5 text-sm text-dust">{t('economy.no_listings')}</p>
                ) : (
                  <ul className="divide-y divide-fence">
                    {(mine.data ?? []).slice(0, 8).map((row) => (
                      <li key={row.id} className="px-5 py-3 text-sm text-smoke">
                        {row.item_name} · {t(statusKey(row.status))}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Panel>
        </div>
      </Container>

      <ListDialog
        open={listing}
        stacks={stacks}
        onClose={() => setListing(false)}
        onListed={async () => {
          setListing(false)
          setNotice(t('economy.listed'))
          await refresh()
        }}
        onError={fail}
      />
    </Section>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-dust">{label}</dt>
      <dd className="font-mono text-bone">{value}</dd>
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
