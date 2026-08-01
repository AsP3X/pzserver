import { useState } from 'react';

type SortDir = 'asc' | 'desc';

export function useTableSort<K extends string>(defaultKey: K, defaultDir: SortDir = 'asc') {
    const [sortKey, setSortKey] = useState<K>(defaultKey);
    const [sortDir, setSortDir] = useState<SortDir>(defaultDir);

    function toggleSort(key: K) {
        if (sortKey === key) {
            setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortKey(key);
            setSortDir('asc');
        }
    }

    return { sortKey, sortDir, toggleSort } as const;
}
