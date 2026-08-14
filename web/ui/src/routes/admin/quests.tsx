import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { adminGroupsQuery, adminQuestsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

const AUDIENCE: Record<string, TranslationKey> = {
  all: 'economy.flow_audience_all',
  players: 'economy.flow_audience_players',
  group: 'economy.flow_audience_group',
  claimable: 'economy.flow_audience_claimable',
}

/**
 * Staff flows. A graph is a campaign: stages, tasks, objectives, who sees it.
 */
export function AdminQuestsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const list = useQuery(adminQuestsQuery)
  const groups = useQuery(adminGroupsQuery)
  const [groupName, setGroupName] = useState('')
  const [member, setMember] = useState('')
  const [groupId, setGroupId] = useState<string | null>(null)
  const [members, setMembers] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [remove, setRemove] = useState<string | null>(null)

  const items = list.data ?? []
  const currentGroup = (groups.data ?? []).find((item) => item.id === groupId) ?? null

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'quests'] })
    await queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] })
  }

  function fail(cause: unknown) {
    setNotice(null)
    setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
  }

  const created = useMutation({
    mutationFn: () => api.adminCreateQuest({ title: t('economy.new_flow'), audience: 'all', active: false }),
    onSuccess: async (quest) => {
      await refresh()
      window.location.assign(`/admin/quests/${quest.id}`)
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

  const madeGroup = useMutation({
    mutationFn: () => api.adminCreateGroup(groupName),
    onSuccess: async (group) => {
      setGroupName('')
      setGroupId(group.id)
      setMembers([])
      await refresh()
    },
    onError: fail,
  })

  const added = useMutation({
    mutationFn: () => {
      if (!groupId) throw new Error('missing group')
      return api.adminAddGroupMember(groupId, member)
    },
    onSuccess: async () => {
      setMember('')
      if (groupId) {
        setMembers(await api.adminGroupMembers(groupId))
      }
      await refresh()
    },
    onError: fail,
  })

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
        <Button size="sm" disabled={created.isPending} onClick={() => created.mutate()}>
          <Plus aria-hidden="true" className="size-3.5" />
          {t('economy.new_flow')}
        </Button>
      </header>

      {notice ? (
        <p role="status" className="border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Panel bracketed className="flex min-h-0 flex-col">
          <PanelHeader label={t('economy.flows_title')} />
          {list.isPending ? (
            <Skeleton className="m-5 h-32" />
          ) : items.length === 0 ? (
            <p className="p-5 text-sm text-dust">{t('economy.flows_empty')}</p>
          ) : (
            <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
              {items.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <Link to="/admin/quests/$questId" params={{ questId: item.id }} className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-bone">{item.title}</span>
                    <span className="font-mono text-[0.6875rem] text-dust">
                      {AUDIENCE[item.audience] ? t(AUDIENCE[item.audience]) : item.audience}
                      {' · '}
                      {item.graph.nodes.length} {t('economy.flow_nodes')}
                      {' · '}
                      <span className={item.active ? 'text-moss' : 'text-dust'}>
                        {item.active ? t('economy.active') : t('admin.automations_disabled')}
                      </span>
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => setRemove(item.id)}
                    className="text-dust hover:text-blood"
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel bracketed className="flex min-h-0 flex-col overflow-y-auto">
          <PanelHeader label={t('economy.flow_groups')} />
          <div className="flex flex-col gap-3 p-4">
            <div className="flex gap-2">
              <Field
                label={t('economy.flow_group')}
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
              />
            </div>
            <Button
              size="sm"
              disabled={madeGroup.isPending || groupName.trim().length < 1}
              onClick={() => madeGroup.mutate()}
            >
              {t('economy.flow_new_group')}
            </Button>
            <ul className="divide-y divide-fence border border-fence">
              {(groups.data ?? []).map((group) => (
                <li key={group.id}>
                  <button
                    type="button"
                    onClick={async () => {
                      setGroupId(group.id)
                      setMembers(await api.adminGroupMembers(group.id))
                    }}
                    className={cn(
                      'flex w-full justify-between px-3 py-2 text-left text-sm',
                      group.id === groupId ? 'bg-hazard-soft text-bone' : 'text-smoke hover:bg-ash-raised',
                    )}
                  >
                    <span>{group.name}</span>
                    <span className="font-mono text-[0.6875rem] text-dust">{group.members}</span>
                  </button>
                </li>
              ))}
            </ul>
            {currentGroup ? (
              <>
                <div className="flex items-end gap-2">
                  <Field
                    label={t('economy.objective_player')}
                    value={member}
                    onChange={(event) => setMember(event.target.value)}
                  />
                  <Button size="sm" disabled={added.isPending || !member.trim()} onClick={() => added.mutate()}>
                    {t('common.save')}
                  </Button>
                </div>
                <ul className="text-sm text-smoke">
                  {members.map((name) => (
                    <li key={name} className="flex items-center justify-between py-1">
                      <span>{name}</span>
                      <button
                        type="button"
                        className="font-mono text-[0.625rem] text-dust uppercase hover:text-blood"
                        onClick={async () => {
                          await api.adminRemoveGroupMember(currentGroup.id, name)
                          setMembers(await api.adminGroupMembers(currentGroup.id))
                          await refresh()
                        }}
                      >
                        {t('common.delete')}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        </Panel>
      </div>

      <ConfirmDialog
        open={remove !== null}
        title={t('common.delete')}
        description={t('economy.flows_title')}
        confirmLabel={t('common.delete')}
        tone="danger"
        busy={destroyed.isPending}
        onConfirm={() => remove && destroyed.mutate(remove)}
        onClose={() => setRemove(null)}
      />
    </section>
  )
}
