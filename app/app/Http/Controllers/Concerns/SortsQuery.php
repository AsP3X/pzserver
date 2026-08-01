<?php

namespace App\Http\Controllers\Concerns;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\Request;

trait SortsQuery
{
    /**
     * Apply validated sorting to a query builder.
     *
     * @param  array<string>  $allowedColumns
     * @return array{sort: string, direction: string}
     */
    protected function applySort(
        Builder $query,
        Request $request,
        array $allowedColumns,
        string $defaultSort = 'created_at',
        string $defaultDirection = 'desc',
    ): array {
        $sort = $request->query('sort', $defaultSort);
        $direction = $request->query('direction', $defaultDirection);

        if (! in_array($sort, $allowedColumns, true)) {
            $sort = $defaultSort;
        }

        if (! in_array($direction, ['asc', 'desc'], true)) {
            $direction = $defaultDirection;
        }

        $query->orderBy($sort, $direction);

        return ['sort' => $sort, 'direction' => $direction];
    }
}
