type Props = {
    condition: number | null;
};

export function ConditionBar({ condition }: Props) {
    if (condition === null) return null;

    const percent = Math.round(condition * 100);
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
