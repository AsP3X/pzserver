import type { ContainerGroup, InventoryContainer, InventoryItem, StackedItem } from '@/types/server';

/** Container id the Lua bridge uses for the player's own pockets. */
export const MAIN_CONTAINER = 'inventory';

/**
 * Collapse raw inventory entries into one row per item type.
 * Counts are summed, the worst condition wins, and every container
 * the item was found in is recorded.
 */
export function stackItems(items: InventoryItem[]): StackedItem[] {
    const map = new Map<string, StackedItem>();

    for (const item of items) {
        const existing = map.get(item.full_type);
        if (existing) {
            existing.totalCount += item.count;
            if (item.equipped) existing.equipped = true;
            if (item.condition !== null) {
                existing.condition =
                    existing.condition !== null
                        ? Math.min(existing.condition, item.condition)
                        : item.condition;
            }
            if (!existing.containers.includes(item.container)) {
                existing.containers.push(item.container);
            }
            if (item.contains) {
                existing.opens.push(item.contains);
            }
        } else {
            map.set(item.full_type, {
                full_type: item.full_type,
                name: item.name,
                category: item.category,
                icon: item.icon,
                totalCount: item.count,
                condition: item.condition,
                equipped: item.equipped,
                containers: [item.container],
                opens: item.contains ? [item.contains] : [],
            });
        }
    }

    return [...map.values()];
}

/**
 * Fill one group per container — the player's own pockets, then every bag,
 * holster and pouch they carry — so the dashboard can show what is inside a
 * backpack instead of merging it into one flat list.
 *
 * The tree arrives already ordered and depth-stamped from the server, keyed by
 * container id rather than by name: a player carrying two Wallets has two
 * groups, and each shows only its own contents.
 */
export function groupItemsByContainer(
    items: InventoryItem[],
    containers: InventoryContainer[],
): ContainerGroup[] {
    /** Nothing to nest into: everything reads as one flat group of pockets. */
    if (containers.length === 0) {
        return items.length === 0
            ? []
            : [
                  {
                      id: MAIN_CONTAINER,
                      container: MAIN_CONTAINER,
                      label: MAIN_CONTAINER,
                      depth: 0,
                      worn: false,
                      capacity: null,
                      items: stackItems(items),
                  },
              ];
    }

    const byContainer = new Map<string, InventoryItem[]>();
    for (const item of items) {
        const existing = byContainer.get(item.container_id);
        if (existing) {
            existing.push(item);
        } else {
            byContainer.set(item.container_id, [item]);
        }
    }

    /** Two bags called the same thing get numbered, so their headers differ. */
    const totals = new Map<string, number>();
    for (const container of containers) {
        totals.set(container.name, (totals.get(container.name) ?? 0) + 1);
    }
    const numbered = new Map<string, number>();

    return containers.map((container) => {
        const index = (numbered.get(container.name) ?? 0) + 1;
        numbered.set(container.name, index);

        return {
            id: container.id,
            container: container.name,
            label: (totals.get(container.name) ?? 1) > 1 ? `${container.name} (${index})` : container.name,
            depth: container.depth,
            worn: container.worn ?? false,
            capacity: container.capacity ?? null,
            items: stackItems(byContainer.get(container.id) ?? []),
        };
    });
}
