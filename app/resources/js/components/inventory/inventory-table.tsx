import { Package, Scale, Search, Swords } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ConditionBar } from '@/components/inventory/condition-bar';
import { ContainerTabs } from '@/components/inventory/container-tabs';
import type { ContainerTab } from '@/components/inventory/container-tabs';
import { ItemIcon } from '@/components/inventory/item-icon';
import { SortableHeader } from '@/components/sortable-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTableSort } from '@/hooks/use-table-sort';
import { useTranslation } from '@/hooks/use-translation';
import { ALL_ITEMS, MAIN_CONTAINER } from '@/lib/inventory';
import type { ContainerGroup, StackedItem } from '@/types/server';

type SortKey = 'name' | 'category' | 'condition' | 'totalCount';

type Props = {
    items: StackedItem[];
    /** Per-container breakdown; enables the container tabs when given. */
    groups?: ContainerGroup[];
    /** Optional per-row controls rendered in a trailing Actions column. */
    rowActions?: (item: StackedItem) => ReactNode;
};

const ITEMS_PER_PAGE = 20;

/**
 * Searchable, sortable table of stacked inventory items.
 *
 * When `groups` is supplied the containers become tabs and the table shows one
 * container at a time. That is the point of the tabs: a bag's contents used to
 * be sliced across pages of a single long list, so reading what was in a
 * backpack meant paging back and forth. Now a bag is one tab and almost always
 * one page.
 *
 * Search still runs across everything — each tab's badge counts its own matches
 * while a filter is active, so the strip answers "which bag is it in".
 *
 * Read-only unless a `rowActions` renderer is supplied.
 */
export function InventoryTable({ items, groups, rowActions }: Props) {
    const { t } = useTranslation();
    const [filter, setFilter] = useState('');
    const [page, setPage] = useState(1);
    const [activeTab, setActiveTab] = useState<string>(ALL_ITEMS);
    const { sortKey, sortDir, toggleSort } = useTableSort<SortKey>('name', 'asc');

    const tabsAvailable = groups !== undefined && groups.length > 1;

    const matches = useMemo(() => {
        const query = filter.toLowerCase();

        return (row: StackedItem) =>
            row.name.toLowerCase().includes(query) ||
            row.full_type.toLowerCase().includes(query) ||
            row.category.toLowerCase().includes(query);
    }, [filter]);

    const sortRows = useMemo(() => {
        return (rows: StackedItem[]) =>
            [...rows].sort((a, b) => {
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
            });
    }, [sortKey, sortDir]);

    /** Match counts per tab, which is what the strip's badges report. */
    const tabs = useMemo<ContainerTab[]>(() => {
        if (!tabsAvailable) {
            return [];
        }

        return [
            {
                id: ALL_ITEMS,
                label: t('inventory.all_items'),
                depth: 0,
                worn: false,
                count: items.filter(matches).length,
            },
            ...(groups ?? []).map((group) => ({
                id: group.id,
                label: group.label,
                depth: group.depth,
                worn: group.worn,
                count: group.items.filter(matches).length,
            })),
        ];
    }, [tabsAvailable, groups, items, matches, t]);

    /** The container behind the active tab, or null on "all items". */
    const activeGroup = useMemo(
        () => (activeTab === ALL_ITEMS ? null : ((groups ?? []).find((g) => g.id === activeTab) ?? null)),
        [groups, activeTab],
    );

    const visibleRows = useMemo(
        () => sortRows((activeGroup ? activeGroup.items : items).filter(matches)),
        [activeGroup, items, matches, sortRows],
    );

    /** Unfiltered rows in the active tab, for the "showing x of y" line. */
    const availableRows = activeGroup ? activeGroup.items.length : items.length;

    const lastPage = Math.max(1, Math.ceil(visibleRows.length / ITEMS_PER_PAGE));
    const currentPage = Math.min(page, lastPage);
    const pageRows = useMemo(
        () => visibleRows.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE),
        [visibleRows, currentPage],
    );

    /** Jump to the tab for a bag listed in the current one. */
    function openContainer(id: string) {
        setActiveTab(id);
        setPage(1);
    }

    function labelFor(id: string): string {
        if (id === MAIN_CONTAINER) {
            return t('inventory.main_container');
        }

        return (groups ?? []).find((group) => group.id === id)?.label ?? id;
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <CardTitle>
                            {activeGroup ? labelFor(activeGroup.id) : t('inventory.items')}
                        </CardTitle>
                        <CardDescription className="flex flex-wrap items-center gap-x-3">
                            <span>
                                {t('inventory.items_count', {
                                    filtered: String(visibleRows.length),
                                    total: String(availableRows),
                                })}
                            </span>
                            {activeGroup?.capacity != null && (
                                <span className="flex items-center gap-1">
                                    <Scale className="size-3.5" />
                                    {t('inventory.capacity_usage', {
                                        weight: (activeGroup.weight ?? 0).toFixed(1),
                                        capacity: String(activeGroup.capacity),
                                    })}
                                </span>
                            )}
                        </CardDescription>
                    </div>
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
            </CardHeader>

            {tabsAvailable && (
                <div className="px-6">
                    <ContainerTabs
                        tabs={tabs}
                        activeId={activeTab}
                        onSelect={(id) => {
                            setActiveTab(id);
                            setPage(1);
                        }}
                        filtering={filter !== ''}
                    />
                </div>
            )}

            <CardContent
                className="overflow-x-auto"
                id="container-tabpanel"
                role={tabsAvailable ? 'tabpanel' : undefined}
                aria-labelledby={tabsAvailable ? `container-tab-${activeTab || 'all'}` : undefined}
                tabIndex={tabsAvailable ? 0 : undefined}
            >
                {pageRows.length > 0 ? (
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
                                {pageRows.map((item) => (
                                    <TableRow key={`${activeTab}-${item.full_type}`}>
                                        <TableCell>
                                            <ItemIcon src={item.icon} name={item.name} size={32} />
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex min-w-0 flex-col gap-0.5">
                                                <span className="text-sm font-medium">{item.name}</span>
                                                <span className="text-muted-foreground text-xs">{item.full_type}</span>
                                                {item.equipped && (
                                                    <span className="text-muted-foreground flex items-center gap-1 text-xs">
                                                        <Swords className="size-3" />
                                                        {t('common.equipped')}
                                                    </span>
                                                )}
                                                {tabsAvailable && item.opens.length > 0 && (
                                                    <div className="flex flex-wrap gap-1 pt-0.5">
                                                        {item.opens.map((id) => (
                                                            <Button
                                                                key={id}
                                                                variant="outline"
                                                                size="sm"
                                                                className="h-6 gap-1 px-2 text-xs"
                                                                onClick={() => openContainer(id)}
                                                            >
                                                                <Package className="size-3" />
                                                                {t('inventory.open_container', {
                                                                    name: labelFor(id),
                                                                })}
                                                            </Button>
                                                        ))}
                                                    </div>
                                                )}
                                                {/* On "all items" a row can span several bags, so say which. */}
                                                {activeTab === ALL_ITEMS && tabsAvailable && item.containerIds.length > 0 && (
                                                    <div className="flex flex-wrap items-center gap-1 pt-0.5">
                                                        {item.containerIds.map((id) => (
                                                            <Button
                                                                key={id}
                                                                variant="ghost"
                                                                size="sm"
                                                                className="text-muted-foreground h-6 gap-1 px-1.5 text-xs"
                                                                onClick={() => openContainer(id)}
                                                            >
                                                                <Package className="size-3" />
                                                                {labelFor(id)}
                                                            </Button>
                                                        ))}
                                                    </div>
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
                            </TableBody>
                        </Table>

                        {lastPage > 1 && (
                            <div className="mt-4 flex items-center justify-between">
                                <p className="text-muted-foreground text-sm">
                                    {t('inventory.pagination_range', {
                                        start: String((currentPage - 1) * ITEMS_PER_PAGE + 1),
                                        end: String(Math.min(currentPage * ITEMS_PER_PAGE, visibleRows.length)),
                                        total: String(visibleRows.length),
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
                        {filter
                            ? t('inventory.no_items_filter')
                            : activeGroup
                              ? t('inventory.container_is_empty')
                              : t('inventory.no_items_empty')}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}
