import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { cn } from '@/lib/cn'

export interface TabItem<Id extends string> {
  id: Id
  label: ReactNode
  /** Shown after the label, for "how much is in here". */
  count?: number
  /** Nesting level, drawn as a leading marker so a tree survives a flat strip. */
  depth?: number
}

interface TabStripProps<Id extends string> {
  items: TabItem<Id>[]
  active: Id
  onSelect: (id: Id) => void
  /** Names the tablist for screen readers. */
  label: string
  className?: string
}

/**
 * A horizontal tab strip that scrolls rather than wraps.
 *
 * Arrow keys move between tabs and only the active one is tabbable, which is
 * what the pattern expects — tabbing through fifteen containers to reach the
 * content below them is not navigation.
 *
 * On a narrow screen the strip scrolls sideways with snap points instead of
 * collapsing into a select: a dropdown hides how many containers there are,
 * which is half of what the strip is telling you. A fade on whichever edge
 * still has tabs behind it is the only hint that there is more, since the
 * scrollbar itself is hidden.
 */
export function TabStrip<Id extends string>({
  items,
  active,
  onSelect,
  label,
  className,
}: TabStripProps<Id>) {
  const strip = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState({ start: false, end: false })

  const measure = useCallback(() => {
    const element = strip.current

    if (!element) {
      return
    }

    const remaining = element.scrollWidth - element.clientWidth - element.scrollLeft

    // A pixel of slack: fractional layout widths otherwise leave the end fade
    // on permanently once you have scrolled all the way over.
    setOverflow({ start: element.scrollLeft > 1, end: remaining > 1 })
  }, [])

  useEffect(() => {
    const element = strip.current

    if (!element) {
      return
    }

    measure()

    const observer = new ResizeObserver(measure)

    observer.observe(element)

    return () => observer.disconnect()
    // Re-measured when the tabs themselves change, not only the box.
  }, [measure, items])

  const move = (delta: number) => {
    const index = items.findIndex((item) => item.id === active)
    const next = items[(index + delta + items.length) % items.length]

    if (!next) {
      return
    }

    onSelect(next.id)

    // Follow the selection, or a keyboard user ends up on a tab they cannot see.
    strip.current
      ?.querySelector(`[data-tab-id="${CSS.escape(next.id)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  return (
    <div className={cn('relative', className)}>
      <div
        ref={strip}
        role="tablist"
        aria-label={label}
        aria-orientation="horizontal"
        onScroll={measure}
        className={cn(
          'flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1',
          // The strip is its own scroll container; hide the bar and let the
          // edge fades carry the affordance instead.
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        )}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            move(1)
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault()
            move(-1)
          } else if (event.key === 'Home') {
            event.preventDefault()
            onSelect(items[0]!.id)
          } else if (event.key === 'End') {
            event.preventDefault()
            onSelect(items[items.length - 1]!.id)
          }
        }}
      >
        {items.map((item) => {
          const selected = item.id === active

          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              data-tab-id={item.id}
              aria-selected={selected}
              aria-controls={`tabpanel-${item.id}`}
              id={`tab-${item.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(item.id)}
              className={cn(
                'flex shrink-0 snap-start items-center gap-2 border px-3 py-2 font-mono text-xs tracking-wide whitespace-nowrap uppercase transition-colors',
                selected
                  ? 'border-hazard bg-hazard-soft text-hazard'
                  : 'border-fence text-smoke hover:border-fence-bright hover:text-bone',
              )}
            >
              {item.depth ? (
                <span
                  aria-hidden="true"
                  className="text-dust"
                  // Indented with margin rather than padding spaces, which HTML
                  // would collapse and flatten the tree straight back out.
                  style={{ marginInlineStart: `${(item.depth - 1) * 0.625}rem` }}
                >
                  └
                </span>
              ) : null}

              <span className="normal-case">{item.label}</span>

              {item.count === undefined ? null : (
                <span
                  className={cn('tabular-nums', selected ? 'text-hazard/70' : 'text-dust')}
                >
                  {item.count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <Fade side="start" show={overflow.start} />
      <Fade side="end" show={overflow.end} />
    </div>
  )
}

/** The "there is more this way" gradient over one edge of the strip. */
function Fade({ side, show }: { side: 'start' | 'end'; show: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-y-0 w-10 transition-opacity duration-200',
        side === 'start'
          ? 'left-0 bg-gradient-to-r from-void to-transparent'
          : 'right-0 bg-gradient-to-l from-void to-transparent',
        show ? 'opacity-100' : 'opacity-0',
      )}
    />
  )
}

/** The region a tab controls. */
export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`tabpanel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={-1}>
      {children}
    </div>
  )
}
