import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import { Menu, Skull, X } from 'lucide-react'

import { Container } from '@/components/ui/section'
import { Button, LinkButton } from '@/components/ui/button'
import { LocaleSwitch } from '@/components/layout/locale-switch'
import { cn } from '@/lib/cn'
import { useTranslation } from '@/i18n/use-translation'
import { useCurrentUser, useLogout } from '@/lib/auth'
import { canAdminister, PUBLIC_NAV } from '@/lib/navigation'
import { siteQuery } from '@/lib/queries'

export function SiteHeader() {
  const { t, locale } = useTranslation()
  const { data: site } = useQuery(siteQuery(locale))
  const [menuOpen, setMenuOpen] = useState(false)

  const pathname = useRouterState({ select: (state) => state.location.pathname })

  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  return (
    <header className="sticky top-0 z-50 border-b border-fence bg-void/85 backdrop-blur-sm">
      <Container className="flex h-16 items-center justify-between gap-4">
        <Link to="/" className="flex shrink-0 items-center gap-2.5">
          <Skull aria-hidden="true" className="size-5 text-hazard" strokeWidth={1.75} />
          <span className="display text-lg text-bone">{site?.site_name ?? 'Knox County'}</span>
        </Link>

        <nav aria-label={t('nav.sections')} className="hidden items-center gap-6 md:flex">
          {PUBLIC_NAV.filter((item) => !item.planned).map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="font-mono text-xs tracking-widest uppercase transition-colors"
              inactiveProps={{ className: 'text-smoke hover:text-hazard' }}
              activeProps={{ className: 'text-hazard' }}
            >
              {t(item.label)}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <div className="hidden sm:block">
            <LocaleSwitch />
          </div>

          <div className="hidden sm:block">
            <AccountControls />
          </div>

          <Button
            variant="outline"
            size="sm"
            className="md:hidden"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-controls="site-menu"
          >
            {menuOpen ? (
              <X aria-hidden="true" className="size-4" />
            ) : (
              <Menu aria-hidden="true" className="size-4" />
            )}
            <span className="sr-only">{menuOpen ? t('nav.close_menu') : t('nav.open_menu')}</span>
          </Button>
        </div>
      </Container>

      {/* Below md the nav drops into a panel rather than being cut off. */}
      <div
        id="site-menu"
        className={cn('border-t border-fence bg-ash md:hidden', menuOpen ? 'block' : 'hidden')}
      >
        <Container className="flex flex-col gap-1 py-4">
          {PUBLIC_NAV.filter((item) => !item.planned).map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex items-center gap-2.5 px-2 py-2 text-sm transition-colors"
              inactiveProps={{ className: 'text-smoke hover:text-bone' }}
              activeProps={{ className: 'text-hazard' }}
            >
              <item.icon aria-hidden="true" className="size-4" strokeWidth={1.5} />
              {t(item.label)}
            </Link>
          ))}

          <div className="mt-3 flex items-center justify-between border-t border-fence pt-4">
            <LocaleSwitch />
            <AccountControls />
          </div>
        </Container>
      </div>
    </header>
  )
}

function AccountControls() {
  const { t } = useTranslation()
  const { user, isLoading } = useCurrentUser()
  const logout = useLogout()

  // Render a gap rather than flashing "sign in" at someone who is signed in.
  if (isLoading) {
    return <div className="h-9 w-24" />
  }

  if (!user) {
    return (
      <div className="flex items-center gap-3">
        <Link
          to="/login"
          className="font-mono text-xs tracking-widest text-smoke uppercase transition-colors hover:text-hazard"
        >
          {t('auth.sign_in')}
        </Link>
        <LinkButton href="/register" size="sm">
          {t('auth.create_account')}
        </LinkButton>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3">
      {canAdminister(user.role) ? (
        <Link
          to="/admin"
          className="font-mono text-xs tracking-widest text-smoke uppercase transition-colors hover:text-hazard"
        >
          {t('nav.admin')}
        </Link>
      ) : null}

      <Link
        to="/me"
        className="font-mono text-xs tracking-widest text-bone uppercase transition-colors hover:text-hazard"
      >
        {user.username}
      </Link>

      <Button
        variant="outline"
        size="sm"
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
      >
        {t('auth.sign_out')}
      </Button>
    </div>
  )
}
