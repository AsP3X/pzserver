/** Turning a raw snapshot into something readable. */

import type { InventoryContainer, InventoryItem } from '@/lib/api'

/** The container id the bridge uses for the player's own pockets. */
export const POCKETS = 'inventory'

export interface StackedItem {
  full_type: string
  name: string
  category: string
  count: number
  /** Worst condition across the stack — the one that will break first. */
  condition: number | null
  equipped: boolean
  /** Container id this stack opens into, when the item is a bag. */
  opens: string | null
}

export interface ContainerGroup {
  container: InventoryContainer
  /** How deep in the bag tree, for indentation. */
  depth: number
  items: StackedItem[]
  /** Every item under this container, including nested bags. */
  totalCount: number
}

/**
 * Collapse entries into one row per item type.
 *
 * Twelve nails are twelve rows in the snapshot and one line to a reader. The
 * worst condition wins, because that is the one that will break first, and
 * anything equipped marks the whole stack.
 */
export function stackItems(items: InventoryItem[]): StackedItem[] {
  const stacks = new Map<string, StackedItem>()

  for (const item of items) {
    const existing = stacks.get(item.full_type)

    if (!existing) {
      stacks.set(item.full_type, {
        full_type: item.full_type,
        name: item.name,
        category: item.category,
        count: item.count,
        condition: item.condition,
        equipped: item.equipped,
        opens: item.contains,
      })

      continue
    }

    existing.count += item.count
    existing.equipped ||= item.equipped
    existing.opens ??= item.contains

    if (item.condition !== null) {
      existing.condition =
        existing.condition === null
          ? item.condition
          : Math.min(existing.condition, item.condition)
    }
  }

  return [...stacks.values()].sort(
    (left, right) =>
      Number(right.equipped) - Number(left.equipped) ||
      left.category.localeCompare(right.category) ||
      left.name.localeCompare(right.name),
  )
}

/**
 * One group per container, in tree order.
 *
 * Grouping is by container **id**, not name: a player carrying two identical
 * wallets has two groups, each showing only its own contents. The bridge writes
 * the tree depth-first and interleaved, so walking from the roots reproduces
 * the order the game would show.
 */
export function groupByContainer(
  items: InventoryItem[],
  containers: InventoryContainer[],
): ContainerGroup[] {
  const byParent = new Map<string | null, InventoryContainer[]>()

  for (const container of containers) {
    // The pockets node has no parent; a bag whose parent went missing is
    // treated as a root so its contents are never silently dropped.
    const parent =
      container.parent && containers.some((other) => other.id === container.parent)
        ? container.parent
        : null

    byParent.set(parent, [...(byParent.get(parent) ?? []), container])
  }

  const groups: ContainerGroup[] = []

  const walk = (parent: string | null, depth: number) => {
    for (const container of byParent.get(parent) ?? []) {
      const own = items.filter((item) => item.container_id === container.id)

      groups.push({
        container,
        depth,
        items: stackItems(own),
        totalCount: own.reduce((sum, item) => sum + item.count, 0),
      })

      walk(container.id, depth + 1)
    }
  }

  walk(null, 0)

  return groups
}

/** Case-insensitive match on the name or the category. */
export function matchesSearch(item: StackedItem, search: string): boolean {
  if (search === '') {
    return true
  }

  const needle = search.toLowerCase()

  return (
    item.name.toLowerCase().includes(needle) ||
    item.category.toLowerCase().includes(needle)
  )
}
