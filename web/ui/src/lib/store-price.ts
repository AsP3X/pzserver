import type { StoreItem, StoreItemInput } from '@/lib/api'

/** What the player actually pays for one catalogue listing. */
export function storeUnitPrice(item: Pick<StoreItem, 'price' | 'on_sale' | 'discount_percent'> | StoreItemInput): number {
  const list = item.price ?? 0
  if (!item.on_sale) {
    return list
  }

  const pct = Math.min(99, Math.max(0, Math.round(item.discount_percent ?? 0)))
  if (pct <= 0) {
    return list
  }

  return Math.max(0, Math.floor((list * (100 - pct)) / 100))
}

export function storeOnSale(item: Pick<StoreItem, 'on_sale' | 'discount_percent'> | StoreItemInput): boolean {
  return Boolean(item.on_sale) && (item.discount_percent ?? 0) > 0
}
