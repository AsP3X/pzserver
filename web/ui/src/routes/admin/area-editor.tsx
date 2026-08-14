import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { WorldmapView, type MapFocus } from '@/components/ui/worldmap'
import { cn } from '@/lib/cn'
import { useTranslation } from '@/i18n/use-translation'
import type { GraphNodeData } from '@/lib/quest-graph'

export const AREA_CELL = 16
const MAX_CELLS = 4_000

const BRUSHES = [1, 2, 3, 5]

export function circleToCells(x: number, y: number, radius: number, size = AREA_CELL): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = []
  const minX = Math.floor((x - radius) / size)
  const maxX = Math.floor((x + radius) / size)
  const minY = Math.floor((y - radius) / size)
  const maxY = Math.floor((y + radius) / size)
  const r2 = radius * radius
  for (let cx = minX; cx <= maxX; cx += 1) {
    for (let cy = minY; cy <= maxY; cy += 1) {
      const mx = (cx + 0.5) * size
      const my = (cy + 0.5) * size
      if ((mx - x) * (mx - x) + (my - y) * (my - y) <= r2) {
        cells.push({ x: cx, y: cy })
      }
    }
  }
  return cells
}

export function boundsOf(cells: { x: number; y: number }[], size = AREA_CELL) {
  if (cells.length === 0) {
    return { x: 10800, y: 9800, radius: 25 }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const cell of cells) {
    minX = Math.min(minX, cell.x * size)
    minY = Math.min(minY, cell.y * size)
    maxX = Math.max(maxX, (cell.x + 1) * size)
    maxY = Math.max(maxY, (cell.y + 1) * size)
  }
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    radius: Math.max(8, Math.hypot(maxX - minX, maxY - minY) / 2),
  }
}

function cellsAround(world: { x: number; y: number }, brush: number, size: number): { x: number; y: number }[] {
  const originX = Math.floor(world.x / size)
  const originY = Math.floor(world.y / size)
  const reach = Math.max(0, brush - 1)
  const out: { x: number; y: number }[] = []
  for (let dx = -reach; dx <= reach; dx += 1) {
    for (let dy = -reach; dy <= reach; dy += 1) {
      if (dx * dx + dy * dy <= reach * reach) {
        out.push({ x: originX + dx, y: originY + dy })
      }
    }
  }
  return out
}

function keyOf(cell: { x: number; y: number }): string {
  return `${cell.x},${cell.y}`
}

/**
 * Paint a district on the Knox map, the way a city-builder marks a service zone.
 */
export function AreaEditor({
  open,
  data,
  onApply,
  onClose,
}: {
  open: boolean
  data: GraphNodeData
  onApply: (next: GraphNodeData) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [tool, setTool] = useState<'paint' | 'erase'>('paint')
  const [brush, setBrush] = useState(2)
  const [cells, setCells] = useState<Map<string, { x: number; y: number }>>(() => new Map())
  const [focus, setFocus] = useState<MapFocus | null>(null)

  useEffect(() => {
    const element = dialog.current
    if (!element) {
      return
    }
    if (open && !element.open) {
      element.showModal()
    } else if (!open && element.open) {
      element.close()
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }
    const next = new Map<string, { x: number; y: number }>()
    if (data.area_cells && data.area_cells.length > 0) {
      for (const cell of data.area_cells) {
        next.set(keyOf(cell), cell)
      }
    } else if (data.area_x != null && data.area_y != null && (data.area_radius ?? 0) >= 1) {
      for (const cell of circleToCells(data.area_x, data.area_y, data.area_radius ?? 25)) {
        next.set(keyOf(cell), cell)
      }
    }
    setCells(next)
    setFocus({
      x: data.area_x ?? 10800,
      y: data.area_y ?? 9800,
      token: Date.now(),
    })
    setTool('paint')
  }, [data, open])

  const list = useMemo(() => [...cells.values()], [cells])

  function paint(world: { x: number; y: number }, erase: boolean) {
    setCells((current) => {
      const next = new Map(current)
      for (const cell of cellsAround(world, brush, AREA_CELL)) {
        const key = keyOf(cell)
        if (erase) {
          next.delete(key)
        } else if (next.size < MAX_CELLS) {
          next.set(key, cell)
        }
      }
      return next
    })
  }

  function apply() {
    const painted = [...cells.values()]
    const bounds = boundsOf(painted)
    onApply({
      ...data,
      area_cells: painted,
      area_cell_size: AREA_CELL,
      area_x: bounds.x,
      area_y: bounds.y,
      area_radius: bounds.radius,
    })
    onClose()
  }

  if (!open) {
    return null
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className="m-auto h-[min(52rem,calc(100vh-1.5rem))] w-[min(72rem,calc(100vw-1.5rem))] border border-fence-bright bg-ash p-0 text-bone backdrop:bg-void/80 open:flex open:flex-col"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={() => {
        if (open) {
          onClose()
        }
      }}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-fence px-4 py-3">
        <div>
          <h2 id={titleId} className="display text-xl text-bone">
            {t('economy.flow_area_editor')}
          </h2>
          <p className="mt-1 text-xs text-dust">{t('economy.flow_area_editor_hint')}</p>
        </div>
        <span className="font-mono text-[0.6875rem] text-dust">
          {t('economy.flow_area_tiles', { count: list.length })}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-44 shrink-0 flex-col gap-3 border-r border-fence p-3">
          <fieldset>
            <legend className="mb-2 font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
              {t('economy.flow_area_tool')}
            </legend>
            <div className="flex flex-col gap-1">
              <ToolChip
                active={tool === 'paint'}
                label={t('economy.flow_area_paint')}
                onClick={() => setTool('paint')}
              />
              <ToolChip
                active={tool === 'erase'}
                label={t('economy.flow_area_erase')}
                onClick={() => setTool('erase')}
              />
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-2 font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
              {t('economy.flow_area_brush')}
            </legend>
            <div className="flex flex-wrap gap-1">
              {BRUSHES.map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => setBrush(size)}
                  className={cn(
                    'border px-2 py-1 font-mono text-[0.6875rem]',
                    brush === size
                      ? 'border-hazard bg-hazard-soft text-hazard'
                      : 'border-fence text-dust',
                  )}
                >
                  {size}
                </button>
              ))}
            </div>
          </fieldset>
          <Button size="sm" variant="outline" onClick={() => setCells(new Map())}>
            {t('economy.flow_area_clear')}
          </Button>
          <p className="text-[0.6875rem] leading-relaxed text-dust">{t('economy.flow_area_pan')}</p>
        </aside>

        <div className="relative min-h-0 min-w-0 flex-1">
          <WorldmapView
            className="absolute inset-0 border-0"
            paintMode={tool}
            brushRadius={(brush - 1) * AREA_CELL}
            zones={[{ cells: list, cellSize: AREA_CELL }]}
            focus={focus}
            onBrush={paint}
          />
          <div className="pointer-events-none absolute top-3 left-3 z-10 flex flex-col gap-1 border border-fence-bright bg-void/90 px-2.5 py-2 font-mono text-[0.6875rem] text-bone">
            <span className="tracking-widest text-dust uppercase">{t('economy.flow_area_legend')}</span>
            <span className="flex items-center gap-2">
              <span aria-hidden="true" className="size-3 shrink-0 border border-[#ff9af5] bg-[rgba(214,48,255,0.7)]" />
              {t('economy.flow_area_legend_painted')}
            </span>
            <span className="flex items-center gap-2">
              <span aria-hidden="true" className="size-3 shrink-0 border border-fence bg-[#3a3d32]" />
              {t('economy.flow_area_legend_clear')}
            </span>
          </div>
        </div>
      </div>

      <footer className="flex shrink-0 justify-end gap-2 border-t border-fence px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" disabled={list.length === 0} onClick={apply}>
          {t('economy.flow_area_apply')}
        </Button>
      </footer>
    </dialog>
  )
}

function ToolChip({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'border px-2 py-1.5 text-left font-mono text-[0.6875rem] uppercase',
        active ? 'border-hazard bg-hazard-soft text-hazard' : 'border-fence text-dust',
      )}
    >
      {label}
    </button>
  )
}
