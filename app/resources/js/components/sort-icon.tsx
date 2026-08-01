import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

export function SortIcon<K extends string>({ column, sortKey, sortDir }: { column: K; sortKey: K; sortDir: 'asc' | 'desc' }) {
    if (sortKey !== column) {
        return <ArrowUpDown className="ml-1 inline size-3 text-muted-foreground/50" />;
    }
    return sortDir === 'asc'
        ? <ArrowUp className="ml-1 inline size-3" />
        : <ArrowDown className="ml-1 inline size-3" />;
}
