import { useQuery } from '@tanstack/react-query'
import { Crosshair, Grid3x3, Layers, Navigation } from 'lucide-react'
import { useMemo, useState } from 'react'

import { HealthMeter } from '@/components/ui/bar'
import { Button } from '@/components/ui/button'
import { FormError } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/skeleton'
import { WorldmapView, type MapFocus } from '@/components/ui/worldmap'
import { formatNumber, formatRelativeTime } from '@/lib/format'
import { worldToCell } from '@/lib/worldmap'
import { myCharacterQuery, myFriendsQuery, myPositionQuery } from '@/lib/queries'
import type { MapPin } from '@/lib/worldmap'
import { useTranslation } from '@/i18n/use-translation'

/**
 * Where the survivor is standing.
 *
 * The mod writes everyone's position every thirty real seconds, and the file
 * outlives the session — so a position with an old stamp is not a stale
 * reading to hide, it is the spot the player logged out at, which is exactly
 * what somebody planning their next run wants to know. The page says which of
 * the two it is showing rather than picking one and hoping.
 */
export function MapPage() {
  const { t, intlLocale } = useTranslation()

  const { data, isPending, isError, refetch } = useQuery(myPositionQuery)
  const character = useQuery(myCharacterQuery)
  const friends = useQuery(myFriendsQuery)
  const position = data?.position ?? null
  const isDead = character.data?.character?.is_dead ?? false
  const health = isDead
    ? 0
    : (character.data?.body?.health?.overall ?? character.data?.character?.vitals?.health ?? null)

  const [focus, setFocus] = useState<MapFocus | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

  const marker = useMemo(
    () =>
      position
        ? { x: position.x, y: position.y, health, look: character.data?.character?.appearance }
        : null,
    [character.data?.character?.appearance, health, position],
  )

  const friendPins = useMemo<MapPin[]>(() => {
    const pins: MapPin[] = []
    for (const card of friends.data?.friends ?? []) {
      if (!card.their_share_position || !card.position) {
        continue
      }
      pins.push({
        id: card.id,
        x: card.position.x,
        y: card.position.y,
        label: card.username,
        color: card.online ? '#8bb04a' : '#9ca392',
        look: card.appearance ?? null,
      })
    }
    return pins
  }, [friends.data?.friends])

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:p-5">
      <header className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hazard-tape h-1 w-8" />
            <span className="eyebrow">{t('nav.map')}</span>
          </div>
          <h1 className="display mt-2 text-2xl text-bone sm:text-3xl">{t('map.title')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-smoke">{t('map.description')}</p>
          {friends.data && friends.data.map_enabled === false ? (
            <p className="mt-2 text-xs text-dust">{t('map.friends_disabled')}</p>
          ) : friendPins.length > 0 ? (
            <p className="mt-2 text-xs text-dust">
              {t('map.friends_visible', { count: friendPins.length })}
            </p>
          ) : null}
        </div>
        {position ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setFocus({ x: position.x, y: position.y, token: Date.now() })}
          >
            <Crosshair aria-hidden="true" className="size-3.5" />
            {t('map.centre_on_me')}
          </Button>
        ) : null}
      </header>

      {isPending ? (
        <Skeleton className="min-h-0 flex-1" />
      ) : isError ? (
        <div>
          <FormError>{t('common.error')}</FormError>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border border-fence bg-ash px-4 py-3">
            {position ? (
              <>
                <Reading
                  icon={Navigation}
                  label={t('map.coordinates')}
                  value={`${formatNumber(Math.round(position.x), intlLocale)}, ${formatNumber(Math.round(position.y), intlLocale)}`}
                />
                <Reading
                  icon={Grid3x3}
                  label={t('map.cell')}
                  value={`${formatNumber(worldToCell(position.x, position.y).x, intlLocale)}, ${formatNumber(worldToCell(position.x, position.y).y, intlLocale)}`}
                />
                <Reading
                  icon={Layers}
                  label={t('map.floor')}
                  value={
                    position.z === 0
                      ? t('map.ground_floor')
                      : t('map.floor_number', { count: position.z })
                  }
                />
                <span className="flex flex-col">
                  <span
                    className={
                      isDead ? 'font-mono text-sm text-blood' : data?.online ? 'font-mono text-sm text-moss' : 'font-mono text-sm text-dust'
                    }
                  >
                    {isDead
                      ? t('character.dead')
                      : data?.online
                        ? t('map.in_game')
                        : t('map.logged_out')}
                  </span>
                  {data?.reported_at ? (
                    <span className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
                      {formatRelativeTime(data.reported_at, intlLocale)}
                    </span>
                  ) : null}
                </span>
                <HealthMeter health={health} label={t('character.health')} />
              </>
            ) : (
              <p className="text-sm text-dust">{t('map.no_position')}</p>
            )}
            {cursor ? (
              <span className="lg:ml-auto">
                <Reading
                  icon={Crosshair}
                  label={t('map.cursor')}
                  value={`${formatNumber(Math.round(cursor.x), intlLocale)}, ${formatNumber(Math.round(cursor.y), intlLocale)} · ${t('map.cell_at', worldToCell(cursor.x, cursor.y))}`}
                />
              </span>
            ) : (
              <p className="text-xs text-dust lg:ml-auto">{t('map.click_hint')}</p>
            )}
          </div>

          <WorldmapView
            marker={marker}
            markers={friendPins}
            focus={focus}
            onPick={setCursor}
            className="min-h-64 flex-1"
          />
          {friendPins.length > 0 ? (
            <ul className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[0.6875rem] text-dust">
              <li className="flex items-center gap-1.5">
                <span aria-hidden="true" className="size-2" style={{ background: '#8bb04a' }} />
                {t('map.friends_online')}
              </li>
              <li className="flex items-center gap-1.5">
                <span aria-hidden="true" className="size-2" style={{ background: '#9ca392' }} />
                {t('map.friends_offline')}
              </li>
            </ul>
          ) : null}
        </>
      )}
    </section>
  )
}

function Reading({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Navigation
  label: string
  value: string
}) {
  return (
    <span className="flex items-center gap-2.5">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-dust" strokeWidth={1.5} />
      <span>
        <span className="block font-mono text-sm text-bone tabular-nums">{value}</span>
        <span className="block font-mono text-[0.6875rem] tracking-widest text-dust uppercase">
          {label}
        </span>
      </span>
    </span>
  )
}
