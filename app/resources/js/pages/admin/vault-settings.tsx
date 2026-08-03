import { Head, useForm } from '@inertiajs/react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/hooks/use-translation';
import AppLayout from '@/layouts/app-layout';
import type { BreadcrumbItem } from '@/types';

type Settings = {
    default_slots: number;
    max_slots: number;
    slot_upgrade_increment: number;
    slot_upgrade_cost: number;
    withdraw_fee_flat: number;
    withdraw_fee_per_item: number;
    enabled: boolean;
};

type Props = { settings: Settings };

const NUMBER_FIELDS = [
    'default_slots',
    'max_slots',
    'slot_upgrade_increment',
    'slot_upgrade_cost',
    'withdraw_fee_flat',
    'withdraw_fee_per_item',
] as const;

export default function VaultSettings({ settings }: Props) {
    const { t } = useTranslation();
    const { data, setData, patch, processing } = useForm<Settings>({
        default_slots: settings.default_slots,
        max_slots: settings.max_slots,
        slot_upgrade_increment: settings.slot_upgrade_increment,
        slot_upgrade_cost: settings.slot_upgrade_cost,
        withdraw_fee_flat: settings.withdraw_fee_flat,
        withdraw_fee_per_item: settings.withdraw_fee_per_item,
        enabled: settings.enabled,
    });

    const breadcrumbs: BreadcrumbItem[] = [
        { title: t('nav.dashboard'), href: '/dashboard' },
        { title: t('admin.vault.title'), href: '/admin/vault' },
    ];

    return (
        <AppLayout breadcrumbs={breadcrumbs}>
            <Head title={t('admin.vault.title')} />

            <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">{t('admin.vault.title')}</h1>
                    <p className="text-muted-foreground text-sm">{t('admin.vault.description')}</p>
                </div>

                <Card>
                    <CardHeader>
                        <CardTitle>{t('admin.vault.settings')}</CardTitle>
                        <CardDescription>{t('admin.vault.settings_desc')}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="flex items-center justify-between">
                            <Label htmlFor="vault-enabled">{t('admin.vault.enabled')}</Label>
                            <Switch
                                id="vault-enabled"
                                checked={data.enabled}
                                onCheckedChange={(checked) => setData('enabled', checked)}
                            />
                        </div>

                        <div className="grid gap-4 sm:grid-cols-2">
                            {NUMBER_FIELDS.map((field) => (
                                <div key={field} className="space-y-2">
                                    <Label htmlFor={`vault-${field}`}>{t(`admin.vault.${field}`)}</Label>
                                    <Input
                                        id={`vault-${field}`}
                                        type="number"
                                        min={0}
                                        step="0.01"
                                        value={String(data[field])}
                                        onChange={(e) => setData(field, Number(e.target.value))}
                                    />
                                </div>
                            ))}
                        </div>

                        <Button disabled={processing} onClick={() => patch('/admin/vault', { preserveScroll: true })}>
                            {processing ? t('common.saving') : t('common.save')}
                        </Button>
                    </CardContent>
                </Card>
            </div>
        </AppLayout>
    );
}
