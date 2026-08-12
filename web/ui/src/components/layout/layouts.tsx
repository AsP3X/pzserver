/** The three surfaces: public site, player area, admin. */
import type { ReactNode } from 'react'
import { Outlet } from '@tanstack/react-router'

import { AppShell } from '@/components/layout/app-shell'
import { Container, Section } from '@/components/ui/section'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Skeleton } from '@/components/ui/skeleton'
import { useAdminOnly, useRequireUser } from '@/lib/auth-guards'
import { useTranslation } from '@/i18n/use-translation'
import { ADMIN_NAV, PLAYER_NAV } from '@/lib/navigation'

/**
 * Anyone. Header, content, footer.
 *
 * Takes children so the not-found page can borrow the chrome: a 404 with no
 * header is a dead end, and an unmatched URL never reaches a layout route on
 * its own.
 */
export function PublicLayout({ children }: { children?: ReactNode }) {
  const { t } = useTranslation()

  return (
    <div id="top" className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-100 focus:bg-hazard focus:px-4 focus:py-2 focus:font-mono focus:text-xs focus:text-void focus:uppercase"
      >
        {t('nav.skip_to_content')}
      </a>

      <SiteHeader />

      <main id="main" className="flex-1">
        {children ?? <Outlet />}
      </main>

      <SiteFooter />
    </div>
  )
}

/** Signed in. Your own character, holdings and settings. */
export function PlayerLayout() {
  const { t } = useTranslation()
  const { user, isLoading } = useRequireUser()

  if (isLoading || !user) {
    return <SurfaceSkeleton />
  }

  return (
    <AppShell surface={t('nav.surface_player')} groups={PLAYER_NAV}>
      <Outlet />
    </AppShell>
  )
}

/** Staff only. Everything about the server and everyone on it. */
export function AdminLayout() {
  const { t } = useTranslation()
  const { allowed, isLoading } = useAdminOnly()

  if (isLoading || !allowed) {
    return <SurfaceSkeleton />
  }

  return (
    <AppShell surface={t('nav.surface_admin')} groups={ADMIN_NAV}>
      <Outlet />
    </AppShell>
  )
}

/**
 * Held while the session resolves.
 *
 * Deliberately not the sidebar with empty content: a shell that appears and
 * then disappears when the guard redirects is worse than a moment of nothing.
 */
function SurfaceSkeleton() {
  return (
    <Section>
      <Container>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-6 h-64 w-full" />
      </Container>
    </Section>
  )
}
