import { Backpack, List, Package, Search, Swords } from 'lucide-react';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { ConditionBar } from '@/components/inventory/condition-bar';
import { ItemIcon } from '@/components/inventory/item-icon';
import { SortableHeader } from '@/components/sortable-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useTableSort } from '@/hooks/use-table-sort';
import { useTranslation } from '@/hooks/use-translation';
import { MAIN_CONTAINER } from '@/lib/inventory';
import type { ContainerGroup, StackedItem } from '@/types/server';

type SortKey = 'name' | 'category' | 'condition' | 'totalCount';

type Props = {
    items: StackedItem[];
    /** Per-container breakdown; enables the "by container" view when given. */
    groups?: ContainerGroup[];
    /** Optional per-row controls rendered in a trailing Actions column. */
    rowActions?: (item: StackedItem) => ReactNode;
};

const ITEMS_PER_PAGE = 20;

/** Pixels each nesting level is pushed in, so a bag's contents read as its own. */
const INDENT_STEP = 20;

/**
 * Searchable, sortable, paginated table of stacked inventory items.
 * Groups rows by the container holding them when `groups` is supplied.
 * Read-only unless a `rowActions` renderer is supplied.
 */
export function InventoryTable({ items, groups, rowActions }: Props) {
    const { t } = useTranslation();
    const [filter, setFilter] = useState('');
    const [page, setPage] = useState(1);
    const [grouped, setGrouped] = useState(true);
    const { sortKey, sortDir, toggleSort } = useTableSort<SortKey>('name', 'asc');

    const groupsAvailable = groups !== undefined && groups.length > 1;
    const showGroups = groupsAvailable && grouped;

    /**
     * Every group's rows filtered and sorted, empty groups dropped. The flat
     * view is modelled as a single unnamed group so both views share one path.
     */
    const visibleGroups = useMemo(() => {
        const query = filter.toLowerCase();
        const source: ContainerGroup[] = showGroups
            ? (groups ?? [])
            : [{ container: '', depth: 0, items }];

        return source
            .map((group) => ({
                ...group,
                items: group.items
                    .filter(
                        (item) =>
                            item.name.toLowerCase().includes(query) ||
                            item.full_type.toLowerCase().includes(query) ||
                            item.category.toLowerCase().includes(query),
                    )
                    .sort((a, b) => {
                        /** Items with no durability sit out the condition sort entirely. */
                        if (sortKey === 'condition' && (a.condition === null || b.condition === null)) {
                            if (a.condition === b.condition) return a.name.localeCompare(b.name);
                            return a.condition === null ? 1 : -1;
                        }

                        let cmp = 0;
                        if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
                        else if (sortKey === 'category')
                            cmp = a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
                        else if (sortKey === 'condition') cmp = (a.condition ?? 0) - (b.condition ?? 0);
                        else if (sortKey === 'totalCount') cmp = a.totalCount - b.totalCount;
                        return sortDir === 'desc' ? -cmp : cmp;
                    }),
            }))
            .filter((group) => group.items.length > 0);
    }, [groups, items, showGroups, filter, sortKey, sortDir]);

    const totalRows = useMemo(
        () => visibleGroups.reduce((sum, group) => sum + group.items.length, 0),
        [visibleGroups],
    );

    /** Unfiltered row count for the active view — a type held in two bags is two rows. */
    const availableRows = useMemo(
        () => (showGroups ? (groups ?? []).reduce((sum, group) => sum + group.items.length, 0) : items.length),
        [groups, items, showGroups],
    );

    const lastPage = Math.max(1, Math.ceil(totalRows / ITEMS_PER_PAGE));
    const currentPage = Math.min(page, lastPage);

    /** Slice item rows across group boundaries, keeping each page's headers. */
    const pagedGroups = useMemo(() => {
        const start = (currentPage - 1) * ITEMS_PER_PAGE;
        const end = start + ITEMS_PER_PAGE;
        const result: ContainerGroup[] = [];
        let offset = 0;

        for (const group of visibleGroups) {
            const groupEnd = offset + group.items.length;
            if (groupEnd > start && offset < end) {
                result.push({
                    ...group,
                    items: group.items.slice(Math.max(0, start - offset), Math.max(0, end - offset)),
                });
            }
            offset = groupEnd;
        }

        return result;
    }, [visibleGroups, currentPage]);

    /** Container names, so a bag row can point at the group holding its contents. */
    const containerNames = useMemo(
        () => new Set((groups ?? []).map((group) => group.container)),
        [groups],
    );

    const columnCount = 5 + (rowActions ? 1 : 0);

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <CardTitle>{t('inventory.items')}</CardTitle>
                        <CardDescription>
                            {t('inventory.items_count', {
                                filtered: String(totalRows),
                                total: String(availableRows),
                            })}
                        </CardDescription>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        {groupsAvailable && (
                            <ToggleGroup
                                type="single"
                                variant="outline"
                                size="sm"
                                value={grouped ? 'grouped' : 'flat'}
                                onValueChange={(value) => {
                                    if (!value) return;
                                    setGrouped(value === 'grouped');
                                    setPage(1);
                                }}
                            >
                                <ToggleGroupItem value="grouped" aria-label={t('inventory.group_by_container')}>
                                    <Backpack className="size-4" />
                                    <span className="hidden sm:inline">{t('inventory.group_by_container')}</span>
                                </ToggleGroupItem>
                                <ToggleGroupItem value="flat" aria-label={t('inventory.flat_list')}>
                                    <List className="size-4" />
                                    <span className="hidden sm:inline">{t('inventory.flat_list')}</span>
                                </ToggleGroupItem>
                            </ToggleGroup>
                        )}
                        <div className="relative">
                            <Search className="text-muted-foreground absolute left-2.5 top-2.5 size-4" />
                            <Input
                                placeholder={t('inventory.filter_items')}
                                value={filter}
                                onChange={(e) => {
                                    setFilter(e.target.value);
                                    setPage(1);
                                }}
                                className="pl-9 sm:w-[200px]"
                            />
                        </div>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="overflow-x-auto">
                {totalRows > 0 ? (
                    <>
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="w-[50px]" />
                                    <TableHead>
                                        <SortableHeader column="name" label={t('inventory.item')} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                                    </TableHead>
                                    <TableHead>
                                        <SortableHeader column="category" label={t('common.category')} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                                    </TableHead>
                                    <TableHead className="text-center">
                                        <SortableHeader column="totalCount" label={t('inventory.qty')} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                                    </TableHead>
                                    <TableHead className="w-[120px]">
                                        <SortableHeader column="condition" label={t('inventory.condition')} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                                    </TableHead>
                                    {rowActions && <TableHead>{t('common.actions')}</TableHead>}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {pagedGroups.map((group) => (
                                    <Fragment key={group.container}>
                                        {showGroups && (
                                            <TableRow className="bg-muted/50 hover:bg-muted/50">
                                                <TableCell colSpan={columnCount} className="py-2">
                                                    <div
                                                        className="flex items-center gap-2"
                                                        style={{ paddingLeft: group.depth * INDENT_STEP }}
                                                    >
                                                        {group.container === MAIN_CONTAINER ? (
                                                            <Backpack className="text-muted-foreground size-4" />
                                                        ) : (
                                                            <Package className="text-muted-foreground size-4" />
                                                        )}
                                                        <span className="text-sm font-semibold">
                                                            {group.container === MAIN_CONTAINER
                                                                ? t('inventory.main_container')
                                                                : group.container}
                                                        </span>
                                                        <Badge variant="secondary" className="text-xs">
                                                            {t('inventory.container_items', {
                                                                count: String(group.items.length),
                                                            })}
                                                        </Badge>
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        )}
                                        {group.items.map((item) => (
                                            <TableRow key={`${group.container}-${item.full_type}`}>
                                                <TableCell>
                                                    <div
                                                        className="flex items-center gap-2"
                                                        style={{
                                                            paddingLeft: showGroups
                                                                ? group.depth * INDENT_STEP + 8
                                                                : undefined,
                                                        }}
                                                    >
                                                        {showGroups && <span className="bg-border h-8 w-px shrink-0" />}
                                                        <ItemIcon src={item.icon} name={item.name} size={32} />
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex min-w-0 flex-col">
                                                        <span className="text-sm font-medium">{item.name}</span>
                                                        <span className="text-muted-foreground text-xs">{item.full_type}</span>
                                                        {item.equipped && (
                                                            <span className="text-muted-foreground flex items-center gap-1 text-xs">
                                                                <Swords className="size-3" />
                                                                {t('common.equipped')}
                                                            </span>
                                                        )}
                                                        {showGroups && containerNames.has(item.name) && (
                                                            <span className="text-muted-foreground flex items-center gap-1 text-xs">
                                                                <Package className="size-3" />
                                                                {t('inventory.contents_below')}
                                                            </span>
                                                        )}
                                                        {!showGroups && item.containers.length > 0 && (
                                                            <span className="text-muted-foreground flex items-center gap-1 text-xs">
                                                                <Package className="size-3" />
                                                                {item.containers
                                                                    .map((container) =>
                                                                        container === MAIN_CONTAINER
                                                                            ? t('inventory.main_container')
                                                                            : container,
                                                                    )
                                                                    .join(', ')}
                                                            </span>
                                                        )}
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="outline" className="text-xs">
                                                        {item.category}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell className="text-center">
                                                    <span className="font-medium tabular-nums">{item.totalCount}</span>
                                                </TableCell>
                                                <TableCell>
                                                    <ConditionBar condition={item.condition} />
                                                </TableCell>
                                                {rowActions && <TableCell>{rowActions(item)}</TableCell>}
                                            </TableRow>
                                        ))}
                                    </Fragment>
                                ))}
                            </TableBody>
                        </Table>

                        {lastPage > 1 && (
                            <div className="mt-4 flex items-center justify-between">
                                <p className="text-muted-foreground text-sm">
                                    {t('inventory.pagination_range', {
                                        start: String((currentPage - 1) * ITEMS_PER_PAGE + 1),
                                        end: String(Math.min(currentPage * ITEMS_PER_PAGE, totalRows)),
                                        total: String(totalRows),
                                    })}
                                </p>
                                <div className="flex items-center gap-1">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={currentPage <= 1}
                                        onClick={() => setPage(currentPage - 1)}
                                    >
                                        {t('common.previous')}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={currentPage >= lastPage}
                                        onClick={() => setPage(currentPage + 1)}
                                    >
                                        {t('common.next')}
                                    </Button>
                                </div>
                            </div>
                        )}
                    </>
                ) : (
                    <p className="text-muted-foreground py-8 text-center">
                        {filter ? t('inventory.no_items_filter') : t('inventory.no_items_empty')}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}
