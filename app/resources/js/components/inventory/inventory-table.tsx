import { Search, Swords } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { ConditionBar } from '@/components/inventory/condition-bar';
import { ItemIcon } from '@/components/inventory/item-icon';
import { SortableHeader } from '@/components/sortable-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTableSort } from '@/hooks/use-table-sort';
import { useTranslation } from '@/hooks/use-translation';
import type { StackedItem } from '@/types/server';

type SortKey = 'name' | 'category' | 'condition' | 'totalCount';

type Props = {
    items: StackedItem[];
    /** Optional per-row controls rendered in a trailing Actions column. */
    rowActions?: (item: StackedItem) => ReactNode;
};

const ITEMS_PER_PAGE = 20;

/**
 * Searchable, sortable, paginated table of stacked inventory items.
 * Read-only unless a `rowActions` renderer is supplied.
 */
export function InventoryTable({ items, rowActions }: Props) {
    const { t } = useTranslation();
    const [filter, setFilter] = useState('');
    const [page, setPage] = useState(1);
    const { sortKey, sortDir, toggleSort } = useTableSort<SortKey>('name', 'asc');

    const filteredItems = useMemo(() => {
        const query = filter.toLowerCase();
        const result = items.filter(
            (item) =>
                item.name.toLowerCase().includes(query) ||
                item.full_type.toLowerCase().includes(query) ||
                item.category.toLowerCase().includes(query),
        );

        result.sort((a, b) => {
            let cmp = 0;
            if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
            else if (sortKey === 'category') cmp = a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
            else if (sortKey === 'condition') cmp = (a.condition ?? 0) - (b.condition ?? 0);
            else if (sortKey === 'totalCount') cmp = a.totalCount - b.totalCount;
            return sortDir === 'desc' ? -cmp : cmp;
        });

        return result;
    }, [items, filter, sortKey, sortDir]);

    const lastPage = Math.max(1, Math.ceil(filteredItems.length / ITEMS_PER_PAGE));
    const currentPage = Math.min(page, lastPage);
    const paginatedItems = useMemo(
        () => filteredItems.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE),
        [filteredItems, currentPage],
    );

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <CardTitle>{t('inventory.items')}</CardTitle>
                        <CardDescription>
                            {t('inventory.items_count', {
                                filtered: String(filteredItems.length),
                                total: String(items.length),
                            })}
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
            <CardContent className="overflow-x-auto">
                {filteredItems.length > 0 ? (
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
                                {paginatedItems.map((item) => (
                                    <TableRow key={item.full_type}>
                                        <TableCell>
                                            <ItemIcon src={item.icon} name={item.name} size={32} />
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
                                        end: String(Math.min(currentPage * ITEMS_PER_PAGE, filteredItems.length)),
                                        total: String(filteredItems.length),
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
