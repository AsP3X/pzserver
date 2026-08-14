import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError, TextAreaField } from '@/components/ui/field'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, type Objective, type ObjectiveInput } from '@/lib/api'
import { cn } from '@/lib/cn'
import { adminObjectivesQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

const KINDS: { id: string; label: TranslationKey }[] = [
  { id: 'play', label: 'economy.objective_kind_play' },
  { id: 'kills', label: 'economy.objective_kind_kills' },
  { id: 'hours', label: 'economy.objective_kind_hours' },
  { id: 'spend', label: 'economy.objective_kind_spend' },
  { id: 'trade', label: 'economy.objective_kind_trade' },
  { id: 'manual', label: 'economy.objective_kind_manual' },
]

const CADENCES: { id: string; label: TranslationKey }[] = [
  { id: 'daily', label: 'economy.objective_daily' },
  { id: 'once', label: 'economy.objective_once' },
]

function kindLabel(kind: string): TranslationKey {
  return KINDS.find((item) => item.id === kind)?.label ?? 'economy.objective_kind_manual'
}

/**
 * Staff-authored objectives. Completing one pays XP toward rank.
 */
export function AdminObjectivesPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const list = useQuery(adminObjectivesQuery)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [remove, setRemove] = useState<Objective | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const items = list.data ?? []
  const current = items.find((item) => item.id === selected) ?? null

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'objectives'] })
  }

  function fail(cause: unknown) {
    setNotice(null)
    setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
  }

  const created = useMutation({
    mutationFn: (input: ObjectiveInput) => api.adminCreateObjective(input),
    onSuccess: async (item) => {
      setCreating(false)
      setSelected(item.id)
      setNotice(t('economy.saved'))
      await refresh()
    },
    onError: fail,
  })

  const saved = useMutation({
    mutationFn: (input: ObjectiveInput) => {
      if (!current) throw new Error('missing objective')
      return api.adminUpdateObjective(current.id, input)
    },
    onSuccess: async () => {
      setNotice(t('economy.saved'))
      await refresh()
    },
    onError: fail,
  })

  const destroyed = useMutation({
    mutationFn: (id: string) => api.adminDeleteObjective(id),
    onSuccess: async () => {
      setRemove(null)
      setSelected(null)
      setNotice(t('economy.saved'))
      await refresh()
    },
    onError: fail,
  })

  const granted = useMutation({
    mutationFn: (username: string) => {
      if (!current) throw new Error('missing objective')
      return api.adminGrantObjective(current.id, username)
    },
    onSuccess: async () => {
      setNotice(t('economy.objective_granted'))
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
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('economy.objectives_title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('economy.objectives_description')}</p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" className="size-3.5" />
          {t('economy.new_objective')}
        </Button>
      </header>

      {notice ? (
        <p role="status" className="border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}

      {list.isPending ? (
        <Skeleton className="min-h-0 flex-1" />
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
          <Panel bracketed className="flex min-h-0 flex-col">
            <PanelHeader
              label={t('economy.objectives_title')}
              action={
                <span className="font-mono text-[0.6875rem] text-dust">
                  {t('admin.backups_showing', { count: items.length })}
                </span>
              }
            />
            {items.length === 0 ? (
              <p className="p-5 text-sm text-dust">{t('economy.objectives_empty')}</p>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-fence overflow-y-auto">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(item.id)}
                      className={cn(
                        'flex w-full flex-col items-start gap-1 px-4 py-3 text-left',
                        item.id === current?.id ? 'bg-hazard-soft' : 'hover:bg-ash-raised',
                      )}
                    >
                      <span className="flex w-full justify-between gap-2">
                        <span className="truncate text-sm text-bone">{item.title}</span>
                        <span
                          className={cn(
                            'font-mono text-[0.625rem] uppercase',
                            item.active ? 'text-moss' : 'text-dust',
                          )}
                        >
                          {item.active ? t('economy.active') : t('admin.automations_disabled')}
                        </span>
                      </span>
                      <span className="font-mono text-[0.6875rem] text-dust">
                        {t(kindLabel(item.kind))}
                        {' · '}
                        {t('economy.xp', { count: item.xp })}
                        {' · '}
                        {t('economy.objective_completions', { count: item.completions })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel bracketed className="overflow-y-auto">
            {current ? (
              <Editor
                key={current.id}
                item={current}
                busy={saved.isPending}
                granting={granted.isPending}
                onSave={(input) => saved.mutate(input)}
                onDelete={() => setRemove(current)}
                onGrant={(username) => granted.mutate(username)}
              />
            ) : (
              <>
                <PanelHeader label={t('economy.objectives_title')} />
                <p className="p-5 text-sm text-dust">{t('economy.objectives_pick')}</p>
              </>
            )}
          </Panel>
        </div>
      )}

      <CreateDialog
        open={creating}
        busy={created.isPending}
        onClose={() => setCreating(false)}
        onCreate={(input) => created.mutate(input)}
      />

      <ConfirmDialog
        open={remove !== null}
        title={t('common.delete')}
        description={remove?.title ?? ''}
        confirmLabel={t('common.delete')}
        tone="danger"
        busy={destroyed.isPending}
        onConfirm={() => remove && destroyed.mutate(remove.id)}
        onClose={() => setRemove(null)}
      />
    </section>
  )
}

function Editor({
  item,
  busy,
  granting,
  onSave,
  onDelete,
  onGrant,
}: {
  item: Objective
  busy: boolean
  granting: boolean
  onSave: (input: ObjectiveInput) => void
  onDelete: () => void
  onGrant: (username: string) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<ObjectiveInput>(fromItem(item))
  const [username, setUsername] = useState('')

  return (
    <form
      className="flex flex-col gap-4 p-5"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(draft)
      }}
    >
      <ObjectiveFields value={draft} onChange={setDraft} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {t('common.save')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="border-blood text-blood"
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
          {t('common.delete')}
        </Button>
      </div>

      <div className="border-t border-fence pt-4">
        <p className="mb-3 text-sm text-smoke">{t('economy.objective_grant_hint')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label={t('economy.objective_player')}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={granting || username.trim().length < 1}
            onClick={() => onGrant(username.trim())}
          >
            {t('economy.objective_grant')}
          </Button>
        </div>
      </div>
    </form>
  )
}

function CreateDialog({
  open,
  busy,
  onClose,
  onCreate,
}: {
  open: boolean
  busy: boolean
  onClose: () => void
  onCreate: (input: ObjectiveInput) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<ObjectiveInput>({
    title: '',
    kind: 'kills',
    goal: 10,
    xp: 50,
    coins: 0,
    cadence: 'daily',
    active: true,
  })

  return (
    <ConfirmDialog
      open={open}
      size="lg"
      title={t('economy.new_objective')}
      description={<ObjectiveFields value={draft} onChange={setDraft} />}
      confirmLabel={t('economy.new_objective')}
      busy={busy}
      confirmDisabled={!draft.title?.trim()}
      onConfirm={() => onCreate(draft)}
      onClose={onClose}
    />
  )
}

function ObjectiveFields({
  value,
  onChange,
}: {
  value: ObjectiveInput
  onChange: (value: ObjectiveInput) => void
}) {
  const { t } = useTranslation()
  function patch(next: Partial<ObjectiveInput>) {
    onChange({ ...value, ...next })
  }

  const counted = value.kind !== 'play' && value.kind !== 'manual'

  return (
    <div className="flex flex-col gap-3">
      <Field
        label={t('economy.item_name')}
        value={value.title ?? ''}
        onChange={(event) => patch({ title: event.target.value })}
      />
      <TextAreaField
        label={t('economy.objective_brief')}
        value={value.description ?? ''}
        onChange={(event) => patch({ description: event.target.value })}
        className="min-h-16"
      />
      <ChipGroup
        label={t('economy.objective_kind')}
        items={KINDS}
        active={value.kind ?? 'kills'}
        onSelect={(kind) => patch({ kind, goal: kind === 'play' || kind === 'manual' ? 1 : value.goal })}
      />
      <ChipGroup
        label={t('economy.objective_cadence')}
        items={CADENCES}
        active={value.cadence ?? 'daily'}
        onSelect={(cadence) => patch({ cadence })}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        {counted ? (
          <Field
            type="number"
            min={1}
            label={t('economy.objective_goal')}
            value={value.goal ?? 1}
            onChange={(event) => patch({ goal: Number(event.target.value) || 1 })}
          />
        ) : null}
        <Field
          type="number"
          min={0}
          label={t('economy.xp_label')}
          value={value.xp ?? 0}
          onChange={(event) => patch({ xp: Number(event.target.value) || 0 })}
        />
        <Field
          type="number"
          min={0}
          label={t('economy.price')}
          value={value.coins ?? 0}
          onChange={(event) => patch({ coins: Number(event.target.value) || 0 })}
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-bone">
        <input
          type="checkbox"
          checked={value.active ?? true}
          onChange={(event) => patch({ active: event.target.checked })}
        />
        {t('economy.active')}
      </label>
    </div>
  )
}

function ChipGroup({
  label,
  items,
  active,
  onSelect,
}: {
  label: string
  items: { id: string; label: TranslationKey }[]
  active: string
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <fieldset>
      <legend className="mb-2 font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
        {label}
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            className={cn(
              'border px-2 py-1 font-mono text-[0.6875rem] uppercase',
              active === item.id
                ? 'border-hazard bg-hazard-soft text-hazard'
                : 'border-fence text-dust',
            )}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

function fromItem(item: Objective): ObjectiveInput {
  return {
    title: item.title,
    description: item.description,
    kind: item.kind,
    goal: item.goal,
    xp: item.xp,
    coins: item.coins,
    cadence: item.cadence,
    active: item.active,
    sort_order: item.sort_order,
  }
}
