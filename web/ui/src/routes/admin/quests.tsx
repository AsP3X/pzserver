import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Copy, Plus, Search, Target, TriangleAlert, Trash2, Users } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatRelativeTime } from '@/lib/format'
import { checkGraph, kindOf, totalPayout, type Quest } from '@/lib/quest-graph'
import { adminGroupsQuery, adminQuestsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

const AUDIENCE: Record<string, TranslationKey> = {
  all: 'economy.flow_audience_all',
  players: 'economy.flow_audience_players',
  group: 'economy.flow_audience_group',
  claimable: 'economy.flow_audience_claimable',
}

type Filter = 'all' | 'live' | 'draft'

const FILTERS: { id: Filter; label: TranslationKey }[] = [
  { id: 'all', label: 'economy.flows_filter_all' },
  { id: 'live', label: 'economy.flows_filter_live' },
  { id: 'draft', label: 'economy.flows_filter_draft' },
]

/**
 * Staff flows. Each row carries what a campaign is worth and whether it holds
 * together, so a broken draft is visible without opening the board.
 */
export function AdminQuestsPage() {
  const { t, intlLocale } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const list = useQuery(adminQuestsQuery)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [groupsOpen, setGroupsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [remove, setRemove] = useState<Quest | null>(null)

  const items = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return (list.data ?? []).filter((item) => {
      if (filter === 'live' && !item.active) {
        return false
      }
      if (filter === 'draft' && item.active) {
        return false
      }
      return needle.length === 0 || item.title.toLocaleLowerCase().includes(needle)
    })
  }, [filter, list.data, search])

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'quests'] })
  }

  function fail(cause: unknown) {
    setNotice(null)
    setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
  }

  const created = useMutation({
    mutationFn: () => api.adminCreateQuest({ title: t('economy.new_flow'), audience: 'all', active: false }),
    onSuccess: async (quest) => {
      await refresh()
      await navigate({ to: '/admin/quests/$questId', params: { questId: quest.id } })
    },
    onError: fail,
  })

  /**
   * The one-step flow that objectives used to be.
   *
   * Most staff work is "kill 50 zombies, daily, 100 XP" — one condition and no
   * staging. Making that go through the graph editor would have been the whole
   * cost of folding objectives into flows, so it gets its own button and lands
   * ready to fill in.
   */
  const createdSimple = useMutation({
    mutationFn: () =>
      api.adminCreateQuest({
        title: t('economy.new_objective'),
        audience: 'all',
        active: false,
        graph: {
          nodes: [
            { id: 'start', type: 'start', x: 64, y: 160, title: 'Start', data: {} },
            {
              id: 'objective-1',
              type: 'objective',
              x: 360,
              y: 160,
              title: t('economy.new_objective'),
              data: { measure: 'kills', goal: 10, cadence: 'daily', xp: 50, coins: 0 },
            },
          ],
          edges: [{ id: 'e1', from: 'start', to: 'objective-1' }],
        },
      }),
    onSuccess: async (quest) => {
      await refresh()
      await navigate({ to: '/admin/quests/$questId', params: { questId: quest.id } })
    },
    onError: fail,
  })

  const copied = useMutation({
    mutationFn: (quest: Quest) =>
      api.adminCreateQuest({
        title: t('economy.flow_copy_of', { name: quest.title }).slice(0, 80),
        description: quest.description,
        audience: quest.audience,
        audience_usernames: quest.audience_usernames,
        audience_group_id: quest.audience_group_id,
        // A copy always lands as a draft: two live flows paying the same
        // rewards is never what "duplicate" meant.
        active: false,
        graph: quest.graph,
      }),
    onSuccess: async (quest) => {
      await refresh()
      await navigate({ to: '/admin/quests/$questId', params: { questId: quest.id } })
    },
    onError: fail,
  })

  const toggled = useMutation({
    mutationFn: (quest: Quest) => api.adminUpdateQuest(quest.id, { active: !quest.active }),
    onSuccess: async () => {
      setError(null)
      setNotice(t('economy.saved'))
      await refresh()
    },
    onError: fail,
  })

  const destroyed = useMutation({
    mutationFn: (id: string) => api.adminDeleteQuest(id),
    onSuccess: async () => {
      setRemove(null)
      setNotice(t('economy.saved'))
      await refresh()
    },
    onError: fail,
  })

  const busy = toggled.isPending || copied.isPending

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.shop')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('economy.flows_title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('economy.flows_description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setGroupsOpen(true)}>
            <Users aria-hidden="true" className="size-3.5" />
            {t('economy.flow_groups')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={createdSimple.isPending}
            onClick={() => createdSimple.mutate()}
          >
            <Target aria-hidden="true" className="size-3.5" />
            {t('economy.new_objective')}
          </Button>
          <Button size="sm" disabled={created.isPending} onClick={() => created.mutate()}>
            <Plus aria-hidden="true" className="size-3.5" />
            {t('economy.new_flow')}
          </Button>
        </div>
      </header>

      {notice ? (
        <p role="status" className="border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}

      <Panel bracketed className="flex min-h-0 flex-1 flex-col">
        <PanelHeader
          label={t('economy.flows_title')}
          action={
            <span className="font-mono text-[0.6875rem] text-dust">
              {t('admin.backups_showing', { count: items.length })}
            </span>
          }
        />

        <div className="flex flex-wrap items-center gap-3 border-b border-fence px-4 py-3">
          <label className="flex min-w-52 flex-1 items-center gap-2 border border-fence-bright bg-void px-3">
            <Search aria-hidden="true" className="size-3.5 shrink-0 text-dust" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('economy.flows_search')}
              aria-label={t('economy.flows_search')}
              className="h-10 min-w-0 flex-1 bg-transparent font-mono text-sm text-bone placeholder:text-dust"
            />
          </label>
          <div className="flex gap-1">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={cn(
                  'border px-3 py-2 font-mono text-[0.625rem] tracking-widest uppercase',
                  filter === item.id
                    ? 'border-hazard bg-hazard-soft text-hazard'
                    : 'border-fence text-dust hover:text-bone',
                )}
              >
                {t(item.label)}
              </button>
            ))}
          </div>
        </div>

        {list.isPending ? (
          <Skeleton className="m-5 h-32" />
        ) : items.length === 0 ? (
          <p className="p-5 text-sm text-dust">
            {(list.data ?? []).length === 0 ? t('economy.flows_empty') : t('economy.flows_none_match')}
          </p>
        ) : (
          <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
            {items.map((item) => (
              <QuestRow
                key={item.id}
                quest={item}
                locale={intlLocale}
                busy={busy}
                onToggle={() => toggled.mutate(item)}
                onCopy={() => copied.mutate(item)}
                onDelete={() => setRemove(item)}
              />
            ))}
          </ul>
        )}
      </Panel>

      <GroupsDialog open={groupsOpen} onClose={() => setGroupsOpen(false)} onFail={fail} />

      <ConfirmDialog
        open={remove !== null}
        title={t('economy.flow_delete_title')}
        description={t('economy.flow_delete_body', { name: remove?.title ?? '' })}
        confirmLabel={t('common.delete')}
        tone="danger"
        busy={destroyed.isPending}
        onConfirm={() => remove && destroyed.mutate(remove.id)}
        onClose={() => setRemove(null)}
      />
    </section>
  )
}

function QuestRow({
  quest,
  locale,
  busy,
  onToggle,
  onCopy,
  onDelete,
}: {
  quest: Quest
  locale: string
  busy: boolean
  onToggle: () => void
  onCopy: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const problems = checkGraph(quest.graph)
  const errors = problems.filter((problem) => problem.level === 'error').length
  const gates = quest.graph.nodes.filter((node) => kindOf(node.type)?.category === 'gate').length
  const payout = totalPayout(quest.graph)

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <Link to="/admin/quests/$questId" params={{ questId: quest.id }} className="min-w-52 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm text-bone">{quest.title}</span>
          {errors > 0 ? (
            <span className="flex shrink-0 items-center gap-1 font-mono text-[0.625rem] text-blood uppercase">
              <TriangleAlert aria-hidden="true" className="size-3" />
              {t('economy.flow_problem_errors', { count: errors })}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block font-mono text-[0.6875rem] text-dust">
          {AUDIENCE[quest.audience] ? t(AUDIENCE[quest.audience]) : quest.audience}
          {' · '}
          {t('economy.flow_node_count', { count: quest.graph.nodes.length })}
          {' · '}
          {t('economy.flow_gate_count', { count: gates })}
          {payout.xp > 0 || payout.coins > 0
            ? ` · ${t('economy.flow_payout', { xp: payout.xp, coins: payout.coins })}`
            : ''}
          {' · '}
          {formatRelativeTime(quest.updated_at, locale)}
        </span>
      </Link>

      <button
        type="button"
        role="switch"
        aria-checked={quest.active}
        disabled={busy}
        onClick={onToggle}
        className={cn(
          'flex shrink-0 items-center gap-2 border px-2.5 py-1.5 font-mono text-[0.625rem] tracking-widest uppercase disabled:opacity-40',
          quest.active ? 'border-moss bg-moss-soft text-moss' : 'border-fence text-dust hover:text-bone',
        )}
      >
        <span aria-hidden="true" className={cn('size-1.5 rounded-full', quest.active ? 'bg-moss' : 'bg-dust')} />
        {quest.active ? t('economy.flow_live') : t('economy.flow_draft')}
      </button>

      <div className="flex shrink-0 gap-1">
        <button
          type="button"
          disabled={busy}
          title={t('economy.flow_duplicate')}
          aria-label={t('economy.flow_duplicate')}
          onClick={onCopy}
          className="flex size-8 items-center justify-center text-dust hover:text-hazard disabled:opacity-40"
        >
          <Copy aria-hidden="true" className="size-4" />
        </button>
        <button
          type="button"
          title={t('common.delete')}
          aria-label={t('common.delete')}
          onClick={onDelete}
          className="flex size-8 items-center justify-center text-dust hover:text-blood"
        >
          <Trash2 aria-hidden="true" className="size-4" />
        </button>
      </div>
    </li>
  )
}

/**
 * Groups only exist to answer "who is this flow for", so they live behind the
 * flows list rather than taking a permanent column beside it.
 */
function GroupsDialog({
  open,
  onClose,
  onFail,
}: {
  open: boolean
  onClose: () => void
  onFail: (cause: unknown) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const groups = useQuery({ ...adminGroupsQuery, enabled: open })
  const [name, setName] = useState('')
  const [member, setMember] = useState('')
  const [groupId, setGroupId] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const element = dialog.current
    if (!element) {
      return
    }
    if (open && !element.open) {
      element.showModal()
    } else if (!open && element.open) {
      element.close()
    }
  }, [open])

  const members = useQuery({
    queryKey: ['admin', 'groups', groupId, 'members'],
    queryFn: () => api.adminGroupMembers(groupId ?? ''),
    enabled: open && groupId !== null,
  })

  const current = (groups.data ?? []).find((item) => item.id === groupId) ?? null

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] })
  }

  const made = useMutation({
    mutationFn: () => api.adminCreateGroup(name.trim()),
    onSuccess: async (group) => {
      setName('')
      setGroupId(group.id)
      await refresh()
    },
    onError: onFail,
  })

  const dropped = useMutation({
    mutationFn: (id: string) => api.adminDeleteGroup(id),
    onSuccess: async () => {
      setGroupId(null)
      await refresh()
    },
    onError: onFail,
  })

  const added = useMutation({
    mutationFn: () => api.adminAddGroupMember(groupId ?? '', member.trim()),
    onSuccess: async () => {
      setMember('')
      await refresh()
    },
    onError: onFail,
  })

  const removed = useMutation({
    mutationFn: (username: string) => api.adminRemoveGroupMember(groupId ?? '', username),
    onSuccess: refresh,
    onError: onFail,
  })

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className="m-auto w-[min(44rem,calc(100vw-2rem))] border border-fence-bright bg-ash p-0 text-bone backdrop:bg-void/80"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={() => {
        if (open) {
          onClose()
        }
      }}
    >
      <header className="border-b border-fence px-5 py-4">
        <h2 id={titleId} className="display text-xl text-bone">
          {t('economy.flow_groups')}
        </h2>
      </header>

      <div className="p-5">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-smoke">{t('economy.flow_groups_hint')}</p>

          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field
                label={t('economy.flow_group')}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <Button size="sm" disabled={made.isPending || name.trim().length < 1} onClick={() => made.mutate()}>
              {t('economy.flow_new_group')}
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <ul className="max-h-56 divide-y divide-fence overflow-y-auto border border-fence">
              {(groups.data ?? []).length === 0 ? (
                <li className="px-3 py-2 text-sm text-dust">{t('economy.flow_groups_empty')}</li>
              ) : (
                (groups.data ?? []).map((group) => (
                  <li key={group.id} className="flex items-center">
                    <button
                      type="button"
                      onClick={() => setGroupId(group.id)}
                      className={cn(
                        'flex flex-1 justify-between gap-2 px-3 py-2 text-left text-sm',
                        group.id === groupId ? 'bg-hazard-soft text-bone' : 'text-smoke hover:bg-ash-raised',
                      )}
                    >
                      <span className="truncate">{group.name}</span>
                      <span className="font-mono text-[0.6875rem] text-dust">{group.members}</span>
                    </button>
                    <button
                      type="button"
                      disabled={dropped.isPending}
                      aria-label={t('common.delete')}
                      title={t('common.delete')}
                      onClick={() => dropped.mutate(group.id)}
                      className="flex size-8 items-center justify-center text-dust hover:text-blood"
                    >
                      <Trash2 aria-hidden="true" className="size-3.5" />
                    </button>
                  </li>
                ))
              )}
            </ul>

            <div className="flex flex-col gap-2">
              {current ? (
                <>
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Field
                        label={t('economy.objective_player')}
                        value={member}
                        onChange={(event) => setMember(event.target.value)}
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={added.isPending || !member.trim()}
                      onClick={() => added.mutate()}
                    >
                      {t('economy.flow_add_member')}
                    </Button>
                  </div>
                  <ul className="max-h-40 overflow-y-auto text-sm text-smoke">
                    {(members.data ?? []).length === 0 ? (
                      <li className="py-1 text-dust">{t('economy.flow_no_members')}</li>
                    ) : (
                      (members.data ?? []).map((username) => (
                        <li key={username} className="flex items-center justify-between py-1">
                          <span className="truncate">{username}</span>
                          <button
                            type="button"
                            disabled={removed.isPending}
                            className="font-mono text-[0.625rem] text-dust uppercase hover:text-blood"
                            onClick={() => removed.mutate(username)}
                          >
                            {t('common.delete')}
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                </>
              ) : (
                <p className="text-sm text-dust">{t('economy.flow_group_pick')}</p>
              )}
            </div>
          </div>
        </div>
      </div>

      <footer className="flex justify-end border-t border-fence px-5 py-3">
        <Button size="sm" onClick={onClose}>
          {t('common.close')}
        </Button>
      </footer>
    </dialog>
  )
}
