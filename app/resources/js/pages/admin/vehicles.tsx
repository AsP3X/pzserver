import { Head } from '@inertiajs/react';
import { Car, Fuel, KeyRound, MapPin, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SortableHeader } from '@/components/sortable-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTableSort } from '@/hooks/use-table-sort';
import { useTranslation } from '@/hooks/use-translation';
import AppLayout from '@/layouts/app-layout';
import { formatRelativeTime } from '@/lib/dates';
import type { BreadcrumbItem } from '@/types';

type Holder = {
    username: string;
    online: boolean;
    last_seen_at: string | null;
};

type Vehicle = {
    id: number;
    model: string;
    x: number | null;
    y: number | null;
    fuel_percent: number | null;
    engine_quality: number | null;
    engine_running: boolean;
    key_spawned: boolean;
    key_id: number | null;
    holders: Holder[];
};

type Props = {
    vehicles: Vehicle[];
    exported_at: string | null;
};

type SortKey = 'model' | 'fuel_percent' | 'engine_quality' | 'id';

/** Red below a quarter tank, amber below half. */
function fuelColour(percent: number): string {
    if (percent < 25) return 'text-red-500';
    if (percent < 50) return 'text-yellow-600 dark:text-yellow-500';

    return 'text-muted-foreground';
}

export default function AdminVehicles({ vehicles, exported_at }: Props) {
    const { t } = useTranslation();
    const [filter, setFilter] = useState('');
    const { sortKey, sortDir, toggleSort } = useTableSort<SortKey>('model', 'asc');

    const rows = useMemo(() => {
        const query = filter.toLowerCase();
        const result = vehicles.filter(
            (vehicle) =>
                vehicle.model.toLowerCase().includes(query) ||
                String(vehicle.id).includes(query) ||
                vehicle.holders.some((holder) => holder.username.toLowerCase().includes(query)),
        );

        result.sort((a, b) => {
            let cmp = 0;
            if (sortKey === 'model') cmp = a.model.localeCompare(b.model);
            else if (sortKey === 'id') cmp = a.id - b.id;
            else cmp = (a[sortKey] ?? -1) - (b[sortKey] ?? -1);
            return sortDir === 'desc' ? -cmp : cmp;
        });

        return result;
    }, [vehicles, filter, sortKey, sortDir]);

    const breadcrumbs: BreadcrumbItem[] = [
        { title: t('nav.dashboard'), href: '/dashboard' },
        { title: t('admin.vehicles.breadcrumb'), href: '/admin/vehicles' },
    ];

    return (
        <AppLayout breadcrumbs={breadcrumbs}>
            <Head title={t('admin.vehicles.title')} />

            <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">{t('admin.vehicles.title')}</h1>
                    <p className="text-muted-foreground text-sm">
                        {exported_at
                            ? t('admin.vehicles.description', { time: formatRelativeTime(exported_at, t) })
                            : t('admin.vehicles.description_generic')}
                    </p>
                </div>

                <Card>
                    <CardHeader>
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <CardTitle>{t('admin.vehicles.fleet')}</CardTitle>
                                <CardDescription>
                                    {t('admin.vehicles.count', {
                                        filtered: String(rows.length),
                                        total: String(vehicles.length),
                                    })}
                                </CardDescription>
                            </div>
                            <div className="relative">
                                <Search className="text-muted-foreground absolute left-2.5 top-2.5 size-4" />
                                <Input
                                    placeholder={t('admin.vehicles.filter')}
                                    value={filter}
                                    onChange={(e) => setFilter(e.target.value)}
                                    className="pl-9 sm:w-[200px]"
                                />
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="overflow-x-auto">
                        {vehicles.length === 0 ? (
                            <div className="flex flex-col items-center gap-3 py-12 text-center">
                                <Car className="text-muted-foreground size-8" />
                                <div>
                                    <p className="font-medium">{t('admin.vehicles.empty')}</p>
                                    <p className="text-muted-foreground text-sm">
                                        {t('admin.vehicles.empty_desc')}
                                    </p>
                                </div>
                            </div>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>
                                            <SortableHeader column="model" label={t('admin.vehicles.model')} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                                        </TableHead>
                                        <TableHead>
                                            <SortableHeader column="id" label={t('admin.vehicles.vehicle_id')} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                                        </TableHead>
                                        <TableHead>
                                            <SortableHeader column="fuel_percent" label={t('admin.vehicles.fuel')} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                                        </TableHead>
                                        <TableHead>
                                            <SortableHeader column="engine_quality" label={t('admin.vehicles.engine')} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                                        </TableHead>
                                        <TableHead>{t('admin.vehicles.owner')}</TableHead>
                                        <TableHead>{t('admin.vehicles.location')}</TableHead>
                                        <TableHead>{t('common.status')}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {rows.map((vehicle) => (
                                        <TableRow key={vehicle.id}>
                                            <TableCell className="font-medium">{vehicle.model}</TableCell>
                                            <TableCell className="text-muted-foreground tabular-nums">
                                                {vehicle.id}
                                            </TableCell>
                                            <TableCell>
                                                {vehicle.fuel_percent === null ? (
                                                    <span className="text-muted-foreground text-xs">—</span>
                                                ) : (
                                                    <span
                                                        className={`flex items-center gap-1.5 text-sm tabular-nums ${fuelColour(vehicle.fuel_percent)}`}
                                                    >
                                                        <Fuel className="size-3.5" />
                                                        {vehicle.fuel_percent}%
                                                    </span>
                                                )}
                                            </TableCell>
                                            <TableCell className="tabular-nums">
                                                {vehicle.engine_quality === null ? (
                                                    <span className="text-muted-foreground text-xs">—</span>
                                                ) : (
                                                    `${vehicle.engine_quality}%`
                                                )}
                                            </TableCell>
                                            <TableCell>
                                                {vehicle.holders.length === 0 ? (
                                                    <span className="text-muted-foreground text-xs">
                                                        {vehicle.key_spawned
                                                            ? t('admin.vehicles.key_unaccounted')
                                                            : t('admin.vehicles.no_key')}
                                                    </span>
                                                ) : (
                                                    <div className="flex flex-wrap gap-1">
                                                        {vehicle.holders.map((holder) => (
                                                            <Badge
                                                                key={holder.username}
                                                                variant={holder.online ? 'secondary' : 'outline'}
                                                                className="gap-1 text-xs"
                                                                title={
                                                                    holder.online
                                                                        ? t('admin.vehicles.holding_now')
                                                                        : holder.last_seen_at
                                                                          ? t('admin.vehicles.last_seen', {
                                                                                time: formatRelativeTime(
                                                                                    holder.last_seen_at,
                                                                                    t,
                                                                                ),
                                                                            })
                                                                          : ''
                                                                }
                                                            >
                                                                <KeyRound className="size-3" />
                                                                {holder.username}
                                                            </Badge>
                                                        ))}
                                                    </div>
                                                )}
                                            </TableCell>
                                            <TableCell>
                                                {vehicle.x === null || vehicle.y === null ? (
                                                    <span className="text-muted-foreground text-xs">—</span>
                                                ) : (
                                                    <span className="text-muted-foreground flex items-center gap-1 text-xs tabular-nums">
                                                        <MapPin className="size-3" />
                                                        {vehicle.x}, {vehicle.y}
                                                    </span>
                                                )}
                                            </TableCell>
                                            <TableCell>
                                                <div className="flex flex-wrap items-center gap-1">
                                                    {vehicle.engine_running && (
                                                        <Badge variant="secondary" className="text-xs">
                                                            {t('admin.vehicles.running')}
                                                        </Badge>
                                                    )}
                                                    {vehicle.key_spawned && (
                                                        <Badge variant="outline" className="gap-1 text-xs">
                                                            <KeyRound className="size-3" />
                                                            {t('admin.vehicles.keyed')}
                                                        </Badge>
                                                    )}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </CardContent>
                </Card>
            </div>
        </AppLayout>
    );
}
