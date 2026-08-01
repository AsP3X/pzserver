import { SortIcon } from '@/components/sort-icon';

type SortableHeaderProps<K extends string> = {
    column: K;
    label: string;
    sortKey: K;
    sortDir: 'asc' | 'desc';
    onSort: (key: K) => void;
    icon?: React.ReactNode;
};

export function SortableHeader<K extends string>({
    column,
    label,
    sortKey,
    sortDir,
    onSort,
    icon,
}: SortableHeaderProps<K>) {
    return (
        <button
            type="button"
            className="flex items-center hover:text-foreground"
            onClick={() => onSort(column)}
        >
            {icon}
            {label}
            <SortIcon column={column} sortKey={sortKey} sortDir={sortDir} />
        </button>
    );
}
