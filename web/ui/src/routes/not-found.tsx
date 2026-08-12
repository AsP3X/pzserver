import { Link } from '@tanstack/react-router'

import { Container, Section } from '@/components/ui/section'
import { LinkButton } from '@/components/ui/button'
import { useTranslation } from '@/i18n/use-translation'

/**
 * Rendered inside the public chrome by the router, so a mistyped URL still has
 * a header to navigate away from rather than being a dead end.
 */
export function NotFoundPage() {
  const { t } = useTranslation()

  return (
    <Section>
      <Container className="max-w-xl text-center">
        <span className="display block text-7xl text-fence-bright">404</span>

        <h1 className="display mt-4 text-3xl text-bone">{t('not_found.title')}</h1>
        <p className="mt-3 text-sm leading-relaxed text-smoke">{t('not_found.body')}</p>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <LinkButton href="/">{t('not_found.go_home')}</LinkButton>
          <Link
            to="/status"
            className="inline-flex h-12 items-center border border-fence-bright px-6 font-display text-sm tracking-wider text-bone uppercase transition-colors hover:border-hazard hover:text-hazard"
          >
            {t('nav.status')}
          </Link>
        </div>
      </Container>
    </Section>
  )
}
