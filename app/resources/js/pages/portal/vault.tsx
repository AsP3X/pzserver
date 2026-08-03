import { Head, router, usePoll } from '@inertiajs/react';
import { Vault as VaultIcon, X } from 'lucide-react';
import { useState } from 'react';
import { ConditionBar } from '@/components/inventory/condition-bar';
import { ItemIcon } from '@/components/inventory/item-icon';
import { VaultCapacityMeter } from '@/components/inventory/vault-capacity-meter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTranslation } from '@/hooks/use-translation';
import AppLayout from '@/layouts/app-layout';
import { fetchAction } from '@/lib/fetch-action';
import type { BreadcrumbItem } from '@/types';
import type { VaultCapacity, VaultItemRow, VaultTransactionRow } from '@/types/server';

type Props = {
    username: string | null;
    hasPzAccount: boolean;
    items: VaultItemRow[];
    capacity: VaultCapacity;
    fees: { flat: number; per_item: number };
    balance: number;
    availableBalance: number;
    transactions: VaultTransactionRow[];
};

const REFRESHED = ['items', 'capacity', 'balance', 'availableBalance', 'transactions'];

export default function PortalVault({ items, capacity, fees, availableBalance, hasPzAccount, transactions }: Props) {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    usePoll(5000, { only: REFRESHED });

    const breadcrumbs: BreadcrumbItem[] = [
        { title: t('portal.title'), href: '/portal' },
        { title: t('vault.title'), href: '/portal/vault' },
    ];

    async function post(url: string, data: Record<string, unknown>) {
        setBusy(true);
        setError(null);
        const result = await fetchAction(url, { data });
        if (!result) {
            setError(t('vault.action_failed'));
        }
        setBusy(false);
        router.reload({ only: REFRESHED });
    }

    return (
        <AppLayout breadcrumbs={breadcrumbs}>
            <Head title={t('vault.title')} />

            <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">{t('vault.title')}</h1>
                    <p className="text-muted-foreground text-sm">{t('vault.description')}</p>
                </div>

                {error && (
                    <div className="flex items-center justify-between rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                        <span>{error}</span>
                        <button onClick={() => setError(null)}>
                            <X className="size-4" />
                        </button>
                    </div>
                )}

                {!hasPzAccount ? (
                    <Card>
                        <CardContent className="py-12 text-center">
                            <p className="font-medium">{t('portal.inventory.no_account')}</p>
                            <p className="text-muted-foreground text-sm">{t('portal.inventory.no_account_desc')}</p>
                        </CardContent>
                    </Card>
                ) : (
                    <>
                        <VaultCapacityMeter
                            capacity={capacity}
                            upgrading={busy}
                            onUpgrade={() => post('/portal/vault/upgrade', {})}
                        />

                        <Card>
                            <CardHeader>
                                <CardTitle>{t('vault.stored_items')}</CardTitle>
                                <CardDescription>
                                    {t('vault.fee_note', {
                                        flat: String(fees.flat),
                                        per_item: String(fees.per_item),
                                        balance: String(availableBalance),
                                    })}
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="overflow-x-auto">
                                {items.length > 0 ? (
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead className="w-[50px]" />
                                                <TableHead>{t('inventory.item')}</TableHead>
                                                <TableHead>{t('common.category')}</TableHead>
                                                <TableHead className="text-center">{t('inventory.qty')}</TableHead>
                                                <TableHead className="w-[120px]">{t('inventory.condition')}</TableHead>
                                                <TableHead>{t('common.actions')}</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {items.map((item) => (
                                                <TableRow key={item.id}>
                                                    <TableCell>
                                                        <ItemIcon src={item.icon} name={item.name} size={32} />
                                                    </TableCell>
                                                    <TableCell>
                                                        <div className="flex min-w-0 flex-col">
                                                            <span className="text-sm font-medium">{item.name}</span>
                                                            <span className="text-muted-foreground text-xs">{item.full_type}</span>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell>
                                                        <Badge variant="outline" className="text-xs">{item.category}</Badge>
                                                    </TableCell>
                                                    <TableCell className="text-center tabular-nums">{item.count}</TableCell>
                                                    <TableCell>
                                                        <ConditionBar condition={item.condition} />
                                                    </TableCell>
                                                    <TableCell>
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            disabled={busy}
                                                            onClick={() =>
                                                                post('/portal/vault/withdraw', {
                                                                    full_type: item.full_type,
                                                                    condition: item.condition,
                                                                    count: 1,
                                                                })
                                                            }
                                                        >
                                                            {t('vault.withdraw')}
                                                        </Button>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                ) : (
                                    <div className="flex flex-col items-center gap-3 py-12 text-center">
                                        <VaultIcon className="text-muted-foreground size-8" />
                                        <div>
                                            <p className="font-medium">{t('vault.empty')}</p>
                                            <p className="text-muted-foreground text-sm">{t('vault.empty_desc')}</p>
                                        </div>
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>{t('vault.history')}</CardTitle>
                            </CardHeader>
                            <CardContent className="overflow-x-auto">
                                {transactions.length > 0 ? (
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>{t('vault.direction')}</TableHead>
                                                <TableHead>{t('inventory.item')}</TableHead>
                                                <TableHead className="text-center">{t('inventory.qty')}</TableHead>
                                                <TableHead>{t('vault.fee')}</TableHead>
                                                <TableHead>{t('common.status')}</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {transactions.map((tx) => (
                                                <TableRow key={tx.id}>
                                                    <TableCell className="text-sm">
                                                        {tx.direction === 'deposit' ? t('vault.deposit') : t('vault.withdraw')}
                                                    </TableCell>
                                                    <TableCell className="text-muted-foreground text-sm">{tx.full_type}</TableCell>
                                                    <TableCell className="text-center tabular-nums">
                                                        {tx.actual_count} / {tx.requested_count}
                                                    </TableCell>
                                                    <TableCell className="tabular-nums">{tx.fee_charged}</TableCell>
                                                    <TableCell>
                                                        <Badge
                                                            variant={tx.status === 'failed' ? 'destructive' : 'secondary'}
                                                            className="text-xs"
                                                        >
                                                            {tx.status}
                                                        </Badge>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                ) : (
                                    <p className="text-muted-foreground py-4 text-center text-sm">
                                        {t('vault.no_history')}
                                    </p>
                                )}
                            </CardContent>
                        </Card>
                    </>
                )}
            </div>
        </AppLayout>
    );
}
