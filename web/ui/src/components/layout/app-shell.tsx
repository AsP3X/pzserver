import { useEffect, useState, type ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { Menu, Skull, X } from 'lucide-react'

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

/**
 * Sidebar layout for the signed-in surfaces.
 *
 * The sidebar is permanent from `lg` up and an off-canvas drawer below it,
 * rather than a squeezed rail: at phone widths a rail costs a third of the
 * screen to show icons nobody can label.
 */
export function AppShell({ surface, groups, children }: AppShellProps) {
  const { t } = useTranslation()
  const [drawerOpen, setDrawerOpen] = useState(false)

  const pathname = useRouterState({ select: (state) => state.location.pathname })

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

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
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

      <nav
        id="surface-nav"
        aria-label={surface}
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-fence bg-ash transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
          drawerOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-fence px-5">
          <Link to="/" className="flex items-center gap-2.5">
            <Skull aria-hidden="true" className="size-5 text-hazard" strokeWidth={1.75} />
            <span className="display text-lg text-bone">{surface}</span>
          </Link>

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

        <div className="flex-1 overflow-y-auto px-3 py-5">
          {groups.map((group) => (
            <div key={group.label} className="mb-6 last:mb-0">
              <p className="px-2 pb-2 font-mono text-[0.625rem] tracking-widest text-dust uppercase">
                {t(group.label)}
              </p>

              <ul className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <li key={item.to}>
                    {item.planned ? (
                      // Listed so the shape of the section is honest, but not a
                      // link: a dead click is worse than a visible "not yet".
                      <span
                        className="flex cursor-not-allowed items-center gap-2.5 px-2 py-1.5 text-sm text-dust/70"
                        title={t('nav.planned')}
                      >
                        <item.icon aria-hidden="true" className="size-4" strokeWidth={1.5} />
                        <span className="flex-1 truncate">{t(item.label)}</span>
                        <span className="font-mono text-[0.5625rem] tracking-wider uppercase">
                          {t('nav.soon')}
                        </span>
                      </span>
                    ) : (
                      <Link
                        to={item.to}
                        // The section roots would otherwise light up for every
                        // page beneath them.
                        activeOptions={{ exact: item.to === '/me' || item.to === '/admin' }}
                        // Only the differences go in active/inactive props: the
                        // router concatenates them onto className rather than
                        // merging, so repeating a utility here would leave two
                        // conflicting classes fighting over CSS order.
                        className="flex items-center gap-2.5 border-l-2 px-2 py-1.5 text-sm transition-colors"
                        inactiveProps={{
                          className: 'border-transparent text-smoke hover:bg-ash-raised hover:text-bone',
                        }}
                        activeProps={{ className: 'border-hazard bg-ash-raised text-bone' }}
                      >
                        <item.icon aria-hidden="true" className="size-4" strokeWidth={1.5} />
                        <span className="truncate">{t(item.label)}</span>
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <SidebarFooter />
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <main id="main" className="flex-1">
          {children}
        </main>
      </div>
    </div>
  )
}

function SidebarFooter() {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const logout = useLogout()

  return (
    <div className="shrink-0 border-t border-fence p-3">
      <div className="flex items-center justify-between gap-2">
        <Link to="/me/settings" className="min-w-0 flex-1 px-2">
          <span className="block truncate font-mono text-xs text-bone">{user?.username}</span>
          <span className="block truncate text-[0.6875rem] text-dust">{user?.email}</span>
        </Link>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
        >
          {t('auth.sign_out')}
        </Button>
      </div>

      <div className="mt-3 hidden justify-between px-2 lg:flex">
        <LocaleSwitch />
        <Link
          to="/"
          className="self-center font-mono text-[0.6875rem] tracking-widest text-dust uppercase transition-colors hover:text-hazard"
        >
          {t('nav.back_to_site')}
        </Link>
      </div>
    </div>
  )
}
