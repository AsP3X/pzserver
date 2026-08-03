import { Backpack, Package, Weight } from 'lucide-react';
import { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { useTranslation } from '@/hooks/use-translation';
import type { InventorySnapshot, StackedItem } from '@/types/server';

type Props = {
    inventory: InventorySnapshot;
    stackedItems: StackedItem[];
};

/**
 * Summary row above an inventory table: total items, carried weight, category count.
 */
export function InventoryStats({ inventory, stackedItems }: Props) {
    const { t } = useTranslation();

    const totalItemCount = useMemo(
        () => inventory.items.reduce((sum, item) => sum + item.count, 0),
        [inventory.items],
    );

    const categoryCount = useMemo(
        () => new Set(inventory.items.map((item) => item.category)).size,
        [inventory.items],
    );

    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card>
                <CardContent className="flex items-center gap-3 pt-6">
                    <Backpack className="text-muted-foreground size-5" />
                    <div>
                        <p className="text-2xl font-bold">
                            {totalItemCount}
                            <span className="text-muted-foreground text-sm font-normal">
                                {' '}
                                ({t('inventory.unique', { count: String(stackedItems.length) })})
                            </span>
                        </p>
                        <p className="text-muted-foreground text-xs">{t('inventory.total_items')}</p>
                    </div>
                </CardContent>
            </Card>
            <Card>
                <CardContent className="flex items-center gap-3 pt-6">
                    <Weight className="text-muted-foreground size-5" />
                    <div>
                        <p className="text-2xl font-bold">
                            {inventory.weight.toFixed(1)}
                            <span className="text-muted-foreground text-sm font-normal">
                                {' '}
                                / {inventory.max_weight.toFixed(1)}
                            </span>
                        </p>
                        <p className="text-muted-foreground text-xs">{t('common.weight')}</p>
                    </div>
                </CardContent>
            </Card>
            <Card>
                <CardContent className="flex items-center gap-3 pt-6">
                    <Package className="text-muted-foreground size-5" />
                    <div>
                        <p className="text-2xl font-bold">{categoryCount}</p>
                        <p className="text-muted-foreground text-xs">{t('inventory.categories')}</p>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
