import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { useCurrentUser } from '@/lib/auth'
import { canAdminister } from '@/lib/navigation'
import { adminPlayersQuery, myPositionQuery, safeZonesQuery } from '@/lib/queries'
import type { MapPin, MapZone } from '@/lib/worldmap'

const ZONE_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899']

const PLAYER_COLOR = {
  selected: '#ffb000',
  online: '#8bb04a',
  offline: '#676e62',
  dead: '#c44536',
}

/**
 * Layers every map should carry: the no-PvP rectangles, and whoever we are
 * allowed to see standing on them.
 */
export function useMapLayers(selectedId?: string | null): {
  zoneOverlays: MapZone[]
  playerPins: MapPin[]
} {
  const { user } = useCurrentUser()
  const staff = canAdminister(user?.role)
  const zones = useQuery(safeZonesQuery)
  const players = useQuery({ ...adminPlayersQuery, enabled: staff })
  const mine = useQuery({ ...myPositionQuery, enabled: Boolean(user) && !staff })

  const zoneOverlays = useMemo(() => {
    const list = zones.data?.zones ?? []
    const dim = zones.data?.enabled === false
    return list.map((zone, index) => ({
      id: zone.id,
      cells: [],
      cellSize: 16,
      rect: { x1: zone.x1, y1: zone.y1, x2: zone.x2, y2: zone.y2 },
      color: `${ZONE_COLORS[index % ZONE_COLORS.length]}${dim ? '44' : '88'}`,
      selected: selectedId === zone.id,
      label: zone.name,
    }))
  }, [selectedId, zones.data])

  const playerPins = useMemo((): MapPin[] => {
    if (staff) {
      return (players.data ?? [])
        .filter((player) => player.x !== null && player.y !== null)
        .map((player) => ({
          id: player.username,
          x: player.x as number,
          y: player.y as number,
          label: player.username,
          health: player.is_dead ? 0 : player.health,
          look: player.appearance,
          color:
            player.username === selectedId
              ? PLAYER_COLOR.selected
              : player.is_dead
                ? PLAYER_COLOR.dead
                : player.online
                  ? PLAYER_COLOR.online
                  : PLAYER_COLOR.offline,
        }))
    }

    const position = mine.data?.position
    if (!user || !position) {
      return []
    }
    return [
      {
        id: user.username,
        x: position.x,
        y: position.y,
        label: user.username,
        color: PLAYER_COLOR.selected,
      },
    ]
  }, [mine.data?.position, players.data, selectedId, staff, user])

  return { zoneOverlays, playerPins }
}

export function mergePins(base: MapPin[], extra: MapPin[] | undefined): MapPin[] {
  if (!extra || extra.length === 0) {
    return base
  }
  const byId = new Map<string, MapPin>()
  for (const pin of base) {
    byId.set(pin.id ?? `${pin.x},${pin.y}`, pin)
  }
  for (const pin of extra) {
    byId.set(pin.id ?? `${pin.x},${pin.y}`, pin)
  }
  return [...byId.values()]
}
