import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Backpack,
  Box,
  ChevronRight,
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
import { TabPanel, TabStrip } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { conditionTone } from '@/lib/condition-tone'
import { formatNumber, formatRelativeTime } from '@/lib/format'
import { ALL_ITEMS, groupByContainer, matchesSearch, POCKETS, stackItems } from '@/lib/inventory'
import { myInventoryQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TabItem } from '@/components/ui/tabs'
import type { InventorySnapshot } from '@/lib/api'
import type { StackedItem } from '@/lib/inventory'

/**
 * What the player is carrying.
 *
 * A snapshot rather than a live feed: the mod writes one while you play, and
 * the page can ask for a fresh one. Everything is therefore stamped with when
 * it was taken — an inventory that looks live but is an hour old is worse than
 * one that admits its age.
 *
 * One container at a time, picked from a tab strip, the way the game shows it.
 * Stacking every bag down the page turned a loaded survivor into a very long
 * scroll and lost the shape of the tree entirely on a phone.
 */
export function InventoryPage() {
  const { t, intlLocale } = useTranslation()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string>(ALL_ITEMS)

  const { data, isPending } = useQuery(myInventoryQuery)
  const snapshot = data?.snapshot ?? null

  const groups = useMemo(
    () => (snapshot ? groupByContainer(snapshot.items, snapshot.containers) : []),
    [snapshot],
  )

  /** Container id to the name we show for it. */
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

  /** Everything, stacked across containers, for the first tab. */
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

  // A fresh snapshot can drop the bag we were looking at — you dropped it.
  // Derived rather than reset in an effect, so there is never a frame showing
  // a tab that no longer exists.
  const active = tabs.some((tab) => tab.id === selected) ? selected : ALL_ITEMS

  const group = groups.find((entry) => entry.container.id === active) ?? null
  const shown = (group?.items ?? everything).filter((item) => matchesSearch(item, search))

  // When a search comes up empty in this bag, say whether it would hit in
  // another one. Opening six tabs by hand is the thing search is here to avoid.
  const elsewhere =
    search !== '' && shown.length === 0
      ? everything.filter((item) => matchesSearch(item, search)).length
      : 0

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
          <div className="flex flex-col gap-5">
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

            <TabStrip
              items={tabs}
              active={active}
              onSelect={setSelected}
              label={t('inventory.containers')}
            />

            <TabPanel id={active}>
              <Panel bracketed>
                <PanelHeader
                  label={
                    group
                      ? (names.get(group.container.id) ?? group.container.name)
                      : t('inventory.all_items')
                  }
                  // The tab already carries the count, so the header says the
                  // thing a tab cannot: how full this particular bag is.
                  action={
                    group ? (
                      <span className="flex items-center gap-3 font-mono text-[0.6875rem] text-dust">
                        {group.container.worn ? (
                          <span className="flex items-center gap-1">
                            <Shirt aria-hidden="true" className="size-3" strokeWidth={1.5} />
                            {t('inventory.worn')}
                          </span>
                        ) : null}

                        {group.container.weight !== null && group.container.capacity !== null ? (
                          <span className="tabular-nums">
                            {decimal(group.container.weight, intlLocale)} /{' '}
                            {decimal(group.container.capacity, intlLocale)}
                          </span>
                        ) : null}
                      </span>
                    ) : null
                  }
                />

                {shown.length === 0 ? (
                  <div className="p-8 text-center sm:p-10">
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
                          onClick={() => setSelected(ALL_ITEMS)}
                        >
                          {t('inventory.show_all_matches')}
                        </Button>
                      </>
                    ) : null}
                  </div>
                ) : (
                  <ul className="divide-y divide-fence">
                    {shown.map((item) => (
                      <ItemRow
                        key={item.full_type}
                        item={item}
                        // Where it lives is only news in the everything view.
                        locations={
                          group
                            ? null
                            : item.where
                                .map((id) => names.get(id))
                                .filter((name) => name !== undefined)
                                .join(', ')
                        }
                        onOpen={
                          item.opens && names.has(item.opens)
                            ? () => setSelected(item.opens!)
                            : null
                        }
                      />
                    ))}
                  </ul>
                )}
              </Panel>
            </TabPanel>
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

/** One decimal place, in the reader's locale. */
function decimal(value: number, locale: string): string {
  return value.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
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

      <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-end sm:justify-between sm:p-6">
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
              {decimal(snapshot.weight, intlLocale)} / {decimal(snapshot.max_weight, intlLocale)}
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

        <div className="shrink-0 sm:max-w-56 sm:text-right">
          <Button
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => refresh.mutate()}
            disabled={!online || refresh.isPending}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn('size-3.5', refresh.isPending && 'animate-spin')}
            />
            {t('inventory.refresh')}
          </Button>

          {/* Offline is the common case and the button cannot work then, so the
              dead control gets a reason rather than a tooltip nobody hovers. */}
          {!online ? (
            <p className="mt-2 text-xs text-dust">{t('inventory.refresh_offline')}</p>
          ) : refresh.isSuccess ? (
            <p role="status" className="mt-2 text-xs text-moss">
              {t('inventory.refresh_queued')}
            </p>
          ) : refresh.isError ? (
            <p role="alert" className="mt-2 text-xs text-blood">
              {refresh.error.message}
            </p>
          ) : null}
        </div>
      </div>
    </Panel>
  )
}

/**
 * One line per item type.
 *
 * Two rows on a phone and one on a desktop: the name and count lead, and
 * everything that qualifies them sits underneath rather than being squeezed
 * onto the same line until the name truncates to nothing.
 */
function ItemRow({
  item,
  locations,
  onOpen,
}: {
  item: StackedItem
  /** Container names, when the row is shown outside its own container. */
  locations: string | null
  /** Set when this item is a bag with a tab of its own. */
  onOpen: (() => void) | null
}) {
  const { t } = useTranslation()

  const body = (
    <>
      {item.opens ? (
        <Box aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-hazard" strokeWidth={1.5} />
      ) : (
        <Package aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-dust" strokeWidth={1.5} />
      )}

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-sm text-bone">{item.name}</span>
          {item.count > 1 ? (
            <span className="shrink-0 font-mono text-xs text-smoke">×{item.count}</span>
          ) : null}
        </span>

        <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 font-mono text-[0.6875rem] tracking-wide uppercase">
          <span className="text-dust">{item.category}</span>
          {locations ? <span className="text-smoke">· {locations}</span> : null}
        </span>
      </span>

      <span className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        {item.equipped ? (
          <span className="border border-hazard/40 bg-hazard-soft px-1.5 py-0.5 font-mono text-[0.625rem] tracking-wide text-hazard uppercase">
            {t('inventory.equipped')}
          </span>
        ) : null}

        {item.condition === null ? null : (
          <span className="flex w-[4.5rem] items-center gap-2 sm:w-24">
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
      </span>

      {onOpen ? (
        <ChevronRight
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-dust transition-colors group-hover:text-hazard"
          strokeWidth={1.5}
        />
      ) : null}
    </>
  )

  return (
    <li>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('inventory.open_container', { name: item.name })}
          className="group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-ash-raised"
        >
          {body}
        </button>
      ) : (
        <div className="flex items-start gap-3 px-4 py-3">{body}</div>
      )}
    </li>
  )
}
