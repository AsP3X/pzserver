type Props = {
    /** 0..1 wear fraction, or null/undefined for items that never wear out. */
    condition: number | null | undefined;
};

export function ConditionBar({ condition }: Props) {
    /** Food, ammo and the like never wear out — say so rather than leave a gap. */
    if (condition === null || condition === undefined || Number.isNaN(condition)) {
        return <span className="text-muted-foreground text-xs">&mdash;</span>;
    }

    const percent = Math.max(0, Math.min(100, Math.round(condition * 100)));
    let colorClass = 'bg-green-500';
    if (percent < 30) colorClass = 'bg-red-500';
    else if (percent < 60) colorClass = 'bg-yellow-500';

    return (
        <div className="flex items-center gap-2">
            <div className="h-1.5 w-full rounded-full bg-muted">
                <div className={`h-1.5 rounded-full ${colorClass}`} style={{ width: `${percent}%` }} />
            </div>
            <span className="text-muted-foreground text-xs tabular-nums">{percent}%</span>
        </div>
    );
}
