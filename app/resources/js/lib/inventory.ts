import type { ContainerGroup, InventoryItem, StackedItem } from '@/types/server';

/** Container name the Lua bridge uses for the player's own pockets. */
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

/**
 * Split the snapshot into one group per container — the player's own pockets,
 * then every bag, holster and pouch they carry — so the dashboard can show
 * what is inside a backpack instead of merging it into one flat list.
 *
 * A bag is listed as an item in whichever container holds it, which is what
 * links the groups into a tree: the group named "Big Hiking Bag" nests under
 * the group holding the item called "Big Hiking Bag". Bags that are worn
 * rather than carried have no such item and stay at the top level.
 */
export function groupItemsByContainer(items: InventoryItem[]): ContainerGroup[] {
    const byContainer = new Map<string, InventoryItem[]>();

    for (const item of items) {
        const existing = byContainer.get(item.container);
        if (existing) {
            existing.push(item);
        } else {
            byContainer.set(item.container, [item]);
        }
    }

    const parents = new Map<string, string>();
    for (const container of byContainer.keys()) {
        const holder = items.find((item) => item.name === container && item.container !== container);
        if (holder && byContainer.has(holder.container)) {
            parents.set(container, holder.container);
        }
    }

    const children = new Map<string, string[]>();
    const roots: string[] = [];
    for (const container of byContainer.keys()) {
        const parent = parents.get(container);
        if (parent === undefined) {
            roots.push(container);
            continue;
        }
        const siblings = children.get(parent);
        if (siblings) {
            siblings.push(container);
        } else {
            children.set(parent, [container]);
        }
    }

    /** The player's own pockets lead, whatever order the snapshot arrived in. */
    roots.sort((a, b) => Number(b === MAIN_CONTAINER) - Number(a === MAIN_CONTAINER));

    const groups: ContainerGroup[] = [];
    const visited = new Set<string>();

    const descend = (container: string, depth: number): void => {
        if (visited.has(container)) {
            return;
        }
        visited.add(container);

        groups.push({
            container,
            depth,
            items: stackItems(byContainer.get(container) ?? []),
        });

        for (const child of children.get(container) ?? []) {
            descend(child, depth + 1);
        }
    };

    for (const root of roots) {
        descend(root, 0);
    }

    /** A bag reported as its own ancestor would otherwise vanish from the view. */
    for (const container of byContainer.keys()) {
        descend(container, 0);
    }

    return groups;
}
