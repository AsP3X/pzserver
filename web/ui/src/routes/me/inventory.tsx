import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Backpack,
  Box,
  Package,
  RefreshCw,
  Search,
  Shirt,
  Weight,
} from 'lucide-react'

import { Bar } from '@/components/ui/bar'
import { Button } from '@/components/ui/button'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { conditionTone } from '@/lib/condition-tone'
import { formatNumber, formatRelativeTime } from '@/lib/format'
import { groupByContainer, matchesSearch, POCKETS } from '@/lib/inventory'
import { myInventoryQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { InventorySnapshot } from '@/lib/api'
import type { ContainerGroup, StackedItem } from '@/lib/inventory'

/**
 * What the player is carrying.
 *
 * A snapshot rather than a live feed: the mod writes one while you play, and
 * the page can ask for a fresh one. Everything is therefore stamped with when
 * it was taken — an inventory that looks live but is an hour old is worse than
 * one that admits its age.
 */
export function InventoryPage() {
  const { t, intlLocale } = useTranslation()
  const [search, setSearch] = useState('')

  const { data, isPending } = useQuery(myInventoryQuery)
  const snapshot = data?.snapshot ?? null

  const groups = useMemo(
    () => (snapshot ? groupByContainer(snapshot.items, snapshot.containers) : []),
    [snapshot],
  )

  const visible = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => matchesSearch(item, search)),
        }))
        // A bag with nothing matching is noise while searching, but its own
        // heading is still worth keeping when the search is empty.
        .filter((group) => search === '' || group.items.length > 0),
    [groups, search],
  )

  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow={t('nav.inventory')}
          title={t('inventory.title')}
          description={t('inventory.description')}
        />

        {isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : snapshot ? (
          <div className="flex flex-col gap-6">
            <Load
              snapshot={snapshot}
              reportedAt={data?.reported_at ?? null}
              online={data?.online ?? false}
            />

            <label className="relative block">
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

            {visible.length === 0 ? (
              <Panel className="p-10 text-center">
                <p className="text-sm text-dust">{t('inventory.no_matches')}</p>
              </Panel>
            ) : (
              visible.map((group) => (
                <ContainerPanel key={group.container.id} group={group} locale={intlLocale} />
              ))
            )}
          </div>
        ) : (
          <Panel bracketed className="p-10 text-center">
            <Backpack aria-hidden="true" className="mx-auto size-8 text-dust" strokeWidth={1.25} />
            <h3 className="display mt-4 text-2xl text-bone">{t('inventory.empty_title')}</h3>
            <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-smoke">
              {t('inventory.empty_body')}
            </p>
          </Panel>
        )}
      </Container>
    </Section>
  )
}

/** Carried weight, item count and how old the reading is. */
function Load({
  snapshot,
  reportedAt,
  online,
}: {
  snapshot: InventorySnapshot
  reportedAt: string | null
  online: boolean
}) {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()

  const refresh = useMutation({
    mutationFn: api.refreshInventory,
    onSuccess: () => {
      // The mod answers by writing a file, so there is nothing to read back
      // yet — the poll picks it up a tick or two later.
      void queryClient.invalidateQueries({ queryKey: ['me', 'inventory'] })
    },
  })

  const total = snapshot.items.reduce((sum, item) => sum + item.count, 0)
  const overloaded = snapshot.weight > snapshot.max_weight

  const weight = (value: number) =>
    value.toLocaleString(intlLocale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })

  return (
    <Panel bracketed>
      <PanelHeader
        label={t('inventory.load')}
        action={
          reportedAt ? (
            <span className="font-mono text-[0.6875rem] text-dust">
              {formatRelativeTime(reportedAt, intlLocale)}
            </span>
          ) : null
        }
      />

      <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex items-center gap-1.5 text-sm text-smoke">
              <Weight aria-hidden="true" className="size-3.5 text-dust" strokeWidth={1.5} />
              {t('gear.carry_load')}
            </span>
            <span
              className={cn(
                'font-mono text-sm tabular-nums',
                overloaded ? 'text-blood' : 'text-bone',
              )}
            >
              {weight(snapshot.weight)} / {weight(snapshot.max_weight)}
            </span>
          </div>

          <Bar
            className="mt-2"
            fraction={snapshot.max_weight > 0 ? snapshot.weight / snapshot.max_weight : 0}
            invert
          />

          <p className="mt-2 font-mono text-xs text-dust">
            {t('inventory.item_count', { count: formatNumber(total, intlLocale) })}
            {overloaded ? (
              <span className="ml-2 text-blood">{t('inventory.overloaded')}</span>
            ) : null}
          </p>
        </div>

        <div className="shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refresh.mutate()}
            disabled={!online || refresh.isPending}
            // Offline is the common case and the button cannot work then; say
            // so on hover rather than leaving a dead control.
            title={online ? undefined : t('inventory.refresh_offline')}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn('size-3.5', refresh.isPending && 'animate-spin')}
            />
            {t('inventory.refresh')}
          </Button>

          {!online ? (
            <p className="mt-2 max-w-48 text-right text-xs text-dust">
              {t('inventory.refresh_offline')}
            </p>
          ) : refresh.isSuccess ? (
            <p role="status" className="mt-2 max-w-48 text-right text-xs text-moss">
              {t('inventory.refresh_queued')}
            </p>
          ) : refresh.isError ? (
            <p role="alert" className="mt-2 max-w-48 text-right text-xs text-blood">
              {refresh.error.message}
            </p>
          ) : null}
        </div>
      </div>
    </Panel>
  )
}

function ContainerPanel({ group, locale }: { group: ContainerGroup; locale: string }) {
  const { t } = useTranslation()

  const isPockets = group.container.id === POCKETS
  const name = isPockets ? t('inventory.pockets') : group.container.name

  const weight = (value: number) =>
    value.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })

  return (
    <div
      // Nested bags are indented, so the tree reads without drawing lines.
      style={{ marginLeft: `${Math.min(group.depth, 3) * 1.5}rem` }}
    >
      <Panel bracketed={group.depth === 0}>
        <PanelHeader
          label={name}
          action={
            <span className="flex items-center gap-3 font-mono text-[0.6875rem] text-dust">
              {group.container.worn ? (
                <span className="flex items-center gap-1">
                  <Shirt aria-hidden="true" className="size-3" strokeWidth={1.5} />
                  {t('inventory.worn')}
                </span>
              ) : null}

              {group.container.weight !== null && group.container.capacity !== null ? (
                <span className="tabular-nums">
                  {weight(group.container.weight)} / {weight(group.container.capacity)}
                </span>
              ) : null}

              <span className="tabular-nums">
                {t('inventory.item_count', { count: formatNumber(group.totalCount, locale) })}
              </span>
            </span>
          }
        />

        {group.items.length === 0 ? (
          <p className="p-5 text-sm text-dust">{t('inventory.container_empty')}</p>
        ) : (
          <ul className="divide-y divide-fence">
            {group.items.map((item) => (
              <ItemRow key={item.full_type} item={item} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

function ItemRow({ item }: { item: StackedItem }) {
  const { t } = useTranslation()

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5">
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        {item.opens ? (
          <Box aria-hidden="true" className="size-3.5 shrink-0 text-hazard" strokeWidth={1.5} />
        ) : (
          <Package aria-hidden="true" className="size-3.5 shrink-0 text-dust" strokeWidth={1.5} />
        )}

        <span className="min-w-0">
          <span className="block truncate text-sm text-bone">
            {item.name}
            {item.count > 1 ? (
              <span className="ml-1.5 font-mono text-xs text-smoke">×{item.count}</span>
            ) : null}
          </span>
          <span className="block truncate font-mono text-[0.6875rem] tracking-wide text-dust uppercase">
            {item.category}
          </span>
        </span>
      </span>

      {item.equipped ? (
        <span className="border border-hazard/40 bg-hazard-soft px-1.5 py-0.5 font-mono text-[0.625rem] tracking-wide text-hazard uppercase">
          {t('inventory.equipped')}
        </span>
      ) : null}

      {item.condition === null ? null : (
        <span className="flex w-24 shrink-0 items-center gap-2">
          <Bar className="flex-1" fraction={item.condition / 100} />
          <span
            className={cn(
              'w-9 text-right font-mono text-xs tabular-nums',
              conditionTone(item.condition),
            )}
          >
            {Math.round(item.condition)}%
          </span>
        </span>
      )}
    </li>
  )
}
