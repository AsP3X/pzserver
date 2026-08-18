import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { LogOut, Menu, PanelLeftClose, PanelLeftOpen, Skull, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { LocaleSwitch } from '@/components/layout/locale-switch'
import { cn } from '@/lib/cn'
import { useCurrentUser, useLogout } from '@/lib/auth'
import { useTranslation } from '@/i18n/use-translation'
import type { NavGroup } from '@/lib/navigation'

interface AppShellProps {
  /** Which surface this is — shown beside the wordmark. */
  surface: string
  groups: NavGroup[]
  children: ReactNode
}

const COLLAPSE_KEY = 'knox.nav.collapsed'

/** Rail width when collapsed, in px. The tooltip reads it to park itself. */
const RAIL_PX = 72

/**
 * Long enough that crossing the rail on the way somewhere else does not open
 * it, short enough that deliberately going there feels immediate.
 */
const PEEK_IN_MS = 90

/** Forgiving of a slightly overshot mouse, without feeling sticky. */
const PEEK_OUT_MS = 180

/**
 * Remember the choice, but rest as a rail.
 *
 * The rail is the default rather than the opt-in, because hover is what drives
 * this sidebar: starting expanded would mean nothing happens on hover until you
 * have first clicked the toggle, which puts a click in front of the very
 * interaction that is meant to replace it.
 *
 * Only an explicit "keep it open" is stored as such — an absent preference
 * reads as collapsed, so a first visit gets the hover behaviour immediately.
 */
function useCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') {
      return true
    }
    return window.localStorage.getItem(COLLAPSE_KEY) !== '0'
  })

  const set = useCallback((next: boolean) => {
    setCollapsed(next)
    window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
  }, [])

  return [collapsed, set]
}

/**
 * Whether hovering means anything here.
 *
 * On a touch screen there is no hover to expand with, and a tap would leave the
 * rail stuck open. Those devices keep the tooltips instead.
 */
function useCanHover(): boolean {
  const [canHover, setCanHover] = useState(false)

  useEffect(() => {
    const query = window.matchMedia('(hover: hover) and (pointer: fine)')
    const sync = () => setCanHover(query.matches)
    sync()
    query.addEventListener('change', sync)

    return () => query.removeEventListener('change', sync)
  }, [])

  return canHover
}

interface Tip {
  label: string
  top: number
}

/**
 * Sidebar layout for the signed-in surfaces.
 *
 * The sidebar is permanent from `lg` up and an off-canvas drawer below it,
 * rather than a squeezed rail: at phone widths a rail costs a third of the
 * screen to show icons nobody can label.
 *
 * From `lg` up it collapses to an icon rail, and hovering the rail opens it
 * again for as long as the cursor is there. Two things make that bearable:
 *
 * - **It overlays rather than pushes.** The rail keeps its 72px slot in the
 *   layout and the open panel floats above the page. Widening it in flow would
 *   shove every page 216px sideways each time a cursor crossed the rail on its
 *   way to something else.
 * - **Icons do not move between states.** They sit at the same offset whether
 *   open or shut, so only the panel width and the label opacity animate.
 *   Re-centring them would read as a jitter rather than a reveal.
 *
 * The toggle still pins it open, and a pinned sidebar ignores hover entirely.
 */
export function AppShell({ surface, groups, children }: AppShellProps) {
  const { t } = useTranslation()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [collapsed, setCollapsed] = useCollapsed()
  const [peek, setPeek] = useState(false)
  const [tip, setTip] = useState<Tip | null>(null)
  const canHover = useCanHover()

  // Set when the sidebar is collapsed while the cursor is still inside it, so
  // it does not immediately re-open under the very click that shut it. Cleared
  // when the cursor actually leaves.
  const blockPeek = useRef(false)
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pathname = useRouterState({ select: (state) => state.location.pathname })

  const expanded = !collapsed || peek
  // Only a hover-opened rail floats; a pinned one owns its space.
  const overlaying = collapsed && peek

  const clearTimers = useCallback(() => {
    if (enterTimer.current) {
      clearTimeout(enterTimer.current)
      enterTimer.current = null
    }
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current)
      leaveTimer.current = null
    }
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  const onPointerEnter = useCallback(() => {
    if (!canHover || !collapsed || blockPeek.current) {
      return
    }
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current)
      leaveTimer.current = null
    }
    if (peek || enterTimer.current) {
      return
    }
    enterTimer.current = setTimeout(() => {
      enterTimer.current = null
      setPeek(true)
    }, PEEK_IN_MS)
  }, [canHover, collapsed, peek])

  const onPointerLeave = useCallback(() => {
    blockPeek.current = false
    if (enterTimer.current) {
      clearTimeout(enterTimer.current)
      enterTimer.current = null
    }
    setTip(null)
    if (!peek) {
      return
    }
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null
      setPeek(false)
    }, PEEK_OUT_MS)
  }, [peek])

  const toggle = useCallback(() => {
    clearTimers()
    setTip(null)
    const next = !collapsed
    if (next) {
      // Collapsing with the cursor still on it — hold hover off until it leaves.
      blockPeek.current = true
      setPeek(false)
    }
    setCollapsed(next)
  }, [clearTimers, collapsed, setCollapsed])

  // Navigating is the signal that the drawer has done its job.
  useEffect(() => {
    setDrawerOpen(false)
  }, [pathname])

  // Escape closes it, which is the one shortcut people try without being told.
  useEffect(() => {
    if (!drawerOpen) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerOpen(false)
      }
    }

    document.addEventListener('keydown', onKeyDown)

    return () => document.removeEventListener('keydown', onKeyDown)
  }, [drawerOpen])

  // Ctrl/Cmd+B, the shortcut every editor with a sidebar already uses.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'b' || !(event.metaKey || event.ctrlKey)) {
        return
      }
      // Not while someone is typing a 'b' into a field.
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
        return
      }
      event.preventDefault()
      toggle()
    }

    document.addEventListener('keydown', onKeyDown)

    return () => document.removeEventListener('keydown', onKeyDown)
  }, [toggle])

  // Tooltips are the fallback for devices that cannot hover. Where hover works,
  // the panel itself opens and a tooltip would only flash on the way.
  const showTip = useCallback(
    (label: string, element: HTMLElement | null) => {
      if (canHover || !collapsed || !element) {
        return
      }
      const rect = element.getBoundingClientRect()
      setTip({ label, top: rect.top + rect.height / 2 })
    },
    [canHover, collapsed],
  )
  const hideTip = useCallback(() => setTip(null), [])

  useEffect(() => {
    if (expanded) {
      setTip(null)
    }
  }, [expanded])

  return (
    <div className="flex h-dvh flex-col lg:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-100 focus:bg-hazard focus:px-4 focus:py-2 focus:font-mono focus:text-xs focus:text-void focus:uppercase"
      >
        {t('nav.skip_to_content')}
      </a>

      {/* Phone and tablet: a bar with the drawer trigger. */}
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-3 border-b border-fence bg-void/90 px-4 backdrop-blur-sm lg:hidden">
        <Link to="/" className="flex items-center gap-2">
          <Skull aria-hidden="true" className="size-4 text-hazard" strokeWidth={1.75} />
          <span className="display text-base text-bone">{surface}</span>
        </Link>

        <div className="flex items-center gap-2">
          <LocaleSwitch />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDrawerOpen(true)}
            aria-expanded={drawerOpen}
            aria-controls="surface-nav"
          >
            <Menu aria-hidden="true" className="size-4" />
            <span className="sr-only">{t('nav.open_menu')}</span>
          </Button>
        </div>
      </header>

      {drawerOpen ? (
        <div
          className="fixed inset-0 z-40 bg-void/80 lg:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      {/* Holds the rail's place in the layout so the floating panel above it
          never moves the page. `contents` below lg keeps the drawer's own
          fixed positioning exactly as it was. */}
      <div
        className={cn(
          'contents lg:relative lg:block lg:shrink-0',
          'lg:transition-[width] lg:duration-150 lg:ease-out motion-reduce:lg:transition-none',
          collapsed ? 'lg:w-18' : 'lg:w-72',
        )}
      >
        <nav
          id="surface-nav"
          aria-label={surface}
          onMouseEnter={onPointerEnter}
          onMouseLeave={onPointerLeave}
          className={cn(
            // The drawer keeps its full width at every size — collapsing is a
            // desktop affordance, and a 72px off-canvas panel is nobody's idea
            // of a menu.
            'fixed inset-y-0 left-0 z-50 flex w-72 flex-col overflow-hidden border-r border-fence bg-ash',
            'transition-transform lg:absolute lg:inset-y-0 lg:left-0 lg:h-full lg:translate-x-0',
            'lg:transition-[width,box-shadow] lg:duration-150 lg:ease-out motion-reduce:lg:transition-none',
            expanded ? 'lg:w-72' : 'lg:w-18',
            overlaying ? 'lg:shadow-2xl lg:shadow-void/80' : 'lg:shadow-none',
            drawerOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <div className="flex h-16 w-72 shrink-0 items-center justify-between gap-2 border-b border-fence pr-3 pl-7">
            <Link to="/" className="flex min-w-0 items-center gap-2.5">
              <Skull
                aria-hidden="true"
                className="size-5 shrink-0 text-hazard"
                strokeWidth={1.75}
              />
              <span
                className={cn(
                  'display truncate text-lg text-bone transition-opacity duration-150 motion-reduce:transition-none',
                  !expanded && 'lg:opacity-0',
                )}
              >
                {surface}
              </span>
            </Link>

            {/* Desktop: the pin. Hover opens the rail on its own, so this is
                for keeping it open — it stays in the same corner either way. */}
            <button
              type="button"
              onClick={toggle}
              aria-expanded={!collapsed}
              aria-controls="surface-nav-items"
              title={`${collapsed ? t('nav.expand') : t('nav.collapse')} (${modifierLabel()}B)`}
              className={cn(
                'hidden size-9 shrink-0 items-center justify-center text-dust transition-opacity duration-150 hover:bg-ash-raised hover:text-hazard motion-reduce:transition-none lg:flex',
                !expanded && 'lg:pointer-events-none lg:opacity-0',
              )}
            >
              {collapsed ? (
                <PanelLeftOpen aria-hidden="true" className="size-4.5" strokeWidth={1.5} />
              ) : (
                <PanelLeftClose aria-hidden="true" className="size-4.5" strokeWidth={1.5} />
              )}
              <span className="sr-only">{collapsed ? t('nav.expand') : t('nav.collapse')}</span>
            </button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDrawerOpen(false)}
              className="lg:hidden"
            >
              <X aria-hidden="true" className="size-4" />
              <span className="sr-only">{t('nav.close_menu')}</span>
            </Button>
          </div>

          <div id="surface-nav-items" className="flex-1 overflow-x-hidden overflow-y-auto py-5">
            {groups.map((group, index) => (
              <div key={group.label} className="mb-6 last:mb-0">
                {/* Collapsed, the heading is unreadable, so the grouping is
                    carried by a rule instead of being lost entirely. */}
                <p
                  className={cn(
                    'w-72 truncate pr-3 pb-2 pl-7 font-mono text-[0.625rem] tracking-widest text-dust uppercase transition-opacity duration-150 motion-reduce:transition-none',
                    !expanded && 'lg:opacity-0',
                  )}
                >
                  {t(group.label)}
                </p>
                {index > 0 ? (
                  <hr
                    className={cn(
                      'mx-4 mb-2 hidden border-0 border-t border-fence transition-opacity duration-150 motion-reduce:transition-none lg:block',
                      expanded && 'lg:opacity-0',
                    )}
                  />
                ) : null}

                <ul className="flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <li key={item.to}>
                      {item.planned ? (
                        // Listed so the shape of the section is honest, but not
                        // a link: a dead click is worse than a visible "not yet".
                        <span
                          className="flex w-72 cursor-not-allowed items-center gap-2.5 py-1.5 pr-3 pl-7 text-sm text-dust/70"
                          title={t('nav.planned')}
                          onMouseEnter={(event) => showTip(t(item.label), event.currentTarget)}
                        >
                          <item.icon
                            aria-hidden="true"
                            className="size-4 shrink-0"
                            strokeWidth={1.5}
                          />
                          <span
                            className={cn(
                              'flex-1 truncate transition-opacity duration-150 motion-reduce:transition-none',
                              !expanded && 'lg:opacity-0',
                            )}
                          >
                            {t(item.label)}
                          </span>
                          <span
                            className={cn(
                              'shrink-0 font-mono text-[0.5625rem] tracking-wider uppercase transition-opacity duration-150 motion-reduce:transition-none',
                              !expanded && 'lg:opacity-0',
                            )}
                          >
                            {t('nav.soon')}
                          </span>
                        </span>
                      ) : (
                        <Link
                          to={item.to}
                          // The section roots would otherwise light up for every
                          // page beneath them.
                          activeOptions={{ exact: item.to === '/me' || item.to === '/admin' }}
                          onMouseEnter={(event) => showTip(t(item.label), event.currentTarget)}
                          onFocus={(event) => showTip(t(item.label), event.currentTarget)}
                          onBlur={hideTip}
                          // Only the differences go in active/inactive props: the
                          // router concatenates them onto className rather than
                          // merging, so repeating a utility here would leave two
                          // conflicting classes fighting over CSS order.
                          className="flex w-72 items-center gap-2.5 border-l-2 py-1.5 pr-3 pl-[1.625rem] text-sm transition-colors"
                          inactiveProps={{
                            className:
                              'border-transparent text-smoke hover:bg-ash-raised hover:text-bone',
                          }}
                          activeProps={{ className: 'border-hazard bg-ash-raised text-bone' }}
                        >
                          <item.icon
                            aria-hidden="true"
                            className="size-4 shrink-0"
                            strokeWidth={1.5}
                          />
                          {/* Faded, not `sr-only` — opacity keeps the link named
                              for a screen reader and is the thing that can
                              actually animate. */}
                          <span
                            className={cn(
                              'truncate transition-opacity duration-150 motion-reduce:transition-none',
                              !expanded && 'lg:opacity-0',
                            )}
                          >
                            {t(item.label)}
                          </span>
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <SidebarFooter expanded={expanded} onTip={showTip} onTipEnd={hideTip} />
        </nav>
      </div>

      {tip ? <RailTooltip tip={tip} /> : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <main id="main" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  )
}

/** ⌘ on Apple hardware, Ctrl everywhere else. */
function modifierLabel(): string {
  if (typeof navigator === 'undefined') {
    return 'Ctrl+'
  }
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl+'
}

/**
 * The label for whatever the cursor is on, parked beside the rail.
 *
 * Only reached on devices that cannot hover — everywhere else the panel opens
 * instead. Fixed rather than absolute: the nav list scrolls and clips.
 */
function RailTooltip({ tip }: { tip: Tip }) {
  return (
    <div
      role="presentation"
      aria-hidden="true"
      style={{ left: RAIL_PX + 8, top: tip.top }}
      className="pointer-events-none fixed z-60 hidden -translate-y-1/2 border border-fence-bright bg-void px-2.5 py-1.5 font-mono text-[0.6875rem] whitespace-nowrap text-bone shadow-lg shadow-void/60 lg:block"
    >
      {tip.label}
    </div>
  )
}

function SidebarFooter({
  expanded,
  onTip,
  onTipEnd,
}: {
  expanded: boolean
  onTip: (label: string, element: HTMLElement | null) => void
  onTipEnd: () => void
}) {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const logout = useLogout()
  const signOutRef = useRef<HTMLButtonElement>(null)

  return (
    <div className="shrink-0 border-t border-fence py-3">
      <div className="flex w-64 items-center gap-2 pr-3 pl-5">
        <Link
          to="/me/settings"
          onMouseEnter={(event) => onTip(user?.username ?? t('nav.settings'), event.currentTarget)}
          onFocus={(event) => onTip(user?.username ?? t('nav.settings'), event.currentTarget)}
          onBlur={onTipEnd}
          className="flex size-8 shrink-0 items-center justify-center border border-fence-bright font-mono text-xs text-bone transition-colors hover:border-hazard hover:text-hazard"
        >
          <span aria-hidden="true">{(user?.username ?? '?').slice(0, 1).toUpperCase()}</span>
          <span className="sr-only">{user?.username ?? t('nav.settings')}</span>
        </Link>

        <div
          className={cn(
            'min-w-0 flex-1 transition-opacity duration-150 motion-reduce:transition-none',
            !expanded && 'lg:opacity-0',
          )}
        >
          <span className="block truncate font-mono text-xs text-bone">{user?.username}</span>
          <span className="block truncate text-[0.6875rem] text-dust">{user?.email}</span>
        </div>

        <button
          ref={signOutRef}
          type="button"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
          onMouseEnter={() => onTip(t('auth.sign_out'), signOutRef.current)}
          onFocus={() => onTip(t('auth.sign_out'), signOutRef.current)}
          onBlur={onTipEnd}
          className="flex size-8 shrink-0 items-center justify-center text-dust transition-colors hover:bg-ash-raised hover:text-blood disabled:opacity-40"
        >
          <LogOut aria-hidden="true" className="size-4" strokeWidth={1.5} />
          <span className="sr-only">{t('auth.sign_out')}</span>
        </button>
      </div>

      {/* `shrink-0` and `nowrap` on both: while the panel is narrowing these
          would otherwise reflow onto three lines for the length of the
          animation. Clipped by the nav's overflow instead. */}
      <div
        className={cn(
          'mt-3 hidden w-64 justify-between gap-2 pr-3 pl-5 transition-opacity duration-150 motion-reduce:transition-none lg:flex',
          !expanded && 'lg:pointer-events-none lg:opacity-0',
        )}
      >
        <div className="shrink-0">
          <LocaleSwitch />
        </div>
        <Link
          to="/"
          className="shrink-0 self-center font-mono text-[0.6875rem] tracking-widest whitespace-nowrap text-dust uppercase transition-colors hover:text-hazard"
        >
          {t('nav.back_to_site')}
        </Link>
      </div>
    </div>
  )
}
