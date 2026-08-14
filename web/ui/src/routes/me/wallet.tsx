import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Coins, Gift, Lock, Search, Trophy, Wallet } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Bar } from '@/components/ui/bar'
import { Button } from '@/components/ui/button'
import { FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { TabPanel, TabStrip } from '@/components/ui/tabs'
import {
  api,
  ApiError,
  type ObjectiveProgress,
  type RewardTask,
  type RewardsView,
  type WalletTransaction,
} from '@/lib/api'
import type { QuestNodeView, QuestProgress } from '@/lib/quest-graph'
import { cn } from '@/lib/cn'
import { formatCoins, formatDateTime, formatRelativeTime } from '@/lib/format'
import { fuzzyMatchWords } from '@/lib/fuzzy'
import { myRewardsQuery, myWalletQuery, myWalletTransactionsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TabItem } from '@/components/ui/tabs'
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
  { id: 'rewards', label: 'economy.filter_rewards' },
  { id: 'store', label: 'economy.filter_store' },
  { id: 'auction', label: 'economy.filter_auction' },
  { id: 'vault', label: 'economy.filter_vault' },
  { id: 'admin', label: 'economy.filter_admin' },
  { id: 'other', label: 'economy.filter_other' },
]

const TASK_LABELS: Record<string, TranslationKey> = {
  play: 'economy.task_play',
  cull: 'economy.task_cull',
  survive: 'economy.task_survive',
  spend: 'economy.task_spend',
  trade: 'economy.task_trade',
}

const KIND_LABELS: Record<string, TranslationKey> = {
  play: 'economy.objective_kind_play',
  kills: 'economy.objective_kind_kills',
  hours: 'economy.objective_kind_hours',
  spend: 'economy.objective_kind_spend',
  trade: 'economy.objective_kind_trade',
  manual: 'economy.objective_kind_manual',
}

type Surface = 'today' | 'objectives' | 'flows' | 'ledger'

function sourceKey(source: string): TranslationKey | null {
  return SOURCES[source] ?? null
}

function matchesFilter(filter: string, source: string): boolean {
  if (filter === 'all') return true
  if (filter === 'store') return source.startsWith('store')
  if (filter === 'auction') return source.startsWith('auction')
  if (filter === 'rewards') {
    return source === 'daily_reward' || source === 'quest' || source === 'level'
  }
  if (filter === 'vault') return source.startsWith('vault')
  if (filter === 'admin') return source === 'admin'
  return (
    !source.startsWith('store') &&
    !source.startsWith('auction') &&
    !source.startsWith('vault') &&
    source !== 'admin' &&
    source !== 'daily_reward' &&
    source !== 'quest' &&
    source !== 'level'
  )
}

function readyCount(items: { complete: boolean; claimed: boolean }[]): number {
  return items.filter((item) => item.complete && !item.claimed).length
}

/**
 * Coins, today's drop, and the XP rank.
 *
 * Daily claim and rank stay on the page. Tasks, staff objectives and the
 * ledger each get their own tab so they are not stacked into one inspector.
 */
export function WalletPage() {
  const { t, intlLocale } = useTranslation()
  const queryClient = useQueryClient()
  const wallet = useQuery(myWalletQuery)
  const ledger = useQuery(myWalletTransactionsQuery)
  const rewards = useQuery(myRewardsQuery)

  const [surface, setSurface] = useState<Surface>('today')
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [selectedTx, setSelectedTx] = useState<string | null>(null)
  const [selectedObjective, setSelectedObjective] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const rows = ledger.data ?? []
  const visible = useMemo(() => {
    const filtered = rows.filter((row) => matchesFilter(filter, row.source))
    if (search.trim() === '') {
      return filtered
    }

    return filtered.filter((row) => {
      const label = sourceKey(row.source)
      const text = [row.description ?? '', label ? t(label) : row.source, row.source].join(' ')
      return fuzzyMatchWords(search, text) !== null
    })
  }, [filter, rows, search, t])

  const currentTx = visible.find((row) => row.id === selectedTx) ?? null
  const objectives = rewards.data?.objectives ?? []
  const currentObjective =
    objectives.find((item) => item.id === selectedObjective) ?? objectives[0] ?? null

  const tabs = useMemo<TabItem<Surface>[]>(
    () => [
      {
        id: 'today',
        label: t('economy.tab_today'),
        count: readyCount(rewards.data?.tasks ?? []),
      },
      {
        id: 'objectives',
        label: t('economy.objectives_title'),
        count: readyCount(objectives),
      },
      {
        id: 'flows',
        label: t('economy.tab_flows'),
        count: (rewards.data?.quests ?? []).reduce(
          (sum, quest) =>
            sum +
            quest.nodes.filter(
              (node) =>
                node.unlocked &&
                !node.claimed &&
                ['task', 'objective', 'area', 'find', 'collect', 'kills'].includes(node.kind),
            ).length,
          0,
        ),
      },
      {
        id: 'ledger',
        label: t('economy.ledger'),
        count: visible.length,
      },
    ],
    [objectives, rewards.data?.tasks, t, visible.length],
  )

  function onClaimed(result: { rewards: RewardsView }) {
    setError(null)
    setNotice(t('economy.claimed'))
    queryClient.setQueryData(myRewardsQuery.queryKey, result.rewards)
    void queryClient.invalidateQueries({ queryKey: ['me', 'wallet'] })
    void queryClient.invalidateQueries({ queryKey: ['me', 'rewards'] })
  }

  function fail(cause: unknown) {
    setNotice(null)
    setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
  }

  const claim = useMutation({
    mutationFn: (key: string) => api.claimReward(key),
    onSuccess: onClaimed,
    onError: fail,
  })

  const claimObjective = useMutation({
    mutationFn: (id: string) => api.claimObjective(id),
    onSuccess: onClaimed,
    onError: fail,
  })

  const claimQuest = useMutation({
    mutationFn: ({ questId, nodeId }: { questId: string; nodeId: string }) =>
      api.claimQuestNode(questId, nodeId),
    onSuccess: onClaimed,
    onError: fail,
  })

  const pickQuest = useMutation({
    mutationFn: (questId: string) => api.claimQuest(questId),
    onSuccess: (result) => {
      onClaimed(result)
      setNotice(t('economy.flow_picked'))
    },
    onError: fail,
  })

  const busy = claim.isPending || claimObjective.isPending || claimQuest.isPending || pickQuest.isPending

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header>
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="hazard-tape h-1 w-8" />
          <span className="eyebrow">{t('nav.group.holdings')}</span>
        </div>
        <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('economy.wallet_title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-smoke">{t('economy.wallet_description')}</p>
      </header>

      {wallet.isPending ? (
        <Skeleton className="h-20 shrink-0" />
      ) : wallet.isError || !wallet.data ? (
        <FormError>{t('common.error')}</FormError>
      ) : (
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
      )}

      {notice ? (
        <p role="status" className="border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}

      {rewards.isPending ? (
        <Skeleton className="h-32 shrink-0" />
      ) : rewards.data ? (
        <div className="grid shrink-0 gap-3 lg:grid-cols-2">
          <DailyCard
            view={rewards.data}
            busy={busy}
            onClaim={() => claim.mutate('daily')}
          />
          <RankCard view={rewards.data} />
        </div>
      ) : null}

      <TabStrip
        items={tabs}
        active={surface}
        onSelect={setSurface}
        label={t('economy.wallet_title')}
        className="shrink-0"
      />

      <TabPanel id={surface} className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col">
          {surface === 'today' ? (
            <TodayBoard
              tasks={rewards.data?.tasks ?? []}
              pending={rewards.isPending}
              busy={busy}
              onClaim={(key) => claim.mutate(key)}
            />
          ) : null}

          {surface === 'objectives' ? (
            <ObjectiveBoard
              items={objectives}
              current={currentObjective}
              pending={rewards.isPending}
              busy={busy}
              onSelect={setSelectedObjective}
              onClaim={(id) => claimObjective.mutate(id)}
            />
          ) : null}

          {surface === 'flows' ? (
            <FlowBoard
              items={rewards.data?.quests ?? []}
              offers={rewards.data?.available_quests ?? []}
              pending={rewards.isPending}
              busy={busy}
              onClaim={(questId, nodeId) => claimQuest.mutate({ questId, nodeId })}
              onPickup={(questId) => pickQuest.mutate(questId)}
            />
          ) : null}

          {surface === 'ledger' ? (
            <LedgerBoard
              rows={visible}
              total={rows.length}
              current={currentTx}
              pending={ledger.isPending}
              filter={filter}
              search={search}
              onFilter={setFilter}
              onSearch={setSearch}
              onSelect={(id) => setSelectedTx((previous) => (previous === id ? null : id))}
            />
          ) : null}
        </div>
      </TabPanel>
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

function DailyCard({
  view,
  busy,
  onClaim,
}: {
  view: RewardsView
  busy: boolean
  onClaim: () => void
}) {
  const { t, intlLocale } = useTranslation()
  const { daily } = view

  return (
    <Panel bracketed>
      <PanelHeader
        label={t('economy.daily_title')}
        action={
          daily.streak > 0 ? (
            <span className="font-mono text-[0.6875rem] text-hazard">
              {t('economy.streak', { count: daily.streak })}
            </span>
          ) : null
        }
      />
      <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Gift aria-hidden="true" className="size-4 text-hazard" strokeWidth={1.5} />
            <p className="text-sm text-smoke">
              {t('economy.daily_body', { count: t('economy.coins', { count: daily.coins }) })}
            </p>
          </div>
          {daily.claimed_today ? (
            <p className="mt-2 font-mono text-[0.6875rem] text-dust">
              {t('economy.next_claim', {
                when: formatRelativeTime(daily.next_claim_at, intlLocale),
              })}
            </p>
          ) : null}
        </div>
        <Button size="sm" className="shrink-0" disabled={!daily.available || busy} onClick={onClaim}>
          <Coins aria-hidden="true" className="size-3.5" />
          {daily.claimed_today
            ? t('economy.claimed_today')
            : t('economy.claim_daily', { count: t('economy.coins', { count: daily.coins }) })}
        </Button>
      </div>
    </Panel>
  )
}

function RankCard({ view }: { view: RewardsView }) {
  const { t } = useTranslation()
  const { rank } = view

  return (
    <Panel bracketed>
      <PanelHeader
        label={t('economy.rank_title')}
        action={
          <span className="font-mono text-[0.6875rem] text-dust">
            {t('economy.xp', { count: rank.xp })}
          </span>
        }
      />
      <div className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2">
          <Trophy aria-hidden="true" className="size-4 text-hazard" strokeWidth={1.5} />
          <h2 className="display text-2xl text-bone">{t('economy.rank_current', { count: rank.current })}</h2>
        </div>
        <Bar fraction={rank.per_rank > 0 ? rank.into / rank.per_rank : 0} />
        <p className="font-mono text-[0.6875rem] text-dust">
          {t('economy.rank_xp_progress', {
            into: rank.into,
            need: rank.per_rank,
            next: rank.current + 1,
          })}
        </p>
      </div>
    </Panel>
  )
}

function TodayBoard({
  tasks,
  pending,
  busy,
  onClaim,
}: {
  tasks: RewardTask[]
  pending: boolean
  busy: boolean
  onClaim: (key: string) => void
}) {
  const { t } = useTranslation()

  return (
    <Panel bracketed className="flex min-h-0 flex-col">
      <PanelHeader label={t('economy.tasks')} />
      {pending ? (
        <Skeleton className="m-5 h-32" />
      ) : (
        <ul className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-2">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} busy={busy} onClaim={onClaim} />
          ))}
        </ul>
      )}
    </Panel>
  )
}

function ObjectiveBoard({
  items,
  current,
  pending,
  busy,
  onSelect,
  onClaim,
}: {
  items: ObjectiveProgress[]
  current: ObjectiveProgress | null
  pending: boolean
  busy: boolean
  onSelect: (id: string) => void
  onClaim: (id: string) => void
}) {
  const { t } = useTranslation()

  if (pending) {
    return <Skeleton className="min-h-48" />
  }

  if (items.length === 0) {
    return (
      <Panel bracketed className="p-10 text-center">
        <Trophy aria-hidden="true" className="mx-auto size-8 text-dust" strokeWidth={1.25} />
        <p className="mt-4 text-sm text-dust">{t('economy.objectives_none')}</p>
      </Panel>
    )
  }

  return (
    <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(16rem,26rem)_minmax(0,1fr)]">
      <Panel bracketed className="flex min-h-0 flex-col">
        <PanelHeader
          label={t('economy.objectives_title')}
          action={
            <span className="font-mono text-[0.6875rem] text-dust">
              {t('admin.backups_showing', { count: items.length })}
            </span>
          }
        />
        <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                className={cn(
                  'flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition-colors',
                  item.id === current?.id ? 'bg-hazard-soft' : 'hover:bg-ash-raised',
                )}
              >
                <span className="flex w-full items-baseline justify-between gap-2">
                  <span className="truncate text-sm text-bone">{item.title}</span>
                  <span
                    className={cn(
                      'shrink-0 font-mono text-[0.625rem] uppercase',
                      item.claimed ? 'text-moss' : item.complete ? 'text-hazard' : 'text-dust',
                    )}
                  >
                    {item.claimed
                      ? t('economy.claimed_today')
                      : t('economy.xp', { count: item.xp })}
                  </span>
                </span>
                <span className="flex w-full items-center gap-2">
                  <Bar className="w-24" fraction={item.goal > 0 ? item.progress / item.goal : 0} />
                  <span className="font-mono text-[0.6875rem] text-dust">
                    {t('economy.task_progress', { progress: item.progress, goal: item.goal })}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel bracketed className="overflow-y-auto">
        {current ? (
          <ObjectiveDetail item={current} busy={busy} onClaim={() => onClaim(current.id)} />
        ) : (
          <>
            <PanelHeader label={t('economy.objectives_title')} />
            <p className="p-5 text-sm text-dust">{t('economy.objectives_pick')}</p>
          </>
        )}
      </Panel>
    </div>
  )
}

function ObjectiveDetail({
  item,
  busy,
  onClaim,
}: {
  item: ObjectiveProgress
  busy: boolean
  onClaim: () => void
}) {
  const { t } = useTranslation()
  const href = item.kind === 'spend' ? '/shop' : item.kind === 'trade' ? '/auctions' : null
  const manual = item.kind === 'manual'
  const kind = KIND_LABELS[item.kind]

  return (
    <>
      <PanelHeader
        label={
          item.cadence === 'daily' ? t('economy.objective_daily') : t('economy.objective_once')
        }
        action={
          kind ? (
            <span className="font-mono text-[0.6875rem] text-dust">{t(kind)}</span>
          ) : null
        }
      />
      <div className="flex flex-col gap-5 p-5">
        <div>
          <h2 className="display text-2xl text-bone">{item.title}</h2>
          {item.description ? (
            <p className="mt-2 text-sm leading-relaxed text-smoke">{item.description}</p>
          ) : null}
        </div>
        <Bar fraction={item.goal > 0 ? item.progress / item.goal : 0} />
        <dl className="grid gap-3 sm:grid-cols-3">
          <Meta
            label={t('economy.objective_goal')}
            value={t('economy.task_progress', { progress: item.progress, goal: item.goal })}
          />
          <Meta label={t('economy.xp_label')} value={t('economy.xp', { count: item.xp })} />
          {item.coins > 0 ? (
            <Meta label={t('economy.price')} value={t('economy.coins', { count: item.coins })} />
          ) : null}
        </dl>
        {href && !item.complete && !item.claimed ? (
          <Link
            to={href}
            className="self-start font-mono text-[0.6875rem] tracking-widest text-dust uppercase hover:text-hazard"
          >
            {href === '/shop' ? t('nav.store') : t('nav.auctions')}
          </Link>
        ) : null}
        {manual && !item.claimed ? (
          <p className="text-xs text-dust">{t('economy.objective_staff')}</p>
        ) : null}
        {item.claimed ? (
          <p className="font-mono text-xs text-moss">{t('economy.claimed_today')}</p>
        ) : (
          <Button
            size="sm"
            className="self-start"
            disabled={!item.complete || busy || manual}
            onClick={onClaim}
          >
            {t('economy.claim')}
            {item.xp > 0 ? ` · ${t('economy.xp', { count: item.xp })}` : ''}
          </Button>
        )}
      </div>
    </>
  )
}

function LedgerBoard({
  rows,
  total,
  current,
  pending,
  filter,
  search,
  onFilter,
  onSearch,
  onSelect,
}: {
  rows: WalletTransaction[]
  total: number
  current: WalletTransaction | null
  pending: boolean
  filter: string
  search: string
  onFilter: (id: string) => void
  onSearch: (value: string) => void
  onSelect: (id: string) => void
}) {
  const { t, intlLocale } = useTranslation()

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <label className="relative block shrink-0">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-dust"
          strokeWidth={1.5}
        />
        <input
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder={t('common.search')}
          aria-label={t('common.search')}
          className="h-11 w-full border border-fence-bright bg-void pr-3 pl-9 font-mono text-sm text-bone transition-colors placeholder:text-dust focus:border-hazard"
        />
      </label>

      <div className="flex shrink-0 flex-wrap gap-1.5">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onFilter(item.id)}
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

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(16rem,26rem)_minmax(0,1fr)]">
        <Panel bracketed className="flex min-h-0 flex-col">
          <PanelHeader
            label={t('economy.ledger')}
            action={
              <span className="font-mono text-[0.6875rem] text-dust">
                {t('economy.ledger_count', { count: rows.length })}
              </span>
            }
          />
          {pending ? (
            <Skeleton className="m-5 h-24" />
          ) : rows.length === 0 ? (
            <p className="p-5 text-sm text-dust">
              {total === 0 ? t('economy.ledger_empty') : t('common.none_found')}
            </p>
          ) : (
            <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
              {rows.map((row) => {
                const label = sourceKey(row.source)
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(row.id)}
                      className={cn(
                        'flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors',
                        row.id === current?.id ? 'bg-hazard-soft' : 'hover:bg-ash-raised',
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-bone">
                          {row.description ?? (label ? t(label) : row.source)}
                        </span>
                        <span className="font-mono text-[0.6875rem] text-dust">
                          {formatDateTime(row.created_at, intlLocale)}
                          {' · '}
                          {label ? t(label) : row.source}
                        </span>
                      </span>
                      <span
                        className={cn(
                          'shrink-0 font-mono text-sm',
                          row.kind === 'credit' ? 'text-moss' : 'text-blood',
                        )}
                      >
                        {row.kind === 'credit' ? '+' : '−'}
                        {formatCoins(row.amount, intlLocale)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>

        <Panel bracketed className="overflow-y-auto">
          {current ? (
            <Movement row={current} />
          ) : (
            <>
              <PanelHeader label={t('economy.tx_detail')} />
              <p className="p-5 text-sm text-dust">{t('economy.pick_movement')}</p>
            </>
          )}
        </Panel>
      </div>
    </div>
  )
}

function Movement({ row }: { row: WalletTransaction }) {
  const { t, intlLocale } = useTranslation()
  const label = sourceKey(row.source)

  return (
    <>
      <PanelHeader label={t('economy.tx_detail')} />
      <div className="flex flex-col gap-5 p-5">
        <div>
          <h2 className="display text-2xl text-bone">
            {row.description ?? (label ? t(label) : row.source)}
          </h2>
          <p className="mt-1 font-mono text-[0.6875rem] text-dust">
            {formatDateTime(row.created_at, intlLocale)}
          </p>
        </div>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Meta
            label={t('economy.coins', { count: row.amount })}
            value={`${row.kind === 'credit' ? '+' : '−'}${formatCoins(row.amount, intlLocale)}`}
          />
          <Meta label={t('economy.balance_after')} value={formatCoins(row.balance_after, intlLocale)} />
          <Meta label={t('economy.source')} value={label ? t(label) : row.source} />
        </dl>
      </div>
    </>
  )
}

function FlowBoard({
  items,
  offers,
  pending,
  busy,
  onClaim,
  onPickup,
}: {
  items: QuestProgress[]
  offers: import('@/lib/quest-graph').QuestOffer[]
  pending: boolean
  busy: boolean
  onClaim: (questId: string, nodeId: string) => void
  onPickup: (questId: string) => void
}) {
  const { t } = useTranslation()

  if (pending) {
    return <Skeleton className="min-h-48" />
  }

  if (items.length === 0 && offers.length === 0) {
    return (
      <Panel bracketed className="p-10 text-center">
        <p className="text-sm text-dust">{t('economy.flows_none')}</p>
      </Panel>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      {offers.length > 0 ? (
        <Panel bracketed>
          <PanelHeader label={t('economy.flow_pickup_title')} />
          <ul className="divide-y divide-fence">
            {offers.map((offer) => (
              <li key={offer.id} className="flex items-start justify-between gap-3 px-5 py-3">
                <span className="min-w-0">
                  <span className="block text-sm text-bone">{offer.title}</span>
                  {offer.description ? (
                    <span className="mt-1 block text-xs text-dust">{offer.description}</span>
                  ) : null}
                </span>
                <Button size="sm" disabled={busy} onClick={() => onPickup(offer.id)}>
                  {t('economy.flow_pickup')}
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      {items.map((quest) => (
        <Panel key={quest.id} bracketed>
          <PanelHeader
            label={quest.title}
            action={
              quest.stage ? (
                <span className="font-mono text-[0.6875rem] text-hazard">
                  {t('economy.flow_stage_label', { name: quest.stage })}
                </span>
              ) : null
            }
          />
          {quest.description ? (
            <p className="border-b border-fence px-5 py-3 text-sm text-smoke">{quest.description}</p>
          ) : null}
          <ul className="divide-y divide-fence">
            {quest.nodes
              .filter((node) =>
                ['task', 'objective', 'reward', 'area', 'find', 'collect', 'kills'].includes(node.kind),
              )
              .map((node) => (
                <FlowNodeRow
                  key={node.id}
                  node={node}
                  busy={busy}
                  onClaim={() => onClaim(quest.id, node.id)}
                />
              ))}
          </ul>
        </Panel>
      ))}
    </div>
  )
}

function FlowNodeRow({
  node,
  busy,
  onClaim,
}: {
  node: QuestNodeView
  busy: boolean
  onClaim: () => void
}) {
  const { t } = useTranslation()
  const collectible = ['task', 'objective', 'area', 'find', 'collect', 'kills'].includes(node.kind)

  return (
    <li className={cn('flex items-start justify-between gap-3 px-5 py-3', !node.unlocked && 'opacity-50')}>
      <span className="min-w-0">
        <span className="block text-sm text-bone">{node.title}</span>
        {node.kind === 'area' && node.area_x != null && node.area_y != null ? (
          <span className="mt-0.5 block font-mono text-[0.6875rem] text-dust">
            {t('economy.flow_area_hint', {
              x: Math.round(node.area_x),
              y: Math.round(node.area_y),
              r: Math.round(node.area_radius ?? 0),
            })}
          </span>
        ) : null}
        {node.item_type ? (
          <span className="mt-0.5 block font-mono text-[0.6875rem] text-dust">{node.item_type}</span>
        ) : null}
        <span className="mt-1 flex items-center gap-2">
          <Bar className="w-24" fraction={node.goal > 0 ? node.progress / node.goal : 0} />
          <span className="font-mono text-[0.6875rem] text-dust">
            {!node.unlocked
              ? t('economy.flow_locked')
              : t('economy.task_progress', { progress: node.progress, goal: node.goal })}
            {node.xp > 0 ? ` · ${t('economy.xp', { count: node.xp })}` : ''}
            {node.coins > 0 ? ` · ${t('economy.coins', { count: node.coins })}` : ''}
          </span>
        </span>
      </span>
      {node.claimed ? (
        <span className="shrink-0 font-mono text-[0.625rem] tracking-widest text-moss uppercase">
          {t('economy.claimed_today')}
        </span>
      ) : collectible ? (
        <Button size="sm" variant="outline" disabled={!node.unlocked || !node.complete || busy} onClick={onClaim}>
          {t('economy.claim')}
        </Button>
      ) : null}
    </li>
  )
}

function TaskRow({
  task,
  busy,
  onClaim,
}: {
  task: RewardTask
  busy: boolean
  onClaim: (key: string) => void
}) {
  const { t } = useTranslation()
  const label = TASK_LABELS[task.id]
  const href = task.id === 'spend' ? '/shop' : task.id === 'trade' ? '/auctions' : null

  return (
    <li className="flex items-start justify-between gap-3 border-b border-fence px-5 py-4 md:odd:border-r">
      <span className="min-w-0">
        <span className="block text-sm text-bone">{label ? t(label) : task.id}</span>
        <span className="mt-2 flex items-center gap-2">
          <Bar className="w-28" fraction={task.goal > 0 ? task.progress / task.goal : 0} />
          <span className="font-mono text-[0.6875rem] text-dust">
            {t('economy.task_progress', { progress: task.progress, goal: task.goal })}
            {' · '}
            {t('economy.coins', { count: task.coins })}
          </span>
        </span>
        {href && !task.complete && !task.claimed ? (
          <Link
            to={href}
            className="mt-2 inline-block font-mono text-[0.625rem] tracking-widest text-dust uppercase hover:text-hazard"
          >
            {href === '/shop' ? t('nav.store') : t('nav.auctions')}
          </Link>
        ) : null}
      </span>
      {task.claimed ? (
        <span className="shrink-0 font-mono text-[0.625rem] tracking-widest text-moss uppercase">
          {t('economy.claimed_today')}
        </span>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={!task.complete || busy}
          onClick={() => onClaim(task.id)}
        >
          {t('economy.claim')}
        </Button>
      )}
    </li>
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
