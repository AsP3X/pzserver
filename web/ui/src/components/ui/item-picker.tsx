import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import { fuzzyMatchWords, fuzzySlices } from '@/lib/fuzzy'
import { itemsQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { CatalogItem } from '@/lib/api'

/**
 * Rendering every match of a five-thousand-item catalogue costs frames and
 * buys nothing: nobody scrolls past a hundred results.
 */
const MAX_ROWS = 100

/**
 * Search over every item the game server has registered.
 *
 * Its own `<dialog>` rather than a `ConfirmDialog`, because the body is a live
 * filtering list and the confirm footer would have nothing to confirm. Rendered
 * into `document.body` so it is not nested inside the add-listing dialog: a
 * nested `<dialog>` shares the parent's close, and picking a row would dismiss
 * the listing form without keeping the item.
 */
export function ItemPickerDialog({
  open,
  onSelect,
  onClose,
}: {
  open: boolean
  onSelect: (item: CatalogItem) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  // Shared by key with the field that opens this, which needs the catalogue on
  // page load anyway to resolve the selected item's display name. One fetch,
  // cached for the session either way.
  const catalogue = useQuery(itemsQuery)
  const dialog = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const searchId = useId()
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [manual, setManual] = useState('')

  // Memoised so the sort and the ranking below do not re-run on every render;
  // a bare `?? []` is a new array each time.
  const items = useMemo(() => catalogue.data?.items ?? [], [catalogue.data])
  const searching = query.trim() !== ''

  const shown = useMemo(() => {
    if (!searching) {
      return [...items]
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAX_ROWS)
    }

    // The ranked-search shape `admin/config.tsx` uses: score everything, drop
    // the misses, best first.
    return items
      .map((item) => {
        const hit = fuzzyMatchWords(query, `${item.name} ${item.full_type} ${item.category}`)

        return hit ? { item, score: hit.score } : null
      })
      .filter((entry): entry is { item: CatalogItem; score: number } => entry !== null)
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_ROWS)
      .map((entry) => entry.item)
  }, [items, query, searching])

  useEffect(() => {
    const element = dialog.current
    if (!element) {
      return
    }

    if (open && !element.open) {
      element.showModal()
      setQuery('')
      setManual('')
      setHighlight(0)
      search.current?.focus()
    } else if (!open && element.open) {
      element.close()
    }
  }, [open])

  // A new query means the old highlight points at an unrelated row.
  useEffect(() => {
    setHighlight(0)
  }, [query])

  function choose(item: CatalogItem) {
    onSelect(item)
    // Close on the next tick so this click cannot land on the listing
    // dialog's backdrop and dismiss the form we just filled.
    window.setTimeout(onClose, 0)
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((current) => Math.min(current + 1, shown.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const picked = shown[highlight]
      if (picked) {
        choose(picked)
      }
    }
  }

  const node = (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      closedby="closerequest"
      className={cn(
        'm-auto border border-fence-bright bg-ash p-0 text-bone backdrop:bg-void/80',
        // A height, not only a max-height: `flex-1` on the list otherwise
        // collapses to zero and both the browse list and the search hits vanish.
        'h-[min(44rem,calc(100vh-2rem))] w-[min(40rem,calc(100vw-2rem))]',
        'open:flex open:flex-col',
      )}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={(event) => {
        if (event.target !== event.currentTarget) {
          return
        }
        if (open) {
          onClose()
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="shrink-0 border-b border-fence p-5">
        <h2 id={titleId} className="display text-2xl text-bone">
          {t('economy.pick_item')}
        </h2>

        <label htmlFor={searchId} className="sr-only">
          {t('economy.item_search')}
        </label>
        <div className="relative mt-3">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-dust"
          />
          <input
            id={searchId}
            ref={search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={t('economy.item_search_placeholder')}
            className={cn(
              'h-12 w-full border border-fence-bright bg-void pr-3 pl-9 font-mono text-sm text-bone',
              'transition-colors placeholder:text-dust focus:border-hazard',
            )}
          />
        </div>

        {items.length > 0 ? (
          <p className="mt-2 text-xs text-dust">
            {t('economy.item_search_hint', { count: items.length })}
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {catalogue.isPending ? (
          <div className="flex flex-col gap-2 p-5">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : catalogue.isError ? (
          <p className="p-5 text-sm text-blood">{t('auth.unexpected_error')}</p>
        ) : items.length === 0 ? (
          <p className="p-5 text-sm text-dust">{t('economy.item_catalog_empty')}</p>
        ) : shown.length === 0 ? (
          <p className="p-5 text-sm text-dust">{t('economy.item_search_empty')}</p>
        ) : (
          <ul>
            {shown.map((item, index) => (
              <li key={item.full_type}>
                <button
                  type="button"
                  onClick={() => choose(item)}
                  onMouseEnter={() => setHighlight(index)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 border-b border-fence px-5 py-2.5 text-left',
                    index === highlight ? 'bg-ash-raised' : 'hover:bg-ash-raised',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-bone">
                      <Highlighted text={item.name} query={query} />
                    </span>
                    <span className="block truncate font-mono text-xs text-smoke">
                      <Highlighted text={item.full_type} query={query} />
                    </span>
                  </span>
                  <span className="shrink-0 border border-fence px-1.5 py-0.5 font-mono text-[0.625rem] text-dust uppercase">
                    {item.category}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-fence px-5 py-3">
        <label
          htmlFor={`${searchId}-manual`}
          className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase"
        >
          {t('economy.item_manual')}
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id={`${searchId}-manual`}
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && manual.trim() !== '') {
                event.preventDefault()
                choose({ full_type: manual.trim(), name: '', category: '' })
              }
            }}
            placeholder="Base.Axe"
            className={cn(
              'h-9 min-w-0 flex-1 border border-fence-bright bg-void px-3 font-mono text-xs text-bone',
              'transition-colors placeholder:text-dust focus:border-hazard',
            )}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={manual.trim() === ''}
            onClick={() => choose({ full_type: manual.trim(), name: '', category: '' })}
          >
            {t('economy.item_manual_use')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </dialog>
  )

  if (typeof document === 'undefined') {
    return node
  }

  return createPortal(node, document.body)
}

/** Matched characters picked out, the way the log viewer does it. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const hit = query.trim() === '' ? null : fuzzyMatchWords(query, text)
  const slices = fuzzySlices(text, hit?.indices ?? [])

  return (
    <>
      {slices.map((slice, index) => (
        <span key={index} className={cn(slice.match && 'font-semibold text-hazard')}>
          {slice.text}
        </span>
      ))}
    </>
  )
}
