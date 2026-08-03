import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/use-translation';
import type { VaultCapacity } from '@/types/server';

type Props = {
    capacity: VaultCapacity;
    onUpgrade: () => void;
    upgrading: boolean;
};

export function VaultCapacityMeter({ capacity, onUpgrade, upgrading }: Props) {
    const { t } = useTranslation();
    const percent = capacity.total > 0 ? Math.min(100, (capacity.used / capacity.total) * 100) : 0;
    const atMax = capacity.total >= capacity.max;

    let barClass = 'bg-green-500';
    if (percent >= 90) barClass = 'bg-red-500';
    else if (percent >= 70) barClass = 'bg-yellow-500';

    return (
        <div className="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                    {t('vault.capacity', { used: String(capacity.used), total: String(capacity.total) })}
                </p>
                <div className="mt-2 h-2 w-full rounded-full bg-muted">
                    <div className={`h-2 rounded-full ${barClass}`} style={{ width: `${percent}%` }} />
                </div>
            </div>
            <Button
                variant="outline"
                size="sm"
                disabled={atMax || upgrading}
                onClick={onUpgrade}
                className="sm:ml-4"
            >
                {atMax
                    ? t('vault.at_max')
                    : t('vault.buy_slots', {
                          count: String(capacity.upgrade_increment),
                          cost: String(capacity.upgrade_cost),
                      })}
            </Button>
        </div>
    );
}
