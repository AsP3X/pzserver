import { useQuery } from '@tanstack/react-query'
import {
  Archive,
  Clock,
  Map as MapIcon,
  Package,
  Shield,
  Terminal,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Panel } from '@/components/ui/panel'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslation } from '@/i18n/use-translation'
import { siteQuery } from '@/lib/queries'

/**
 * Icon names are stored as free text in site_settings, so an unrecognised one
 * has to degrade rather than throw.
 */
const ICONS: Record<string, LucideIcon> = {
  archive: Archive,
  clock: Clock,
  map: MapIcon,
  package: Package,
  shield: Shield,
  terminal: Terminal,
  users: Users,
  wrench: Wrench,
}

export function Features() {
  const { t, locale } = useTranslation()
  const { data: site } = useQuery(siteQuery(locale))

  return (
    <Section id="features">
      <Container>
        <SectionHeading
          eyebrow={t('nav.features')}
          title={t('features.title')}
          description={t('features.subtitle')}
        />

        <div className="grid gap-px bg-fence sm:grid-cols-2">
          {site
            ? site.features.map((feature) => {
                const Icon = ICONS[feature.icon.toLowerCase()] ?? Shield

                return (
                  <Panel
                    key={feature.title}
                    className="border-0 p-6 transition-colors hover:bg-ash-raised"
                  >
                    <Icon
                      aria-hidden="true"
                      className="size-5 text-hazard"
                      strokeWidth={1.5}
                    />
                    <h3 className="display mt-4 text-xl text-bone">
                      {feature.title}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-smoke">
                      {feature.description}
                    </p>
                  </Panel>
                )
              })
            : Array.from({ length: 4 }, (_, index) => (
                <Panel key={index} className="border-0 p-6">
                  <Skeleton className="size-5" />
                  <Skeleton className="mt-4 h-6 w-40" />
                  <Skeleton className="mt-3 h-10 w-full" />
                </Panel>
              ))}
        </div>
      </Container>
    </Section>
  )
}
