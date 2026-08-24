import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError, TextAreaField } from '@/components/ui/field'
import { ItemPickerDialog } from '@/components/ui/item-picker'
import { Panel, PanelHeader } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, type CatalogItem, type StoreItem, type StoreItemInput } from '@/lib/api'
import { cn } from '@/lib/cn'
import { adminItemsQuery, adminStorePurchasesQuery, adminStoreQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

const CATEGORIES: { id: string; label: TranslationKey }[] = [
  { id: 'weapons', label: 'economy.category_weapons' },
  { id: 'ammo', label: 'economy.category_ammo' },
  { id: 'food', label: 'economy.category_food' },
  { id: 'medical', label: 'economy.category_medical' },
  { id: 'tools', label: 'economy.category_tools' },
  { id: 'clothing', label: 'economy.category_clothing' },
  { id: 'other', label: 'economy.category_other' },
]

/**
 * Staff catalogue. Players see these as staff lots in the auction house.
 */
export function AdminShopPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const list = useQuery(adminStoreQuery)
  const purchases = useQuery(adminStorePurchasesQuery)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [remove, setRemove] = useState<StoreItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const items = list.data ?? []
  const current = items.find((item) => item.id === selected) ?? null

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'store'] })
    await queryClient.invalidateQueries({ queryKey: ['store'] })
  }

  function fail(cause: unknown) {
    setNotice(null)
    setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
  }

  const created = useMutation({
    mutationFn: (input: StoreItemInput) => api.adminCreateStoreItem(input),
    onSuccess: async (item) => {
      setCreating(false)
      setSelected(item.id)
      setNotice(t('economy.saved'))
      await refresh()
    },
    onError: fail,
  })

  const saved = useMutation({
    mutationFn: (input: StoreItemInput) => {
      if (!current) throw new Error('missing item')
      return api.adminUpdateStoreItem(current.id, input)
    },
    onSuccess: async () => {
      setNotice(t('economy.saved'))
      await refresh()
    },
    onError: fail,
  })

  const destroyed = useMutation({
    mutationFn: (id: string) => api.adminDeleteStoreItem(id),
    onSuccess: async () => {
      setRemove(null)
      setSelected(null)
      setNotice(t('economy.saved'))
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
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('economy.catalogue')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('economy.catalogue_description')}</p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" className="size-3.5" />
          {t('economy.new_item')}
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
            <PanelHeader label={t('economy.listings')} />
            {items.length === 0 ? (
              <p className="p-5 text-sm text-dust">{t('economy.catalogue_empty')}</p>
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
                        <span className="truncate text-sm text-bone">{item.name}</span>
                        <span className={cn('font-mono text-[0.625rem] uppercase', item.active ? 'text-moss' : 'text-dust')}>
                          {item.active ? t('economy.active') : t('admin.automations_disabled')}
                        </span>
                      </span>
                      <span className="font-mono text-[0.6875rem] text-dust">
                        {t('economy.coins', { count: item.price })} · {item.item_type}
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
                onSave={(input) => saved.mutate(input)}
                onDelete={() => setRemove(current)}
              />
            ) : (
              <>
                <PanelHeader label={t('economy.purchases')} />
                {(purchases.data ?? []).length === 0 ? (
                  <p className="p-5 text-sm text-dust">{t('economy.purchases_empty')}</p>
                ) : (
                  <ul className="divide-y divide-fence">
                    {(purchases.data ?? []).map((row) => (
                      <li key={row.id} className="px-5 py-3 text-sm text-smoke">
                        {row.username ?? ''} · {row.item_name} · {t('economy.coins', { count: row.total_price })} · {row.status}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Panel>
        </div>
      )}

      <ItemDialog
        open={creating}
        busy={created.isPending}
        onClose={() => setCreating(false)}
        onCreate={(input) => created.mutate(input)}
      />

      <ConfirmDialog
        open={remove !== null}
        title={t('economy.new_item')}
        description={remove?.name ?? ''}
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
  onSave,
  onDelete,
}: {
  item: StoreItem
  busy: boolean
  onSave: (input: StoreItemInput) => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<StoreItemInput>({
    name: item.name,
    item_type: item.item_type,
    description: item.description,
    category: item.category,
    quantity: item.quantity,
    price: item.price,
    stock: item.stock,
    max_per_player: item.max_per_player,
    featured: item.featured,
    active: item.active,
    sort_order: item.sort_order,
  })

  return (
    <form
      className="flex flex-col gap-4 p-5"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(draft)
      }}
    >
      <ItemFields value={draft} onChange={setDraft} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {t('common.save')}
        </Button>
        <Button type="button" size="sm" variant="outline" className="border-blood text-blood" onClick={onDelete}>
          <Trash2 aria-hidden="true" className="size-3.5" />
          {t('common.delete')}
        </Button>
      </div>
    </form>
  )
}

const EMPTY_LISTING: StoreItemInput = {
  name: '',
  item_type: 'Base.Axe',
  category: 'tools',
  quantity: 1,
  price: 25,
  active: true,
}

function ItemDialog({
  open,
  busy,
  onClose,
  onCreate,
}: {
  open: boolean
  busy: boolean
  onClose: () => void
  onCreate: (input: StoreItemInput) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<StoreItemInput>(EMPTY_LISTING)
  const draftRef = useRef(draft)
  draftRef.current = draft

  useEffect(() => {
    if (open) {
      setDraft({ ...EMPTY_LISTING })
    }
  }, [open])

  return (
    <ConfirmDialog
      open={open}
      size="lg"
      title={t('economy.new_item')}
      description={<ItemFields value={draft} onChange={setDraft} />}
      confirmLabel={t('economy.new_item')}
      busy={busy}
      confirmDisabled={!draft.name?.trim() || !draft.item_type?.trim()}
      onConfirm={() => onCreate({ ...draftRef.current, active: draftRef.current.active ?? true })}
      onClose={onClose}
    />
  )
}

function ItemFields({
  value,
  onChange,
}: {
  value: StoreItemInput
  onChange: (value: StoreItemInput) => void
}) {
  const { t } = useTranslation()
  function patch(next: Partial<StoreItemInput>) {
    onChange({ ...value, ...next })
  }

  /**
   * Setting the ID is unconditional; filling the name is not.
   *
   * On a new listing the name is empty, so picking Fire Axe saves a retype. On
   * an edit it is whatever staff chose to call it — possibly deliberately not
   * the vanilla name — and changing the item must not overwrite that.
   */
  function pick(item: CatalogItem) {
    const named = (value.name ?? '').trim() === '' && item.name !== ''

    onChange({
      ...value,
      item_type: item.full_type,
      ...(named ? { name: item.name } : {}),
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label={t('economy.item_name')} value={value.name ?? ''} onChange={(event) => patch({ name: event.target.value })} />
      <ItemTypeField value={value} onPick={pick} />
      <TextAreaField
        label={t('admin.automations_message')}
        value={value.description ?? ''}
        onChange={(event) => patch({ description: event.target.value })}
        className="min-h-16"
      />
      <fieldset>
        <legend className="mb-2 font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
          {t('economy.category')}
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => patch({ category: item.id })}
              className={cn(
                'border px-2 py-1 font-mono text-[0.6875rem] uppercase',
                value.category === item.id
                  ? 'border-hazard bg-hazard-soft text-hazard'
                  : 'border-fence text-dust',
              )}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          type="number"
          min={0}
          label={t('economy.price')}
          value={value.price ?? 0}
          onChange={(event) => patch({ price: Number(event.target.value) || 0 })}
        />
        <Field
          type="number"
          min={1}
          label={t('economy.quantity')}
          value={value.quantity ?? 1}
          onChange={(event) => patch({ quantity: Number(event.target.value) || 1 })}
        />
        <Field
          type="number"
          min={0}
          label={t('economy.stock')}
          value={value.stock ?? ''}
          onChange={(event) =>
            patch({ stock: event.target.value === '' ? null : Number(event.target.value) })
          }
        />
        <Field
          type="number"
          min={1}
          label={t('economy.max_per_player')}
          value={value.max_per_player ?? ''}
          onChange={(event) =>
            patch({
              max_per_player: event.target.value === '' ? null : Number(event.target.value),
            })
          }
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
      <label className="flex items-center gap-2 text-sm text-bone">
        <input
          type="checkbox"
          checked={value.featured ?? false}
          onChange={(event) => patch({ featured: event.target.checked })}
        />
        {t('economy.featured')}
      </label>
    </div>
  )
}

/**
 * The item ID, as a button rather than a text box.
 *
 * Typing `Base.Axe` by hand is fine; the other five thousand IDs are not, and
 * a typo produces a listing that takes coins and delivers nothing, because
 * `additem` fails silently on an ID the server does not know.
 */
function ItemTypeField({
  value,
  onPick,
}: {
  value: StoreItemInput
  onPick: (item: CatalogItem) => void
}) {
  const { t } = useTranslation()
  const [picking, setPicking] = useState(false)
  const catalogue = useQuery(adminItemsQuery)

  const itemType = value.item_type ?? ''
  const known = catalogue.data?.items.find((item) => item.full_type === itemType) ?? null

  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
        {t('economy.item_type')}
      </span>

      <button
        type="button"
        onClick={() => setPicking(true)}
        className={cn(
          'flex h-12 items-center justify-between gap-3 border border-fence-bright bg-void px-3 text-left',
          'transition-colors hover:border-hazard',
        )}
      >
        {itemType === '' ? (
          <span className="text-sm text-dust">{t('economy.choose_item')}</span>
        ) : (
          <span className="min-w-0">
            {known ? (
              <span className="block truncate text-sm text-bone">{known.name}</span>
            ) : null}
            <span
              className={cn(
                'block truncate font-mono',
                known ? 'text-xs text-smoke' : 'text-sm text-bone',
              )}
            >
              {itemType}
            </span>
          </span>
        )}
        <Search aria-hidden="true" className="size-4 shrink-0 text-dust" />
      </button>

      <ItemPickerDialog open={picking} onSelect={onPick} onClose={() => setPicking(false)} />
    </div>
  )
}
