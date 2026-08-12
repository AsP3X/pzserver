import { useQuery } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import { Skull } from 'lucide-react'

import { Container } from '@/components/ui/section'
import { Button, LinkButton } from '@/components/ui/button'
import { LocaleSwitch } from '@/components/layout/locale-switch'
import type { TranslationKey } from '@/i18n/locales'
import { useTranslation } from '@/i18n/use-translation'
import { useCurrentUser, useLogout } from '@/lib/auth'
import { siteQuery } from '@/lib/queries'

const SECTIONS: Array<{ href: string; key: TranslationKey }> = [
  { href: '#status', key: 'nav.status' },
  { href: '#survivors', key: 'nav.survivors' },
  { href: '#features', key: 'nav.features' },
]

export function SiteHeader() {
  const { t, locale } = useTranslation()
  const { data: site } = useQuery(siteQuery(locale))

  // The section links are in-page anchors, so they only mean anything on the
  // page that has those sections.
  const onLanding = useRouterState({ select: (state) => state.location.pathname === '/' })

  return (
    <header className="sticky top-0 z-50 border-b border-fence bg-void/85 backdrop-blur-sm">
      <Container className="flex h-16 items-center justify-between gap-4">
        <Link to="/" className="flex items-center gap-2.5">
          <Skull aria-hidden="true" className="size-5 text-hazard" strokeWidth={1.75} />
          <span className="display text-lg text-bone">
            {site?.site_name ?? 'Knox County'}
          </span>
        </Link>

        {onLanding ? (
          <nav aria-label="Sections" className="hidden items-center gap-7 md:flex">
            {SECTIONS.map((section) => (
              <a
                key={section.href}
                href={section.href}
                className="font-mono text-xs tracking-widest text-smoke uppercase transition-colors hover:text-hazard"
              >
                {t(section.key)}
              </a>
            ))}
          </nav>
        ) : null}

        <div className="flex items-center gap-3">
          <LocaleSwitch />
          <AccountControls onLanding={onLanding} />
        </div>
      </Container>
    </header>
  )
}

function AccountControls({ onLanding }: { onLanding: boolean }) {
  const { t } = useTranslation()
  const { user, isLoading } = useCurrentUser()
  const logout = useLogout()

  // Render nothing rather than flashing "sign in" at someone who is signed in.
  if (isLoading) {
    return <div className="h-9 w-24" />
  }

  if (!user) {
    return (
      <>
        <Link
          to="/login"
          className="hidden font-mono text-xs tracking-widest text-smoke uppercase transition-colors hover:text-hazard sm:block"
        >
          {t('auth.sign_in')}
        </Link>
        <LinkButton
          href={onLanding ? '#status' : '/register'}
          size="sm"
          className="hidden sm:inline-flex"
        >
          {onLanding ? t('nav.join_server') : t('auth.create_account')}
        </LinkButton>
      </>
    )
  }

  return (
    <>
      <Link
        to="/character"
        className="hidden font-mono text-xs tracking-widest text-smoke uppercase transition-colors hover:text-hazard sm:block"
      >
        {t('nav.character')}
      </Link>
      <Link
        to="/account"
        className="hidden font-mono text-xs tracking-widest text-bone uppercase transition-colors hover:text-hazard sm:block"
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
    </>
  )
}
