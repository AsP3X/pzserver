import { Head, usePoll } from '@inertiajs/react';
import { Backpack, RefreshCw, TriangleAlert, UserX } from 'lucide-react';
import { useMemo } from 'react';
import { InventoryStats } from '@/components/inventory/inventory-stats';
import { InventoryTable } from '@/components/inventory/inventory-table';
import { Card, CardContent } from '@/components/ui/card';
import { useTranslation } from '@/hooks/use-translation';
import AppLayout from '@/layouts/app-layout';
import { formatRelativeTime } from '@/lib/dates';
import { stackItems } from '@/lib/inventory';
import type { BreadcrumbItem } from '@/types';
import type { InventorySnapshot } from '@/types/server';

type Props = {
    username: string | null;
    inventory: InventorySnapshot | null;
    isOnline: boolean;
    hasPzAccount: boolean;
};

function EmptyState({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
    return (
        <Card>
            <CardContent className="py-12">
                <div className="flex flex-col items-center gap-3 text-center">
                    {icon}
                    <div>
                        <p className="font-medium">{title}</p>
                        <p className="text-muted-foreground text-sm">{description}</p>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

export default function PortalInventory({ username, inventory, isOnline, hasPzAccount }: Props) {
    const { t } = useTranslation();

    usePoll(5000, { only: ['inventory', 'isOnline'] });

    const breadcrumbs: BreadcrumbItem[] = [
        { title: t('portal.title'), href: '/portal' },
        { title: t('portal.inventory.breadcrumb'), href: '/portal/inventory' },
    ];

    const stackedItems = useMemo(() => stackItems(inventory?.items ?? []), [inventory?.items]);

    return (
        <AppLayout breadcrumbs={breadcrumbs}>
            <Head title={t('portal.inventory.title')} />

            <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">{t('portal.inventory.title')}</h1>
                    <p className="text-muted-foreground text-sm">
                        {username
                            ? t('portal.inventory.description', { username })
                            : t('portal.inventory.description_generic')}
                    </p>
                </div>

                {!hasPzAccount ? (
                    <EmptyState
                        icon={<UserX className="text-muted-foreground size-8" />}
                        title={t('portal.inventory.no_account')}
                        description={t('portal.inventory.no_account_desc')}
                    />
                ) : !inventory ? (
                    <EmptyState
                        icon={<Backpack className="text-muted-foreground size-8" />}
                        title={t('portal.inventory.no_snapshot')}
                        description={t('portal.inventory.no_snapshot_desc')}
                    />
                ) : (
                    <>
                        {isOnline ? (
                            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
                                <RefreshCw className="size-3 animate-spin" />
                                {t('portal.inventory.live', {
                                    time: formatRelativeTime(inventory.timestamp, t),
                                })}
                            </p>
                        ) : (
                            <div className="flex items-start gap-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10 px-4 py-3 text-sm">
                                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-yellow-600 dark:text-yellow-500" />
                                <div>
                                    <p className="font-medium">{t('portal.inventory.stale_title')}</p>
                                    <p className="text-muted-foreground">
                                        {t('portal.inventory.stale_desc', {
                                            time: formatRelativeTime(inventory.timestamp, t),
                                        })}
                                    </p>
                                </div>
                            </div>
                        )}

                        <InventoryStats inventory={inventory} stackedItems={stackedItems} />

                        <InventoryTable items={stackedItems} />
                    </>
                )}
            </div>
        </AppLayout>
    );
}
