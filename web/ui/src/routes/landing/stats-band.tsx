import { useQuery } from '@tanstack/react-query'
import { Clock, Crosshair, Skull, Swords, Users } from 'lucide-react'

import { Container } from '@/components/ui/section'
import { StatTile } from '@/components/ui/stat-tile'
import { useTranslation } from '@/i18n/use-translation'
import { formatNumber } from '@/lib/format'
import { statsSummaryQuery } from '@/lib/queries'

/** Server-wide totals. */
export function StatsBand() {
  const { t, intlLocale } = useTranslation()
  const { data: stats } = useQuery(statsSummaryQuery)

  const tiles = [
    {
      key: 'players',
      label: t('stats.total_players'),
      icon: Users,
      value: stats && formatNumber(stats.total_players, intlLocale),
    },
    {
      key: 'kills',
      label: t('stats.zombie_kills'),
      icon: Crosshair,
      value: stats && formatNumber(stats.total_zombie_kills, intlLocale),
    },
    {
      key: 'hours',
      label: t('stats.hours_survived'),
      icon: Clock,
      value: stats && formatNumber(stats.total_hours_survived, intlLocale),
    },
    {
      key: 'deaths',
      label: t('stats.deaths'),
      icon: Skull,
      value: stats && formatNumber(stats.total_deaths, intlLocale),
    },
    {
      key: 'pvp',
      label: t('stats.pvp_kills'),
      icon: Swords,
      value: stats && formatNumber(stats.total_pvp_kills, intlLocale),
    },
  ]

  return (
    <section aria-label={t('stats.title')} className="border-b border-fence bg-ash">
      <Container className="px-0 sm:px-5">
        {/* Five tiles into two columns leaves the last one stranded, so it
            takes the full row until the grid can hold all five. */}
        <div className="grid grid-cols-2 divide-x divide-y divide-fence md:grid-cols-5 md:divide-y-0">
          {tiles.map((tile) => (
            <StatTile
              key={tile.key}
              label={tile.label}
              value={tile.value ?? undefined}
              icon={tile.icon}
              className="last:col-span-2 md:last:col-span-1"
            />
          ))}
        </div>
      </Container>
    </section>
  )
}
