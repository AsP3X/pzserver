import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useEffect, useState } from 'react'

import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field } from '@/components/ui/field'
import { ItemPickerDialog } from '@/components/ui/item-picker'
import { cn } from '@/lib/cn'
import { itemsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { BuyOfferInput, CatalogItem } from '@/lib/api'

/**
 * Post a buy offer. Players name a count and escrow coins now. Staff may
 * post unlimited quantity and no end date, house-funded.
 */
export function BuyOfferDialog({
  open,
  staff,
  available,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean
  staff: boolean
  available: number
  busy: boolean
  onClose: () => void
  onSubmit: (input: BuyOfferInput) => void
}) {
  const { t } = useTranslation()
  const catalogue = useQuery({ ...itemsQuery, enabled: open })
  const [picking, setPicking] = useState(false)
  const [itemType, setItemType] = useState('')
  const [name, setName] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [unit, setUnit] = useState(10)
  const [hours, setHours] = useState(24)
  const [unlimited, setUnlimited] = useState(false)
  const [indefinite, setIndefinite] = useState(false)

  useEffect(() => {
    if (open) {
      setPicking(false)
      setItemType('')
      setName('')
      setQuantity(1)
      setUnit(10)
      setHours(24)
      setUnlimited(false)
      setIndefinite(false)
    }
  }, [open])

  const known = catalogue.data?.items.find((item) => item.full_type === itemType) ?? null
  const count = Math.max(1, quantity)
  const total = unlimited ? 0 : Math.max(1, unit) * count
  const short = !staff && !unlimited && total > available
  const quantityOk = staff && unlimited ? true : count >= 1

  function pick(item: CatalogItem) {
    setItemType(item.full_type)
    if (name.trim() === '' && item.name !== '') {
      setName(item.name)
    }
    setPicking(false)
  }

  return (
    <>
      <ConfirmDialog
        open={open}
        size="lg"
        title={t('economy.post_buy_offer')}
        description={
          <div className="flex flex-col gap-3">
            <p className="text-xs text-dust">
              {staff ? t('economy.staff_offer_hint') : t('economy.buy_offer_hint')}
            </p>
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
                    {known || name ? (
                      <span className="block truncate text-sm text-bone">
                        {known?.name || name}
                      </span>
                    ) : null}
                    <span
                      className={cn(
                        'block truncate font-mono',
                        known || name ? 'text-xs text-smoke' : 'text-sm text-bone',
                      )}
                    >
                      {itemType}
                    </span>
                  </span>
                )}
                <Search aria-hidden="true" className="size-4 shrink-0 text-dust" />
              </button>
            </div>
            <Field
              label={t('economy.item_name')}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                type="number"
                min={1}
                max={100}
                label={t('economy.want_quantity')}
                value={unlimited ? '' : quantity}
                onChange={(event) => setQuantity(Number(event.target.value) || 1)}
                disabled={unlimited}
                hint={
                  unlimited
                    ? t('economy.unlimited')
                    : t('economy.offer_total', { count: total })
                }
              />
              <Field
                type="number"
                min={1}
                label={t('economy.unit_price')}
                value={unit}
                onChange={(event) => setUnit(Number(event.target.value) || 1)}
              />
            </div>
            {staff ? (
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm text-bone">
                  <input
                    type="checkbox"
                    checked={unlimited}
                    onChange={(event) => setUnlimited(event.target.checked)}
                  />
                  {t('economy.unlimited')}
                </label>
                <label className="flex items-center gap-2 text-sm text-bone">
                  <input
                    type="checkbox"
                    checked={indefinite}
                    onChange={(event) => setIndefinite(event.target.checked)}
                  />
                  {t('economy.indefinite')}
                </label>
              </div>
            ) : null}
            {short ? (
              <p className="text-xs text-blood">{t('economy.offer_short')}</p>
            ) : null}
            {indefinite ? null : (
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
            )}
          </div>
        }
        confirmLabel={t('economy.post_buy_offer')}
        busy={busy}
        confirmDisabled={itemType.trim().length < 3 || unit < 1 || !quantityOk || short}
        onConfirm={() =>
          onSubmit({
            item_type: itemType,
            item_name: name || known?.name,
            quantity: unlimited ? null : count,
            price: unit,
            hours: indefinite ? null : hours,
            unlimited,
            indefinite,
          })
        }
        onClose={onClose}
      />
      {picking ? (
        <ItemPickerDialog open onSelect={pick} onClose={() => setPicking(false)} />
      ) : null}
    </>
  )
}
