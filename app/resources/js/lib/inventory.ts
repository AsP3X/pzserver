import type { InventoryItem, StackedItem } from '@/types/server';

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
            });
        }
    }

    return [...map.values()];
}
