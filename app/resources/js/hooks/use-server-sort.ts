import { router } from '@inertiajs/react';

type SortDir = 'asc' | 'desc';

type UseServerSortOptions = {
    url: string;
    filters: Record<string, string | null | undefined>;
    defaultSort: string;
    defaultDir?: SortDir;
};

export function useServerSort<K extends string>({
    url,
    filters,
    defaultSort,
    defaultDir = 'desc',
}: UseServerSortOptions) {
    const sortKey = ((filters.sort as string) || defaultSort) as K;
    const sortDir = ((filters.direction as string) || defaultDir) as SortDir;

    function toggleSort(key: K) {
        const params: Record<string, string> = {};

        for (const [k, v] of Object.entries(filters)) {
            if (k !== 'sort' && k !== 'direction' && v) {
                params[k] = v;
            }
        }

        params.sort = key;
        params.direction = sortKey === key ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc';

        router.get(url, params, { preserveState: true });
    }

    return { sortKey, sortDir, toggleSort } as const;
}
