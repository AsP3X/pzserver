import { useQuery } from '@tanstack/react-query'

import { Container } from '@/components/ui/section'
import { useTranslation } from '@/i18n/use-translation'
import { siteQuery } from '@/lib/queries'

export function SiteFooter() {
  const { locale } = useTranslation()
  const { data: site } = useQuery(siteQuery(locale))

  return (
    <footer className="border-t border-fence">
      <div aria-hidden="true" className="hazard-tape h-1 opacity-40" />
      <Container className="flex flex-col items-start justify-between gap-4 py-8 sm:flex-row sm:items-center">
        <p className="text-xs text-dust">{site?.footer_text}</p>

        {site?.discord_url ? (
          <a
            href={site.discord_url}
            target="_blank"
            rel="noreferrer noopener"
            className="font-mono text-xs tracking-widest text-smoke uppercase transition-colors hover:text-hazard"
          >
            Discord
          </a>
        ) : null}
      </Container>
    </footer>
  )
}
