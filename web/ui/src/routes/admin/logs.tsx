import { useQuery } from '@tanstack/react-query'
import { Pause, Play, RefreshCw, Search, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { FormError } from '@/components/ui/field'
import { Panel } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import { fuzzyMatch, fuzzySlices } from '@/lib/fuzzy'
import { adminLogsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'

const TAILS = [100, 200, 500, 1000, 2000] as const

/**
 * The game container's stdout/stderr, filling the admin content column.
 *
 * Search is a subsequence match over the current tail, not a server-side
 * grep: the stream is already in memory and a keystroke should answer
 * immediately.
 */
export function AdminLogsPage() {
  const { t } = useTranslation()
  const searchId = useId()
  const output = useRef<HTMLPreElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const [tail, setTail] = useState<(typeof TAILS)[number]>(500)
  const [live, setLive] = useState(true)
  const [query, setQuery] = useState('')

  const { data, isPending, isError, isFetching, refetch } = useQuery({
    ...adminLogsQuery(tail),
    refetchInterval: live ? 5_000 : false,
  })

  const lines = data?.lines ?? []
  const searching = query.trim().length > 0

  const visible = useMemo(() => {
    const source = data?.lines ?? []

    if (!searching) {
      return source.map((text, index) => ({
        index,
        text,
        indices: [] as number[],
        score: 0,
      }))
    }

    return source
      .map((text, index) => {
        const hit = fuzzyMatch(query, text)
        return hit ? { index, text, indices: hit.indices, score: hit.score } : null
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((left, right) => right.score - left.score || left.index - right.index)
  }, [data, query, searching])

  useEffect(() => {
    const element = output.current
    if (!element || searching || visible.length === 0) {
      return
    }
    element.scrollTop = element.scrollHeight
  }, [data, searching, visible.length])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '/' && event.target instanceof HTMLElement) {
        const tag = event.target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          return
        }
        event.preventDefault()
        searchRef.current?.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.group.server')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('admin.logs_title')}</h1>
        </div>

        <p className="max-w-xl text-xs leading-relaxed text-dust lg:text-right">
          {t('admin.logs_description')}
        </p>
      </header>

      <Panel bracketed className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-col gap-3 border-b border-fence px-3 py-3 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-dust"
            />
            <input
              ref={searchRef}
              id={searchId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  event.preventDefault()
                  setQuery('')
                }
              }}
              placeholder={t('admin.logs_search_placeholder')}
              autoComplete="off"
              spellCheck={false}
              className="h-10 w-full border border-fence-bright bg-void pr-10 pl-10 font-mono text-sm text-bone placeholder:text-dust focus:border-hazard"
              aria-controls="admin-log-output"
              aria-describedby={`${searchId}-hint`}
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery('')
                  searchRef.current?.focus()
                }}
                className="absolute top-1/2 right-2 -translate-y-1/2 p-1 text-dust hover:text-bone"
              >
                <X aria-hidden="true" className="size-3.5" />
                <span className="sr-only">{t('admin.logs_search_clear')}</span>
              </button>
            ) : null}
            <p id={`${searchId}-hint`} className="sr-only">
              {t('admin.logs_search_hint')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <p role="status" className="font-mono text-[0.6875rem] tracking-wide text-dust">
              {searching
                ? t('admin.logs_matches', { count: visible.length, total: lines.length })
                : t('admin.logs_showing', { count: lines.length })}
            </p>
            <label className="flex items-center gap-2 font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
              {t('admin.logs_tail')}
              <select
                value={tail}
                onChange={(event) =>
                  setTail(Number(event.target.value) as (typeof TAILS)[number])
                }
                className="h-10 border border-fence-bright bg-void px-2 font-mono text-xs text-bone"
              >
                {TAILS.map((count) => (
                  <option key={count} value={count}>
                    {t('admin.logs_lines', { count })}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setLive((current) => !current)}
              aria-pressed={live}
            >
              {live ? (
                <Pause aria-hidden="true" className="size-3.5" />
              ) : (
                <Play aria-hidden="true" className="size-3.5" />
              )}
              {live ? t('admin.logs_pause') : t('admin.logs_resume')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              <RefreshCw
                aria-hidden="true"
                className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`}
              />
              {t('admin.logs_refresh')}
            </Button>
          </div>
        </div>

        {isPending ? (
          <div className="flex-1 p-4">
            <Skeleton className="h-full min-h-64 w-full" />
          </div>
        ) : isError ? (
          <div className="p-5">
            <FormError>{t('common.error')}</FormError>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => void refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <pre
            ref={output}
            id="admin-log-output"
            role="log"
            aria-live={live && !searching ? 'polite' : 'off'}
            aria-relevant="additions"
            aria-label={t('admin.logs_title')}
            className="min-h-0 flex-1 overflow-auto bg-void p-4 font-mono text-xs leading-relaxed text-smoke"
          >
            {visible.length === 0 ? (
              <span className="text-dust">
                {lines.length === 0 ? t('admin.logs_empty') : t('admin.logs_no_matches')}
              </span>
            ) : (
              visible.map((row) => (
                <span key={`${row.index}-${row.text.slice(0, 24)}`} className="block hover:bg-ash-raised">
                  <span className="mr-3 inline-block w-10 select-none text-right text-dust tabular-nums">
                    {row.index + 1}
                  </span>
                  {searching
                    ? fuzzySlices(row.text, row.indices).map((slice, offset) => (
                        <span
                          key={offset}
                          className={cn(
                            slice.match &&
                              'bg-hazard-soft font-semibold text-hazard underline decoration-hazard/60 underline-offset-2',
                          )}
                        >
                          {slice.text}
                        </span>
                      ))
                    : row.text}
                </span>
              ))
            )}
          </pre>
        )}
      </Panel>
    </section>
  )
}
