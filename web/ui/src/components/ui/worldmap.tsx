import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BoxSelect, Loader2, Maximize2, Minus, Plus } from 'lucide-react'

import { cn } from '@/lib/cn'
import {
  DEFAULT_ISO_SCALE,
  MAX_ISO_SCALE,
  minIsoScaleForViewport,
  dziToWorld,
  drawIsoTiles,
  fitIsoScale,
  isoMapping,
  isoTiles,
  worldToDzi,
} from '@/lib/iso-tiles'
import {
  clampView,
  drawMapOverlays,
  drawWorldmap,
  fitScale,
  hitTestPins,
  loadWorldmap,
  vectorMapping,
  type MapPin,
  type MapRect,
  type MapZone,
  type View,
  type WorldMapping,
  type Worldmap,
} from '@/lib/worldmap'
import { mergePins, useMapLayers } from '@/lib/map-layers'
import { useTranslation } from '@/i18n/use-translation'

export type { MapPin, MapRect, MapZone }

export type MapBasemap = 'vector' | 'iso'

export interface MapFocus {
  x: number
  y: number
  /** Bump this when the camera should jump even if x/y did not change. */
  token: number
}

interface WorldmapViewProps {
  marker?: {
    x: number
    y: number
    health?: number | null
    look?: import('@/lib/player-look').PlayerLook | null
  } | null
  markers?: MapPin[]
  selectedId?: string | null
  destination?: { x: number; y: number } | null
  focus?: MapFocus | null
  initialScale?: number
  pickMode?: boolean
  onSelect?: (id: string) => void
  onPick?: (point: { x: number; y: number }) => void
  /** Painted districts, in world-tile cells. */
  zones?: MapZone[]
  /** Left-drag paints or erases instead of panning. Right-drag still pans. */
  paintMode?: 'paint' | 'erase' | null
  /** Brush radius in world tiles. */
  brushRadius?: number
  onBrush?: (point: { x: number; y: number }, erase: boolean) => void
  /** Left-drag draws a world rectangle instead of panning. */
  rectMode?: boolean
  onRect?: (rect: MapRect) => void
  className?: string
}

const MIN_SCALE = 0.01
const MAX_SCALE = 4
const DEFAULT_SCALE = 0.71
const DRAG_SLOP = 5
const MODE_KEY = 'knox.map.basemap'
const FALLBACK_BOUNDS: Worldmap['bounds'] = [0, 0, 19_967, 16_127]

/**
 * Whether to offer the isometric basemap at all.
 *
 * Its tiles come from a host we do not run, which has already moved once: The
 * Indie Stone took the map off their servers on 7 August 2026 and it now
 * lives at tiles.pzmap.org. Turn this off to withdraw the mode entirely if
 * that source goes away for good — the vector basemap needs nothing external
 * and is what everyone falls back to meanwhile.
 */
const ISO_BASEMAP: boolean = true

function readMode(): MapBasemap {
  if (typeof window === 'undefined') {
    return 'vector'
  }
  if (!ISO_BASEMAP) {
    return 'vector'
  }
  return window.localStorage.getItem(MODE_KEY) === 'iso' ? 'iso' : 'vector'
}

function boundsMap(bounds: Worldmap['bounds']): Worldmap {
  return {
    bounds,
    bg: [20, 22, 18],
    styles: {},
    cells: {},
    labels: [],
    cellSize: 300,
    name: 'Knox County',
  }
}

/**
 * The basemap, pannable and zoomable.
 *
 * Two pictures of the same world: the schematic vector pack, and the official
 * isometric tiles. The camera stays in game coordinates either way, so a pin
 * does not jump when you switch.
 */
export function WorldmapView({
  marker,
  markers,
  selectedId,
  destination,
  focus,
  initialScale,
  pickMode = false,
  onSelect,
  onPick,
  zones,
  paintMode = null,
  brushRadius = 0,
  onBrush,
  rectMode = false,
  onRect,
  className,
}: WorldmapViewProps) {
  const { t } = useTranslation()
  const { zoneOverlays, playerPins } = useMapLayers(selectedId)
  const drawnZones = useMemo(
    () => [...zoneOverlays, ...(zones ?? [])],
    [zoneOverlays, zones],
  )
  const drawnMarkers = useMemo(() => {
    const extras = marker
      ? playerPins.filter((pin) => pin.x !== marker.x || pin.y !== marker.y)
      : playerPins
    return mergePins(extras, markers)
  }, [marker, markers, playerPins])

  const canvas = useRef<HTMLCanvasElement>(null)
  const frame = useRef<HTMLDivElement>(null)

  const [map, setMap] = useState<Worldmap | null>(null)
  const [failed, setFailed] = useState(false)
  const [view, setView] = useState<View | null>(null)
  const [mode, setMode] = useState<MapBasemap>(readMode)
  const [hover, setHover] = useState<{
    label: string
    health?: number | null
    x: number
    y: number
  } | null>(null)
  const [isoTick, setIsoTick] = useState(0)
  const [isoFellBack, setIsoFellBack] = useState(false)
  const [paintHover, setPaintHover] = useState<{ x: number; y: number } | null>(null)
  const [draftRect, setDraftRect] = useState<MapRect | null>(null)
  const rectStart = useRef<{ x: number; y: number } | null>(null)

  const viewRef = useRef<View | null>(null)
  const isoScaleRef = useRef(DEFAULT_ISO_SCALE)
  const modeRef = useRef(mode)
  modeRef.current = mode

  const setBoth = useCallback((next: View) => {
    viewRef.current = next
    setView(next)
  }, [])

  useEffect(() => {
    let live = true
    loadWorldmap()
      .then((loaded) => {
        if (live) {
          setMap(loaded)
        }
      })
      .catch(() => {
        if (live) {
          setFailed(true)
        }
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => isoTiles.subscribe(() => setIsoTick((tick) => tick + 1)), [])

  /**
   * Leave iso the moment its tiles stop arriving.
   *
   * The source is a third-party host and has moved before. Sitting on a black
   * canvas is the worst of the available outcomes, and a stored preference
   * outlives the deploy that would otherwise fix it — so drop the preference
   * as well, and say what happened rather than silently swapping the picture.
   */
  const isoUnreachable = mode === 'iso' && isoTiles.unreachable
  useEffect(() => {
    if (!isoUnreachable) {
      return
    }
    modeRef.current = 'vector'
    setMode('vector')
    setIsoFellBack(true)
    window.localStorage.removeItem(MODE_KEY)
  }, [isoUnreachable])

  const bounds = map?.bounds ?? FALLBACK_BOUNDS
  const clamp = useCallback(
    (next: View) => clampView(next, map ?? boundsMap(bounds)),
    [bounds, map],
  )

  const mappingAt = useCallback((current: View, width: number, height: number): WorldMapping => {
    if (modeRef.current === 'iso') {
      return isoMapping(current.x, current.y, isoScaleRef.current, width, height)
    }
    return vectorMapping(current, width, height)
  }, [])

  const centred = useRef(false)
  const lastFocus = useRef<number | null>(null)

  const centreOn = useCallback(
    (x: number, y: number) => {
      centred.current = true
      if (modeRef.current === 'iso') {
        isoScaleRef.current = DEFAULT_ISO_SCALE
        setBoth({ x, y, scale: DEFAULT_ISO_SCALE })
        return
      }
      setBoth({ x, y, scale: initialScale ?? DEFAULT_SCALE })
    },
    [initialScale, setBoth],
  )

  const reset = useCallback(() => {
    const box = frame.current?.getBoundingClientRect()
    if (!box) {
      return
    }

    const target = focus ?? marker ?? markers?.[0]
    if (target) {
      centreOn(target.x, target.y)
      return
    }

    const [minX, minY, maxX, maxY] = bounds
    centred.current = false
    if (modeRef.current === 'iso') {
      isoScaleRef.current = fitIsoScale(box.width, box.height)
      setBoth({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale: isoScaleRef.current })
      return
    }
    if (!map) {
      return
    }
    setBoth({
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      scale: fitScale(bounds, box.width, box.height),
    })
  }, [bounds, centreOn, focus, map, marker, markers, setBoth])

  useEffect(() => {
    if (!viewRef.current) {
      reset()
      return
    }
    if ((marker || (markers && markers.length > 0)) && !centred.current) {
      reset()
    }
  }, [map, marker, markers, mode, reset])

  useEffect(() => {
    if (!focus || lastFocus.current === focus.token) {
      return
    }
    lastFocus.current = focus.token
    centreOn(focus.x, focus.y)
  }, [centreOn, focus])

  useEffect(() => {
    const element = canvas.current
    const box = frame.current
    const current = viewRef.current
    if (!element || !box || !current) {
      return
    }

    const paint = () => {
      const latest = viewRef.current
      if (!latest) {
        return
      }
      const rect = box.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      element.width = Math.round(rect.width * ratio)
      element.height = Math.round(rect.height * ratio)
      element.style.width = `${rect.width}px`
      element.style.height = `${rect.height}px`

      const ctx = element.getContext('2d')
      if (!ctx) {
        return
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)

      const overlay = {
        width: rect.width,
        height: rect.height,
        marker,
        markerColor: '#ffb000',
        markers: drawnMarkers,
        destination,
        selectedId,
        zones: drawnZones,
        draftRect,
        brush:
          paintMode && paintHover
            ? {
                x: paintHover.x,
                y: paintHover.y,
                radius: Math.max(0, brushRadius),
                erase: paintMode === 'erase',
                cellSize: drawnZones[0]?.cellSize ?? 16,
              }
            : null,
      }

      if (modeRef.current === 'iso') {
        const floor = minIsoScaleForViewport(rect.width, rect.height)
        if (isoScaleRef.current < floor) {
          isoScaleRef.current = floor
        }
        const mapping = isoMapping(latest.x, latest.y, isoScaleRef.current, rect.width, rect.height)
        drawIsoTiles(ctx, mapping, rect.width, rect.height)
        drawMapOverlays(ctx, overlay, (x, y) => mapping.toScreen(x, y), 2)
        return
      }

      if (map) {
        drawWorldmap(ctx, map, latest, overlay)
        return
      }

      ctx.fillStyle = '#141611'
      ctx.fillRect(0, 0, rect.width, rect.height)
    }

    paint()
    const observer = new ResizeObserver(paint)
    observer.observe(box)
    return () => observer.disconnect()
  }, [
    brushRadius,
    destination,
    isoTick,
    map,
    marker,
    drawnMarkers,
    mode,
    paintHover,
    paintMode,
    draftRect,
    selectedId,
    view,
    drawnZones,
  ])

  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const current = viewRef.current
      const box = frame.current?.getBoundingClientRect()
      if (!current || !box) {
        return
      }

      const anchorX = clientX === undefined ? box.width / 2 : clientX - box.left
      const anchorY = clientY === undefined ? box.height / 2 : clientY - box.top

      if (modeRef.current === 'iso') {
        const held = isoMapping(
          current.x,
          current.y,
          isoScaleRef.current,
          box.width,
          box.height,
        ).toWorld(anchorX, anchorY)
        const floor = minIsoScaleForViewport(box.width, box.height)
        const nextScale = Math.min(MAX_ISO_SCALE, Math.max(floor, isoScaleRef.current * factor))
        if (nextScale === isoScaleRef.current) {
          return
        }
        isoScaleRef.current = nextScale
        const heldDzi = worldToDzi(held.x, held.y)
        const camera = dziToWorld(
          heldDzi.x - (anchorX - box.width / 2) / nextScale,
          heldDzi.y - (anchorY - box.height / 2) / nextScale,
        )
        setBoth(clamp({ x: camera.x, y: camera.y, scale: nextScale }))
        return
      }

      if (!map) {
        return
      }

      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor))
      if (scale === current.scale) {
        return
      }
      const worldX = current.x + (anchorX - box.width / 2) / current.scale
      const worldY = current.y + (anchorY - box.height / 2) / current.scale
      setBoth(
        clampView(
          {
            scale,
            x: worldX - (anchorX - box.width / 2) / scale,
            y: worldY - (anchorY - box.height / 2) / scale,
          },
          map,
        ),
      )
    },
    [clamp, map, setBoth],
  )

  useEffect(() => {
    const box = frame.current
    if (!box) {
      return
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      zoomAt(Math.pow(0.999, event.deltaY), event.clientX, event.clientY)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const gesture = useRef<{
    id: number
    startX: number
    startY: number
    lastX: number
    lastY: number
    dragged: boolean
    button: number
  } | null>(null)

  const localPoint = (clientX: number, clientY: number) => {
    const box = frame.current?.getBoundingClientRect()
    if (!box) {
      return null
    }
    return { x: clientX - box.left, y: clientY - box.top, width: box.width, height: box.height }
  }

  const mappingNow = (point: { width: number; height: number }): WorldMapping | null => {
    const current = viewRef.current
    if (!current) {
      return null
    }
    return mappingAt(current, point.width, point.height)
  }

  const pins = drawnMarkers

  const resolveHover = (clientX: number, clientY: number) => {
    const point = localPoint(clientX, clientY)
    const mapping = point ? mappingNow(point) : null
    if (!point || !mapping) {
      setHover(null)
      return
    }
    const hit = hitTestPins(mapping, pins, point.x, point.y)
    setHover(
      hit?.label
        ? { label: hit.label, health: hit.health, x: point.x, y: point.y }
        : null,
    )
  }

  const finishClick = (clientX: number, clientY: number, button: number) => {
    const point = localPoint(clientX, clientY)
    const mapping = point ? mappingNow(point) : null
    if (!point || !mapping) {
      return
    }
    const hit = hitTestPins(mapping, pins, point.x, point.y)
    if (hit?.id && button !== 2) {
      onSelect?.(hit.id)
      return
    }
    if (!onPick) {
      return
    }
    onPick(mapping.toWorld(point.x, point.y))
  }

  function selectMode(next: MapBasemap) {
    if (next === mode) {
      return
    }
    setIsoFellBack(false)
    modeRef.current = next
    window.localStorage.setItem(MODE_KEY, next)
    setMode(next)
    const current = viewRef.current
    const box = frame.current?.getBoundingClientRect()
    if (current && next === 'iso') {
      // Street-level only when we are already sitting on a survivor.
      // Otherwise keep the county in frame — 0.35 at the world centre puts
      // every pin off-screen.
      const scale = centred.current
        ? DEFAULT_ISO_SCALE
        : box
          ? fitIsoScale(box.width, box.height)
          : DEFAULT_ISO_SCALE
      isoScaleRef.current = scale
      setBoth({ ...current, scale })
    } else if (current && next === 'vector') {
      setBoth({ ...current, scale: initialScale ?? DEFAULT_SCALE })
    }
  }

  const waitingForVector = mode === 'vector' && map === null

  return (
    <div className={cn('relative overflow-hidden border border-fence bg-ash', className)}>
      <div
        ref={frame}
        className={cn(
          'absolute inset-0 touch-none',
          pickMode || paintMode || rectMode ? 'cursor-crosshair' : '',
        )}
        role="application"
        aria-label={t('map.canvas_label')}
        onContextMenu={(event) => {
          event.preventDefault()
          finishClick(event.clientX, event.clientY, 2)
        }}
        onPointerDown={(event) => {
          gesture.current = {
            id: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            lastX: event.clientX,
            lastY: event.clientY,
            dragged: false,
            button: event.button,
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          if (paintMode && event.button === 0) {
            const point = localPoint(event.clientX, event.clientY)
            const mapping = point ? mappingNow(point) : null
            if (point && mapping) {
              const world = mapping.toWorld(point.x, point.y)
              setPaintHover(world)
              onBrush?.(world, paintMode === 'erase')
            }
          }
          if (rectMode && event.button === 0) {
            const point = localPoint(event.clientX, event.clientY)
            const mapping = point ? mappingNow(point) : null
            if (point && mapping) {
              const world = mapping.toWorld(point.x, point.y)
              rectStart.current = world
              setDraftRect({ x1: world.x, y1: world.y, x2: world.x, y2: world.y })
            }
          }
        }}
        onPointerMove={(event) => {
          const held = gesture.current
          const current = viewRef.current
          const box = frame.current?.getBoundingClientRect()

          if (!held || held.id !== event.pointerId) {
            resolveHover(event.clientX, event.clientY)
            if (paintMode) {
              const point = localPoint(event.clientX, event.clientY)
              const mapping = point ? mappingNow(point) : null
              setPaintHover(point && mapping ? mapping.toWorld(point.x, point.y) : null)
            }
            return
          }

          const distance = Math.hypot(event.clientX - held.startX, event.clientY - held.startY)
          if (distance > DRAG_SLOP) {
            held.dragged = true
          }

          if (paintMode && held.button === 0) {
            const point = localPoint(event.clientX, event.clientY)
            const mapping = point ? mappingNow(point) : null
            if (point && mapping) {
              const world = mapping.toWorld(point.x, point.y)
              setPaintHover(world)
              onBrush?.(world, paintMode === 'erase')
            }
            held.lastX = event.clientX
            held.lastY = event.clientY
            return
          }

          if (rectMode && held.button === 0 && rectStart.current) {
            const point = localPoint(event.clientX, event.clientY)
            const mapping = point ? mappingNow(point) : null
            if (point && mapping) {
              const world = mapping.toWorld(point.x, point.y)
              setDraftRect({
                x1: rectStart.current.x,
                y1: rectStart.current.y,
                x2: world.x,
                y2: world.y,
              })
            }
            held.lastX = event.clientX
            held.lastY = event.clientY
            return
          }

          if (!held.dragged || held.button === 2 || !current || !box) {
            return
          }

          const dx = event.clientX - held.lastX
          const dy = event.clientY - held.lastY

          if (modeRef.current === 'iso') {
            const center = worldToDzi(current.x, current.y)
            const next = dziToWorld(
              center.x - dx / isoScaleRef.current,
              center.y - dy / isoScaleRef.current,
            )
            setBoth(clamp({ x: next.x, y: next.y, scale: isoScaleRef.current }))
          } else if (map) {
            setBoth(
              clampView(
                {
                  ...current,
                  x: current.x - dx / current.scale,
                  y: current.y - dy / current.scale,
                },
                map,
              ),
            )
          }

          held.lastX = event.clientX
          held.lastY = event.clientY
          setHover(null)
        }}
        onPointerUp={(event) => {
          const held = gesture.current
          gesture.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
          if (rectMode && held?.button === 0) {
            const start = rectStart.current
            rectStart.current = null
            setDraftRect(null)
            const point = localPoint(event.clientX, event.clientY)
            const mapping = point ? mappingNow(point) : null
            if (held.dragged && start && point && mapping) {
              const world = mapping.toWorld(point.x, point.y)
              onRect?.({
                x1: Math.round(Math.min(start.x, world.x)),
                y1: Math.round(Math.min(start.y, world.y)),
                x2: Math.round(Math.max(start.x, world.x)),
                y2: Math.round(Math.max(start.y, world.y)),
              })
            }
            return
          }
          if (!held || held.dragged || held.button === 2) {
            return
          }
          finishClick(event.clientX, event.clientY, held.button)
        }}
        onPointerCancel={() => {
          gesture.current = null
          rectStart.current = null
          setDraftRect(null)
          setHover(null)
          setPaintHover(null)
        }}
        onPointerLeave={() => {
          if (!gesture.current) {
            setHover(null)
            setPaintHover(null)
          }
        }}
      >
        <canvas
          ref={canvas}
          className={cn(
            'block',
            pickMode || paintMode ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing',
          )}
        />
      </div>

      {hover ? (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 border border-fence bg-void/90 px-2 py-1 font-mono text-[0.6875rem] text-bone"
          style={{ left: hover.x + 14, top: hover.y - 14 }}
        >
          <span>{hover.label}</span>
          {hover.health !== undefined && hover.health !== null ? (
            <span className="ml-2 text-dust">{Math.round(hover.health)}%</span>
          ) : null}
        </div>
      ) : null}

      {waitingForVector ? (
        <div className="absolute inset-0 grid place-items-center bg-ash">
          {failed ? (
            <p className="px-6 text-center text-sm text-dust">{t('map.load_failed')}</p>
          ) : (
            <Loader2
              aria-label={t('common.loading')}
              className="size-6 animate-spin text-dust"
              strokeWidth={1.5}
            />
          )}
        </div>
      ) : null}

      {ISO_BASEMAP ? (
        <div
          className="absolute bottom-3 left-3 flex border border-fence-bright bg-void/85"
          role="group"
          aria-label={t('map.modes')}
        >
          <ModeButton
            active={mode === 'iso'}
            disabled={isoTiles.unreachable}
            label={t('map.mode_iso')}
            onClick={() => selectMode('iso')}
          />
          <ModeButton
            active={mode === 'vector'}
            label={t('map.mode_vector')}
            onClick={() => selectMode('vector')}
          />
        </div>
      ) : null}

      <div className="absolute top-3 right-3 flex flex-col gap-1">
        <Control label={t('map.zoom_in')} onClick={() => zoomAt(1.5)} icon={Plus} />
        <Control label={t('map.zoom_out')} onClick={() => zoomAt(1 / 1.5)} icon={Minus} />
        <Control label={t('map.recentre')} onClick={reset} icon={Maximize2} />
      </div>

      <div className="pointer-events-none absolute right-3 bottom-3 max-w-[min(24rem,70%)] text-right font-mono text-[0.625rem] leading-snug">
        {isoFellBack ? <p className="text-hazard">{t('map.iso_unavailable')}</p> : null}
        <p className="text-dust">
          {mode === 'iso' ? t('map.attribution_iso') : t('map.attribution')}
        </p>
      </div>
    </div>
  )
}

function ModeButton({
  active,
  disabled = false,
  label,
  onClick,
}: {
  active: boolean
  disabled?: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1.5 font-mono text-[0.6875rem] tracking-widest uppercase',
        active ? 'bg-hazard-soft text-hazard' : 'text-dust hover:text-bone',
        disabled ? 'cursor-not-allowed opacity-40 hover:text-dust' : '',
      )}
    >
      <BoxSelect aria-hidden="true" className="size-3" />
      {label}
    </button>
  )
}

function Control({
  label,
  onClick,
  icon: Icon,
}: {
  label: string
  onClick: () => void
  icon: typeof Plus
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-8 place-items-center border border-fence-bright bg-void/85 text-smoke transition-colors hover:border-hazard hover:text-hazard"
    >
      <Icon aria-hidden="true" className="size-4" strokeWidth={1.5} />
    </button>
  )
}
