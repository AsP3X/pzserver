import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Maximize2, Minus, Plus } from 'lucide-react'

import { cn } from '@/lib/cn'
import {
  clampView,
  drawWorldmap,
  fitScale,
  loadWorldmap,
  type View,
  type Worldmap,
} from '@/lib/worldmap'
import { useTranslation } from '@/i18n/use-translation'

interface WorldmapViewProps {
  /** Where to put the pin, in world coordinates. */
  marker?: { x: number; y: number } | null
  /** Scale to open at, in pixels per world unit. Omitted means "fit". */
  initialScale?: number
  className?: string
}

/**
 * Bounds on how far in and out the map goes, in pixels per world unit.
 *
 * The ceiling is set well past the pack's highest `minZ` (railways, at zoom
 * 0.5) so every layer it carries can actually be reached; stopping at the
 * threshold would mean a layer that only ever half-appears.
 */
const MIN_SCALE = 0.01
const MAX_SCALE = 4

/**
 * Where a marked map opens, in pixels per world unit.
 *
 * Zoom -0.5, which is the first level that draws building footprints. Opening
 * wider is a green field with a dot on it: "where am I" is answered by the
 * street you are standing in, not by the county.
 */
const DEFAULT_SCALE = 0.71

/**
 * The basemap, pannable and zoomable.
 *
 * Redrawn on demand rather than on a loop: the map only changes when the view
 * does, and a canvas repainting sixty times a second to show the same picture
 * is a warm phone for nothing. Pointer events cover mouse and touch in one
 * path, so dragging works the same on both without a gesture library.
 */
export function WorldmapView({ marker, initialScale, className }: WorldmapViewProps) {
  const { t } = useTranslation()

  const canvas = useRef<HTMLCanvasElement>(null)
  const frame = useRef<HTMLDivElement>(null)

  const [map, setMap] = useState<Worldmap | null>(null)
  const [failed, setFailed] = useState(false)
  const [view, setView] = useState<View | null>(null)

  // Held in a ref as well as state: the pointer handlers need the current view
  // without being torn down and rebuilt on every frame of a drag.
  const viewRef = useRef<View | null>(null)
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

  /** Whether the camera has ever been put on a marker. */
  const centred = useRef(false)

  /** Centre on the marker, or on the whole world when there is nothing to point at. */
  const reset = useCallback(() => {
    const box = frame.current?.getBoundingClientRect()
    if (!map || !box) {
      return
    }

    const fit = fitScale(map.bounds, box.width, box.height)
    const [minX, minY, maxX, maxY] = map.bounds

    centred.current = marker !== null && marker !== undefined

    setBoth(
      marker
        ? { x: marker.x, y: marker.y, scale: initialScale ?? DEFAULT_SCALE }
        : { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale: fit },
    )
  }, [map, marker, initialScale, setBoth])

  useEffect(() => {
    if (!map) {
      return
    }

    // First view once the pack and the box are both known.
    if (!viewRef.current) {
      reset()

      return
    }

    // A position that lands after the map opened — the player joined the
    // server while this was on screen — is worth moving to once. Only once:
    // the position refreshes every thirty seconds, and snapping the camera
    // back each time would fight anyone reading the next street over.
    if (marker && !centred.current) {
      reset()
    }
  }, [map, marker, reset])

  // Paint whenever the view, the marker or the box changes.
  useEffect(() => {
    const element = canvas.current
    const box = frame.current

    if (!element || !box || !map || !view) {
      return
    }

    const paint = () => {
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
      drawWorldmap(ctx, map, view, {
        width: rect.width,
        height: rect.height,
        marker,
        markerColor: '#ffb000',
      })
    }

    paint()

    const observer = new ResizeObserver(paint)
    observer.observe(box)

    return () => observer.disconnect()
  }, [map, view, marker])

  /** Zoom about a point on the canvas, so the world under the cursor stays put. */
  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const current = viewRef.current
      const box = frame.current?.getBoundingClientRect()

      if (!current || !map || !box) {
        return
      }

      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor))
      if (scale === current.scale) {
        return
      }

      // Anchor on the pointer when there is one, otherwise on the centre.
      const anchorX = clientX === undefined ? box.width / 2 : clientX - box.left
      const anchorY = clientY === undefined ? box.height / 2 : clientY - box.top

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
    [map, setBoth],
  )

  // Wheel is bound by hand rather than through onWheel: React attaches its
  // listener passively, and a passive listener cannot preventDefault, so the
  // page scrolls away underneath the map while you are trying to zoom it.
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

  const drag = useRef<{ id: number; x: number; y: number } | null>(null)

  return (
    <div className={cn('relative overflow-hidden border border-fence bg-ash', className)}>
      <div
        ref={frame}
        className="absolute inset-0 touch-none"
        role="application"
        aria-label={t('map.canvas_label')}
        onPointerDown={(event) => {
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const held = drag.current
          const current = viewRef.current

          if (!held || held.id !== event.pointerId || !current || !map) {
            return
          }

          setBoth(
            clampView(
              {
                ...current,
                x: current.x - (event.clientX - held.x) / current.scale,
                y: current.y - (event.clientY - held.y) / current.scale,
              },
              map,
            ),
          )

          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
        }}
        onPointerUp={(event) => {
          drag.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        <canvas ref={canvas} className="block cursor-grab active:cursor-grabbing" />
      </div>

      {map === null ? (
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

      <div className="absolute top-3 right-3 flex flex-col gap-1">
        <Control label={t('map.zoom_in')} onClick={() => zoomAt(1.5)} icon={Plus} />
        <Control label={t('map.zoom_out')} onClick={() => zoomAt(1 / 1.5)} icon={Minus} />
        <Control label={t('map.recentre')} onClick={reset} icon={Maximize2} />
      </div>
    </div>
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
