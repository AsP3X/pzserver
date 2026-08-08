import { Head, router, usePoll } from '@inertiajs/react';
import { Backpack, UserX } from 'lucide-react';
import { useMemo, useState } from 'react';
import { InventoryStats } from '@/components/inventory/inventory-stats';
import { InventoryTable } from '@/components/inventory/inventory-table';
import { LiveSnapshotNotice } from '@/components/live-snapshot-notice';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useTranslation } from '@/hooks/use-translation';
import AppLayout from '@/layouts/app-layout';
import { formatRelativeTime } from '@/lib/dates';
import { fetchAction } from '@/lib/fetch-action';
import { groupItemsByContainer, stackItems } from '@/lib/inventory';
import type { BreadcrumbItem } from '@/types';
import type { InventorySnapshot, StackedItem } from '@/types/server';

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
    const [depositing, setDepositing] = useState<string | null>(null);

    usePoll(5000, { only: ['inventory', 'isOnline'] });

    async function handleDeposit(item: StackedItem) {
        setDepositing(item.full_type);
        await fetchAction('/portal/vault/deposit', {
            data: {
                full_type: item.full_type,
                name: item.name,
                category: item.category,
                count: item.totalCount,
            },
        });
        setDepositing(null);
        router.reload({ only: ['inventory'] });
    }

    const breadcrumbs: BreadcrumbItem[] = [
        { title: t('portal.title'), href: '/portal' },
        { title: t('portal.inventory.breadcrumb'), href: '/portal/inventory' },
    ];

    const stackedItems = useMemo(() => stackItems(inventory?.items ?? []), [inventory?.items]);
    const containerGroups = useMemo(
        () => groupItemsByContainer(inventory?.items ?? []),
        [inventory?.items],
    );

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
                        <LiveSnapshotNotice
                            isLive={isOnline}
                            liveLabel={t('portal.inventory.live', {
                                time: formatRelativeTime(inventory.timestamp, t),
                            })}
                            staleTitle={t('portal.inventory.stale_title')}
                            staleDescription={t('portal.inventory.stale_desc', {
                                time: formatRelativeTime(inventory.timestamp, t),
                            })}
                        />

                        <InventoryStats inventory={inventory} stackedItems={stackedItems} />

                        <InventoryTable
                            items={stackedItems}
                            groups={containerGroups}
                            rowActions={(item) => (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={depositing !== null}
                                    onClick={() => handleDeposit(item)}
                                >
                                    {t('vault.deposit')}
                                </Button>
                            )}
                        />
                    </>
                )}
            </div>
        </AppLayout>
    );
}
