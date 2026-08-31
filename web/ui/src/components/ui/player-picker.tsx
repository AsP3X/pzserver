import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusPill } from '@/components/ui/status-pill'
import type { FriendDirectoryEntry } from '@/lib/api'
import { cn } from '@/lib/cn'
import { fuzzyMatchWords, fuzzySlices } from '@/lib/fuzzy'
import { friendDirectoryQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'

/**
 * Rendering every survivor on a large server costs frames. A hundred ranked
 * hits is more than anyone will scroll; the rest stay behind the query.
 */
const MAX_ROWS = 100

const RELATION_LABEL: Record<string, TranslationKey> = {
  friends: 'me.friends_already',
  incoming: 'me.friends_incoming',
  outgoing: 'me.friends_outgoing',
  blocked: 'me.friends_blocked',
  unregistered: 'me.friends_unregistered',
}

/**
 * Search over accounts and characters the server has seen.
 *
 * Username is the PZ / website name used to send the request. Profession is
 * the in-game job, so a search for "carpenter" or a partial name both hit.
 * Own `<dialog>` like the item picker: the body is a live list, not a confirm.
 */
export function PlayerPickerDialog({
  open,
  onSelect,
  onClose,
}: {
  open: boolean
  onSelect: (username: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const directory = useQuery({ ...friendDirectoryQuery, enabled: open })
  const dialog = useRef<HTMLDialogElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const searchId = useId()
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)

  const people = useMemo(() => directory.data ?? [], [directory.data])
  const searching = query.trim() !== ''

  const shown = useMemo(() => {
    return people
      .map((person) => {
        const haystack = [person.username, person.profession ?? ''].join(' ')
        if (!searching) {
          return { person, score: person.online ? 1 : 0 }
        }
        const hit = fuzzyMatchWords(query, haystack)
        return hit ? { person, score: hit.score + (person.online ? 2 : 0) } : null
      })
      .filter((entry): entry is { person: FriendDirectoryEntry; score: number } => entry !== null)
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score
        }
        return left.person.username.localeCompare(right.person.username)
      })
      .slice(0, MAX_ROWS)
      .map((entry) => entry.person)
  }, [people, query, searching])

  useEffect(() => {
    const element = dialog.current
    if (!element) {
      return
    }

    if (open && !element.open) {
      element.showModal()
      setQuery('')
      setHighlight(0)
      search.current?.focus()
    } else if (!open && element.open) {
      element.close()
    }
  }, [open])

  useEffect(() => {
    setHighlight(0)
  }, [query])

  function choose(person: FriendDirectoryEntry) {
    if (person.relation !== 'none') {
      return
    }
    onSelect(person.username)
    window.setTimeout(onClose, 0)
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((current) => Math.min(current + 1, Math.max(shown.length - 1, 0)))
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
          {t('me.friends_find_title')}
        </h2>
        <p className="mt-2 text-sm text-smoke">{t('me.friends_find_description')}</p>

        <label htmlFor={searchId} className="sr-only">
          {t('me.friends_search_placeholder')}
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
            placeholder={t('me.friends_search_placeholder')}
            className={cn(
              'h-12 w-full border border-fence-bright bg-void pr-3 pl-9 font-mono text-sm text-bone',
              'transition-colors placeholder:text-dust focus:border-hazard',
            )}
          />
        </div>

        {people.length > 0 ? (
          <p className="mt-2 text-xs text-dust">
            {t('me.friends_search_hint', { count: people.length })}
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {directory.isPending ? (
          <div className="flex flex-col gap-2 p-5">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : directory.isError ? (
          <p className="p-5 text-sm text-blood">{t('auth.unexpected_error')}</p>
        ) : people.length === 0 ? (
          <p className="p-5 text-sm text-dust">{t('me.friends_search_none')}</p>
        ) : shown.length === 0 ? (
          <p className="p-5 text-sm text-dust">{t('me.friends_search_empty')}</p>
        ) : (
          <ul>
            {shown.map((person, index) => {
              const addable = person.relation === 'none'
              const relationKey = RELATION_LABEL[person.relation]
              return (
                <li key={person.username}>
                  <button
                    type="button"
                    onClick={() => choose(person)}
                    onMouseEnter={() => setHighlight(index)}
                    disabled={!addable}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 border-b border-fence px-5 py-2.5 text-left',
                      index === highlight ? 'bg-ash-raised' : 'hover:bg-ash-raised',
                      !addable && 'cursor-default opacity-70 hover:bg-transparent',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-bone">
                        <Highlighted text={person.username} query={query} />
                      </span>
                      {person.profession ? (
                        <span className="block truncate font-mono text-xs text-smoke">
                          <Highlighted text={person.profession} query={query} />
                        </span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <StatusPill
                        state={person.online ? 'online' : 'offline'}
                        label={person.online ? t('common.online') : t('common.offline')}
                      />
                      {relationKey ? (
                        <span className="border border-fence px-1.5 py-0.5 font-mono text-[0.625rem] text-dust uppercase">
                          {t(relationKey)}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="flex shrink-0 justify-end border-t border-fence px-5 py-3">
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </dialog>
  )

  if (typeof document === 'undefined') {
    return node
  }

  return createPortal(node, document.body)
}

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
