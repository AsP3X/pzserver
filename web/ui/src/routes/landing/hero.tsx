import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Trophy } from 'lucide-react'

import { LinkButton } from '@/components/ui/button'
import { Container } from '@/components/ui/section'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusPill } from '@/components/ui/status-pill'
import { useTranslation } from '@/i18n/use-translation'
import { serverStatusQuery, siteQuery } from '@/lib/queries'

export function Hero() {
  const { t, locale } = useTranslation()
  const { data: site } = useQuery(siteQuery(locale))
  const { data: status, isPending } = useQuery(serverStatusQuery)

  const stateLabel = isPending
    ? t('status.checking')
    : status
      ? t(`status.${status.state}`)
      : t('status.offline')

  return (
    <section className="grain relative overflow-hidden border-b border-fence">
      {/* Survey grid, fading out toward the bottom of the section. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.55]"
        style={{
          backgroundImage:
            'linear-gradient(var(--color-fence) 1px, transparent 1px), linear-gradient(90deg, var(--color-fence) 1px, transparent 1px)',
          backgroundSize: '72px 72px',
          maskImage: 'radial-gradient(ellipse 80% 60% at 30% 0%, #000 20%, transparent 75%)',
        }}
      />

      <Container className="relative py-20 sm:py-24 lg:py-28">
        <div className="max-w-3xl">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-10" />
            {site ? (
              <span className="eyebrow">{site.hero_badge}</span>
            ) : (
              <Skeleton className="h-3 w-40" />
            )}
          </div>

          {site ? (
            <>
              <h1 className="display mt-6 text-5xl text-bone sm:text-6xl lg:text-7xl">
                {site.hero_title}
              </h1>
              {/* Deliberately a third of the headline's size: it is a
                  qualifier, not a second headline. */}
              <p className="display mt-3 text-xl text-dust sm:text-2xl">
                {site.hero_subtitle}
              </p>
            </>
          ) : (
            <>
              <Skeleton className="mt-6 h-14 w-full max-w-xl sm:h-16" />
              <Skeleton className="mt-3 h-7 w-full max-w-md" />
            </>
          )}

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <StatusPill state={status?.state} label={stateLabel} />
            {status?.online ? (
              <span className="font-mono text-xs tracking-wide text-smoke">
                {status.player_count}{' '}
                {status.max_players ? (
                  <span className="text-dust">
                    {t('status.of_max', { max: status.max_players })}{' '}
                  </span>
                ) : null}
                {/* Its own key rather than lower-casing the label: German
                    capitalises nouns, so "Spieler" must not become "spieler". */}
                {t('status.players_online_inline')}
              </span>
            ) : null}
          </div>

          {site ? (
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-smoke sm:text-lg">
              {site.hero_description}
            </p>
          ) : (
            <Skeleton className="mt-6 h-12 w-full max-w-2xl" />
          )}

          <div className="mt-10 flex flex-wrap gap-3">
            <LinkButton href="#status">
              {site?.hero_cta_label ?? t('nav.join_server')}
              <ChevronRight aria-hidden="true" className="size-4" />
            </LinkButton>
            <LinkButton href="#survivors" variant="outline">
              <Trophy aria-hidden="true" className="size-4" />
              {t('survivors.title')}
            </LinkButton>
          </div>
        </div>
      </Container>
    </section>
  )
}
