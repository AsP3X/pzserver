import { Head, router, usePoll } from '@inertiajs/react';
import {
    ChevronDown,
    Circle,
    Loader2,
    Plus,
    RefreshCw,
    Search,
    Trash2,
    X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { InventoryStats } from '@/components/inventory/inventory-stats';
import { InventoryTable } from '@/components/inventory/inventory-table';
import { ItemIcon } from '@/components/inventory/item-icon';
import { useTranslation } from '@/hooks/use-translation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import AppLayout from '@/layouts/app-layout';
import { formatRelativeTime } from '@/lib/dates';
import { fetchAction } from '@/lib/fetch-action';
import { groupItemsByContainer, stackItems } from '@/lib/inventory';
import type { BreadcrumbItem } from '@/types';
import type {
    DeliveryEntry,
    DeliveryResult,
    InventorySnapshot,
    ItemCatalogEntry,
    StackedItem,
} from '@/types/server';

type Props = {
    username: string;
    inventory: InventorySnapshot | null;
    catalog: ItemCatalogEntry[];
    deliveries: {
        pending: DeliveryEntry[];
        results: DeliveryResult[];
    };
};

export default function PlayerInventory({ username, inventory, catalog, deliveries }: Props) {
    const { t } = useTranslation();
    const [giveOpen, setGiveOpen] = useState(false);
    const [removeTarget, setRemoveTarget] = useState<StackedItem | null>(null);
    const [giveSearch, setGiveSearch] = useState('');
    const [giveSelected, setGiveSelected] = useState<ItemCatalogEntry | null>(null);
    const [giveCount, setGiveCount] = useState(1);
    const [removeCount, setRemoveCount] = useState(1);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [deliveryOpen, setDeliveryOpen] = useState(true);

    usePoll(5000, { only: ['inventory', 'deliveries'] });

    const breadcrumbs: BreadcrumbItem[] = [
        { title: t('nav.dashboard'), href: '/dashboard' },
        { title: t('nav.players'), href: '/admin/players' },
        { title: t('admin.player_inventory.breadcrumb', { username }), href: `/admin/players/${username}/inventory` },
    ];

    const items = inventory?.items ?? [];
    const stackedItems = useMemo(() => stackItems(items), [items]);
    const containerGroups = useMemo(
        () => groupItemsByContainer(items, inventory?.containers ?? []),
        [items, inventory?.containers],
    );

    const filteredCatalog = useMemo(() => {
        if (!giveSearch) return catalog.slice(0, 50);
        const q = giveSearch.toLowerCase();
        return catalog
            .filter(
                (item) =>
                    item.name.toLowerCase().includes(q) || item.full_type.toLowerCase().includes(q),
            )
            .slice(0, 50);
    }, [catalog, giveSearch]);

    async function postAction(url: string, data: Record<string, unknown>, onDone: () => void) {
        setLoading(true);
        setError(null);
        const result = await fetchAction(url, { data });
        if (result) {
            onDone();
        } else {
            setError(t('admin.player_inventory.action_failed'));
        }
        setLoading(false);
        router.reload({ only: ['inventory', 'deliveries'] });
    }

    function handleGive() {
        if (!giveSelected) return;
        postAction(
            `/admin/players/${username}/inventory/give`,
            { item_type: giveSelected.full_type, count: giveCount },
            () => {
                setGiveOpen(false);
                setGiveSelected(null);
                setGiveSearch('');
                setGiveCount(1);
            },
        );
    }

    function handleRemove() {
        if (!removeTarget) return;
        postAction(
            `/admin/players/${username}/inventory/remove`,
            { item_type: removeTarget.full_type, count: removeCount },
            () => {
                setRemoveTarget(null);
                setRemoveCount(1);
            },
        );
    }

    const pendingCount = deliveries.pending.length;
    const resultCount = deliveries.results.length;
    const totalDeliveries = pendingCount + resultCount;

    return (
        <AppLayout breadcrumbs={breadcrumbs}>
            <Head title={t('admin.player_inventory.title', { username })} />
            <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold tracking-tight">
                            {t('admin.player_inventory.heading', { username })}
                        </h1>
                        {inventory ? (
                            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
                                {t('admin.player_inventory.last_updated', { time: formatRelativeTime(inventory.timestamp, t) })}
                                <RefreshCw className="size-3 animate-spin" />
                            </p>
                        ) : (
                            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
                                {t('admin.player_inventory.waiting')}
                                <RefreshCw className="size-3 animate-spin" />
                            </p>
                        )}
                    </div>
                    <Button onClick={() => setGiveOpen(true)}>
                        <Plus className="mr-1.5 size-4" />
                        {t('admin.player_inventory.give_item')}
                    </Button>
                </div>

                {error && (
                    <div className="flex items-center justify-between rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                        <span>{error}</span>
                        <button onClick={() => setError(null)}>
                            <X className="size-4" />
                        </button>
                    </div>
                )}

                {!inventory ? (
                    <Card>
                        <CardContent className="py-12">
                            <div className="flex flex-col items-center gap-3 text-center">
                                <Loader2 className="text-muted-foreground size-8 animate-spin" />
                                <div>
                                    <p className="font-medium">{t('admin.player_inventory.requesting_data')}</p>
                                    <p className="text-muted-foreground text-sm">
                                        {t('admin.player_inventory.player_needs_online')}
                                    </p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                ) : (
                    <>
                        <InventoryStats inventory={inventory} stackedItems={stackedItems} />

                        <InventoryTable
                            items={stackedItems}
                            groups={containerGroups}
                            rowActions={(item) => (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="size-8 p-0"
                                    onClick={() => {
                                        setRemoveCount(1);
                                        setRemoveTarget(item);
                                    }}
                                >
                                    <Trash2 className="size-4 text-destructive" />
                                </Button>
                            )}
                        />
                    </>
                )}

                {/* Delivery Status Panel — always visible */}
                <Collapsible open={deliveryOpen} onOpenChange={setDeliveryOpen}>
                    <Card>
                        <CollapsibleTrigger asChild>
                            <CardHeader className="cursor-pointer">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <CardTitle>{t('admin.player_inventory.delivery_queue')}</CardTitle>
                                        {totalDeliveries > 0 && (
                                            <Badge variant="secondary">
                                                {totalDeliveries}
                                            </Badge>
                                        )}
                                    </div>
                                    <ChevronDown
                                        className={`text-muted-foreground size-4 transition-transform ${deliveryOpen ? 'rotate-180' : ''}`}
                                    />
                                </div>
                                <CardDescription>
                                    {t('admin.player_inventory.delivery_desc')}
                                </CardDescription>
                            </CardHeader>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                            <CardContent className="overflow-x-auto">
                                {totalDeliveries > 0 ? (
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead className="w-[30px]" />
                                                <TableHead>{t('admin.player_inventory.action')}</TableHead>
                                                <TableHead>{t('admin.player_inventory.item')}</TableHead>
                                                <TableHead className="text-center">{t('admin.player_inventory.qty')}</TableHead>
                                                <TableHead>{t('common.status')}</TableHead>
                                                <TableHead>{t('admin.player_inventory.time')}</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {deliveries.pending.map((entry) => (
                                                <TableRow key={entry.id}>
                                                    <TableCell>
                                                        <Circle className="size-2 fill-yellow-500 text-yellow-500" />
                                                    </TableCell>
                                                    <TableCell>
                                                        <span className="text-sm font-medium capitalize">
                                                            {entry.action}
                                                        </span>
                                                    </TableCell>
                                                    <TableCell>
                                                        <span className="text-muted-foreground text-sm">
                                                            {entry.item_type}
                                                        </span>
                                                    </TableCell>
                                                    <TableCell className="text-center">
                                                        <span className="tabular-nums">{entry.count}</span>
                                                    </TableCell>
                                                    <TableCell>
                                                        <Badge variant="secondary" className="text-xs">
                                                            {t('common.pending')}
                                                        </Badge>
                                                    </TableCell>
                                                    <TableCell>
                                                        <span className="text-muted-foreground text-xs">
                                                            {formatRelativeTime(entry.created_at, t)}
                                                        </span>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                            {deliveries.results.map((result) => (
                                                <TableRow key={result.id}>
                                                    <TableCell>
                                                        <Circle
                                                            className={`size-2 ${
                                                                result.status === 'delivered'
                                                                    ? 'fill-green-500 text-green-500'
                                                                    : 'fill-red-500 text-red-500'
                                                            }`}
                                                        />
                                                    </TableCell>
                                                    <TableCell colSpan={3}>
                                                        <span className="text-sm">
                                                            {result.message ?? result.status}
                                                        </span>
                                                    </TableCell>
                                                    <TableCell>
                                                        <Badge
                                                            variant={
                                                                result.status === 'delivered'
                                                                    ? 'secondary'
                                                                    : 'destructive'
                                                            }
                                                            className="text-xs"
                                                        >
                                                            {result.status}
                                                        </Badge>
                                                    </TableCell>
                                                    <TableCell>
                                                        <span className="text-muted-foreground text-xs">
                                                            {formatRelativeTime(result.processed_at, t)}
                                                        </span>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                ) : (
                                    <p className="text-muted-foreground py-4 text-center text-sm">
                                        {t('admin.player_inventory.no_deliveries')}
                                    </p>
                                )}
                            </CardContent>
                        </CollapsibleContent>
                    </Card>
                </Collapsible>
            </div>

            {/* Give Item Dialog */}
            <Dialog
                open={giveOpen}
                onOpenChange={(open) => {
                    if (!open) {
                        setGiveOpen(false);
                        setGiveSelected(null);
                        setGiveSearch('');
                        setGiveCount(1);
                    }
                }}
            >
                <DialogContent className="overflow-hidden sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>{t('admin.player_inventory.give_item_title', { username })}</DialogTitle>
                        <DialogDescription>
                            {t('admin.player_inventory.give_item_desc')}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="give-search">{t('admin.player_inventory.search_items')}</Label>
                            <div className="relative">
                                <Search className="text-muted-foreground absolute left-2.5 top-2.5 size-4" />
                                <Input
                                    id="give-search"
                                    placeholder={t('admin.player_inventory.search_placeholder')}
                                    value={giveSearch}
                                    onChange={(e) => {
                                        setGiveSearch(e.target.value);
                                        setGiveSelected(null);
                                    }}
                                    className="pl-9"
                                />
                            </div>
                        </div>

                        <div className="max-h-[200px] overflow-y-auto rounded-md border">
                            {filteredCatalog.length > 0 ? (
                                filteredCatalog.map((item) => (
                                    <button
                                        key={item.full_type}
                                        type="button"
                                        className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
                                            giveSelected?.full_type === item.full_type
                                                ? 'bg-accent'
                                                : ''
                                        }`}
                                        onClick={() => setGiveSelected(item)}
                                    >
                                        <ItemIcon src={item.icon} name={item.name} size={24} />
                                        <div className="min-w-0 flex-1 overflow-hidden">
                                            <span className="truncate font-medium">{item.name}</span>
                                            <p className="text-muted-foreground truncate text-xs">
                                                {item.full_type}
                                            </p>
                                        </div>
                                    </button>
                                ))
                            ) : (
                                <p className="text-muted-foreground py-4 text-center text-sm">
                                    {t('admin.player_inventory.no_items_found')}
                                </p>
                            )}
                        </div>

                        {giveSelected && (
                            <div className="flex items-center gap-3 rounded-md bg-muted p-3">
                                <ItemIcon
                                    src={giveSelected.icon}
                                    name={giveSelected.name}
                                    size={32}
                                />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium">{giveSelected.name}</p>
                                    <p className="text-muted-foreground truncate text-xs">
                                        {giveSelected.full_type}
                                    </p>
                                </div>
                            </div>
                        )}

                        <div className="space-y-2">
                            <Label htmlFor="give-count">{t('common.count')}</Label>
                            <Input
                                id="give-count"
                                type="number"
                                min={1}
                                max={100}
                                value={giveCount}
                                onChange={(e) =>
                                    setGiveCount(
                                        Math.max(1, Math.min(100, parseInt(e.target.value) || 1)),
                                    )
                                }
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setGiveOpen(false)}>
                            {t('common.cancel')}
                        </Button>
                        <Button disabled={!giveSelected || loading} onClick={handleGive}>
                            {t('admin.player_inventory.give_item')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Remove Item Dialog */}
            <Dialog
                open={removeTarget !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setRemoveTarget(null);
                        setRemoveCount(1);
                    }
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('admin.player_inventory.remove_item')}</DialogTitle>
                        <DialogDescription>
                            {t('admin.player_inventory.remove_item_desc', { username })}
                        </DialogDescription>
                    </DialogHeader>
                    {removeTarget && (
                        <div className="space-y-4">
                            <div className="flex items-center gap-3 rounded-md bg-muted p-3">
                                <ItemIcon
                                    src={removeTarget.icon}
                                    name={removeTarget.name}
                                    size={32}
                                />
                                <div className="flex-1">
                                    <p className="text-sm font-medium">{removeTarget.name}</p>
                                    <p className="text-muted-foreground text-xs">
                                        {removeTarget.full_type}
                                    </p>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="remove-count">
                                    {t('admin.player_inventory.count_max', { max: String(removeTarget.totalCount) })}
                                </Label>
                                <Input
                                    id="remove-count"
                                    type="number"
                                    min={1}
                                    max={removeTarget.totalCount}
                                    value={removeCount}
                                    onChange={(e) =>
                                        setRemoveCount(
                                            Math.max(
                                                1,
                                                Math.min(
                                                    removeTarget.totalCount,
                                                    parseInt(e.target.value) || 1,
                                                ),
                                            ),
                                        )
                                    }
                                />
                            </div>
                        </div>
                    )}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setRemoveTarget(null)}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            variant="destructive"
                            disabled={loading}
                            onClick={handleRemove}
                        >
                            {t('admin.player_inventory.remove_item')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </AppLayout>
    );
}
