import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FormError, TextAreaField } from '@/components/ui/field'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  NODE_H,
  NODE_W,
  emptyGraph,
  port,
  uid,
  wirePath,
  type GraphNode,
  type GraphNodeType,
  type QuestGraph,
} from '@/lib/quest-graph'
import { adminGroupsQuery, adminQuestQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'
import { AreaEditor } from '@/routes/admin/area-editor'

const PALETTE: { type: GraphNodeType; label: TranslationKey }[] = [
  { type: 'start', label: 'economy.flow_start' },
  { type: 'stage', label: 'economy.flow_stage' },
  { type: 'area', label: 'economy.flow_area' },
  { type: 'find', label: 'economy.flow_find' },
  { type: 'collect', label: 'economy.flow_collect' },
  { type: 'kills', label: 'economy.flow_kills' },
  { type: 'task', label: 'economy.flow_task' },
  { type: 'objective', label: 'economy.flow_objective' },
  { type: 'reward', label: 'economy.flow_reward' },
  { type: 'end', label: 'economy.flow_end' },
]

const MEASURES: { id: string; label: TranslationKey }[] = [
  { id: 'play', label: 'economy.objective_kind_play' },
  { id: 'kills', label: 'economy.objective_kind_kills' },
  { id: 'hours', label: 'economy.objective_kind_hours' },
  { id: 'spend', label: 'economy.objective_kind_spend' },
  { id: 'trade', label: 'economy.objective_kind_trade' },
  { id: 'manual', label: 'economy.objective_kind_manual' },
]

const AUDIENCES: { id: string; label: TranslationKey }[] = [
  { id: 'all', label: 'economy.flow_audience_all' },
  { id: 'players', label: 'economy.flow_audience_players' },
  { id: 'group', label: 'economy.flow_audience_group' },
  { id: 'claimable', label: 'economy.flow_audience_claimable' },
]

/**
 * Unreal-style exec graph: drag nodes, pull a wire from the right pin.
 */
export function AdminQuestEditorPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { questId } = useParams({ strict: false }) as { questId: string }
  const quest = useQuery(adminQuestQuery(questId))
  const groups = useQuery(adminGroupsQuery)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [audience, setAudience] = useState('all')
  const [usernames, setUsernames] = useState('')
  const [groupId, setGroupId] = useState('')
  const [active, setActive] = useState(false)
  const [graph, setGraph] = useState<QuestGraph>(emptyGraph())
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const loaded = useRef<string | null>(null)

  useEffect(() => {
    if (!quest.data || loaded.current === quest.data.id) {
      return
    }
    loaded.current = quest.data.id
    setTitle(quest.data.title)
    setDescription(quest.data.description ?? '')
    setAudience(quest.data.audience)
    setUsernames(quest.data.audience_usernames.join(', '))
    setGroupId(quest.data.audience_group_id ?? '')
    setActive(quest.data.active)
    setGraph(quest.data.graph.nodes.length > 0 ? quest.data.graph : emptyGraph())
  }, [quest.data])

  const save = useMutation({
    mutationFn: () =>
      api.adminUpdateQuest(questId, {
        title,
        description: description || null,
        audience,
        audience_usernames: usernames
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
        audience_group_id: audience === 'group' && groupId ? groupId : null,
        active,
        graph,
      }),
    onSuccess: async () => {
      setNotice(t('economy.saved'))
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['admin', 'quests'] })
    },
    onError: (cause) => {
      setNotice(null)
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  const current = graph.nodes.find((node) => node.id === selected) ?? null

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-fence px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/admin/quests"
            className="font-mono text-[0.6875rem] tracking-widest text-dust uppercase hover:text-hazard"
          >
            {t('economy.flows_title')}
          </Link>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="display min-w-0 border border-transparent bg-transparent text-xl text-bone focus:border-hazard"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-bone">
            <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
            {t('economy.active')}
          </label>
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </div>
      </header>

      {notice ? (
        <p role="status" className="mx-4 mt-3 border border-moss/40 bg-moss-soft px-3 py-2 text-sm text-moss">
          {notice}
        </p>
      ) : null}
      {error ? (
        <div className="px-4 pt-3">
          <FormError>{error}</FormError>
        </div>
      ) : null}

      {quest.isPending ? (
        <p className="p-5 text-sm text-dust">{t('common.saving')}</p>
      ) : (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[11rem_minmax(0,1fr)_18rem]">
          <aside className="flex flex-col gap-1 overflow-y-auto border-r border-fence p-3">
            <p className="eyebrow mb-2">{t('economy.flow_palette')}</p>
            {PALETTE.map((item) => (
              <button
                key={item.type}
                type="button"
                onClick={() =>
                  setGraph((current) => ({
                    ...current,
                    nodes: [
                      ...current.nodes,
                      {
                        id: uid(item.type),
                        type: item.type,
                        x: 220 + current.nodes.length * 8,
                        y: 140 + current.nodes.length * 12,
                        title: t(item.label),
                        data: defaultData(item.type),
                      },
                    ],
                  }))
                }
                className="border border-fence px-2 py-2 text-left font-mono text-[0.6875rem] uppercase text-smoke hover:border-hazard hover:text-hazard"
              >
                {t(item.label)}
              </button>
            ))}
          </aside>

          <GraphCanvas
            graph={graph}
            selected={selected}
            onSelect={setSelected}
            onChange={setGraph}
          />

          <aside className="overflow-y-auto border-l border-fence p-4">
            <p className="eyebrow mb-3">{t('economy.flow_inspector')}</p>
            <div className="mb-5 flex flex-col gap-3">
              <TextAreaField
                label={t('economy.objective_brief')}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="min-h-16"
              />
              <fieldset>
                <legend className="mb-2 font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
                  {t('economy.flow_audience')}
                </legend>
                <div className="flex flex-col gap-1">
                  {AUDIENCES.map((item) => (
                    <label key={item.id} className="flex items-center gap-2 text-sm text-bone">
                      <input
                        type="radio"
                        name="audience"
                        checked={audience === item.id}
                        onChange={() => setAudience(item.id)}
                      />
                      {t(item.label)}
                    </label>
                  ))}
                </div>
              </fieldset>
              {audience === 'players' ? (
                <Field
                  label={t('economy.flow_usernames')}
                  value={usernames}
                  onChange={(event) => setUsernames(event.target.value)}
                />
              ) : null}
              {audience === 'group' ? (
                <label className="flex flex-col gap-2">
                  <span className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
                    {t('economy.flow_group')}
                  </span>
                  <select
                    value={groupId}
                    onChange={(event) => setGroupId(event.target.value)}
                    className="h-12 border border-fence-bright bg-void px-3 font-mono text-sm text-bone"
                  >
                    <option value="">{t('common.none_found')}</option>
                    {(groups.data ?? []).map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {audience === 'claimable' ? (
                <p className="text-xs text-dust">{t('economy.flow_claimable_later')}</p>
              ) : null}
            </div>

            {current ? (
              <NodeInspector
                node={current}
                onChange={(next) =>
                  setGraph((graph) => ({
                    ...graph,
                    nodes: graph.nodes.map((item) => (item.id === next.id ? next : item)),
                  }))
                }
                onDelete={() => {
                  setGraph((graph) => ({
                    nodes: graph.nodes.filter((item) => item.id !== current.id),
                    edges: graph.edges.filter((edge) => edge.from !== current.id && edge.to !== current.id),
                  }))
                  setSelected(null)
                }}
              />
            ) : (
              <p className="text-sm text-dust">{t('economy.flow_pick_node')}</p>
            )}
          </aside>
        </div>
      )}
    </section>
  )
}

function GraphCanvas({
  graph,
  selected,
  onSelect,
  onChange,
}: {
  graph: QuestGraph
  selected: string | null
  onSelect: (id: string | null) => void
  onChange: (graph: QuestGraph) => void
}) {
  const { t } = useTranslation()
  const board = useRef<HTMLDivElement>(null)
  const [pan, setPan] = useState({ x: 24, y: 24 })
  const [zoom, setZoom] = useState(1)
  const drag = useRef<
    | { kind: 'pan'; x: number; y: number; ox: number; oy: number }
    | { kind: 'node'; id: string; x: number; y: number; ox: number; oy: number }
    | { kind: 'wire'; from: string }
    | null
  >(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

  const world = useMemo(() => {
    let maxX = 800
    let maxY = 500
    for (const node of graph.nodes) {
      maxX = Math.max(maxX, node.x + NODE_W + 120)
      maxY = Math.max(maxY, node.y + NODE_H + 120)
    }
    return { maxX, maxY }
  }, [graph.nodes])

  function local(event: { clientX: number; clientY: number }) {
    const box = board.current?.getBoundingClientRect()
    if (!box) {
      return { x: 0, y: 0 }
    }
    return {
      x: (event.clientX - box.left - pan.x) / zoom,
      y: (event.clientY - box.top - pan.y) / zoom,
    }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    const pin = target.closest('[data-pin]')?.getAttribute('data-pin')
    const nodeId = target.closest('[data-node]')?.getAttribute('data-node')

    if (pin && nodeId) {
      drag.current = { kind: 'wire', from: nodeId }
      onSelect(nodeId)
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    if (nodeId) {
      const node = graph.nodes.find((item) => item.id === nodeId)
      if (!node) {
        return
      }
      const point = local(event)
      drag.current = { kind: 'node', id: nodeId, x: point.x, y: point.y, ox: node.x, oy: node.y }
      onSelect(nodeId)
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    drag.current = { kind: 'pan', x: event.clientX, y: event.clientY, ox: pan.x, oy: pan.y }
    onSelect(null)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const point = local(event)
    setCursor(point)
    const current = drag.current
    if (!current) {
      return
    }
    if (current.kind === 'pan') {
      setPan({ x: current.ox + (event.clientX - current.x), y: current.oy + (event.clientY - current.y) })
    } else if (current.kind === 'node') {
      onChange({
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === current.id
            ? {
                ...node,
                x: current.ox + (point.x - current.x),
                y: current.oy + (point.y - current.y),
              }
            : node,
        ),
      })
    }
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current
    drag.current = null
    setCursor(null)
    if (current?.kind !== 'wire') {
      return
    }
    const target = document.elementFromPoint(event.clientX, event.clientY)
    const to = target?.closest('[data-node]')?.getAttribute('data-node')
    if (!to || to === current.from) {
      return
    }
    if (graph.edges.some((edge) => edge.from === current.from && edge.to === to)) {
      return
    }
    onChange({
      ...graph,
      edges: [...graph.edges, { id: uid('e'), from: current.from, to }],
    })
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Delete' && event.key !== 'Backspace') {
        return
      }
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return
      }
      if (!selected) {
        return
      }
      event.preventDefault()
      onChange({
        nodes: graph.nodes.filter((node) => node.id !== selected),
        edges: graph.edges.filter((edge) => edge.from !== selected && edge.to !== selected),
      })
      onSelect(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [graph, onChange, onSelect, selected])

  const linking = drag.current?.kind === 'wire' ? drag.current.from : null

  return (
    <div
      ref={board}
      className="relative min-h-0 overflow-hidden bg-void"
      style={{
        backgroundImage:
          'linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px)',
        backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
        backgroundPosition: `${pan.x}px ${pan.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={(event) => {
        event.preventDefault()
        setZoom((value) => Math.min(1.6, Math.max(0.45, value + (event.deltaY > 0 ? -0.08 : 0.08))))
      }}
    >
      <div
        className="absolute origin-top-left"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, width: world.maxX, height: world.maxY }}
      >
        <svg className="pointer-events-none absolute inset-0" width={world.maxX} height={world.maxY}>
          {graph.edges.map((edge) => {
            const from = graph.nodes.find((node) => node.id === edge.from)
            const to = graph.nodes.find((node) => node.id === edge.to)
            if (!from || !to) {
              return null
            }
            return (
              <path
                key={edge.id}
                d={wirePath(port(from, 'out'), port(to, 'in'))}
                fill="none"
                stroke="var(--color-hazard, #e8a317)"
                strokeWidth={2}
                className="cursor-pointer"
              />
            )
          })}
          {linking && cursor
            ? (() => {
                const from = graph.nodes.find((node) => node.id === linking)
                if (!from) {
                  return null
                }
                return (
                  <path
                    d={wirePath(port(from, 'out'), cursor)}
                    fill="none"
                    stroke="var(--color-hazard, #e8a317)"
                    strokeWidth={2}
                    strokeDasharray="6 4"
                  />
                )
              })()
            : null}
        </svg>

        {graph.nodes.map((node) => (
          <article
            key={node.id}
            data-node={node.id}
            className={cn(
              'absolute border bg-ash select-none',
              selected === node.id ? 'border-hazard' : 'border-fence-bright',
            )}
            style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
          >
            <header className="flex items-center justify-between border-b border-fence px-2 py-1">
              <span className="font-mono text-[0.625rem] tracking-widest text-hazard uppercase">
                {node.type}
              </span>
            </header>
            <p className="truncate px-2 py-2 text-sm text-bone">{node.title || t('economy.flow_untitled')}</p>
            <span
              data-pin="out"
              className="absolute top-1/2 right-[-6px] size-3 -translate-y-1/2 border border-hazard bg-void"
            />
            <span className="absolute top-1/2 left-[-6px] size-3 -translate-y-1/2 border border-dust bg-void" />
          </article>
        ))}
      </div>
    </div>
  )
}

function defaultData(type: GraphNodeType): GraphNode['data'] {
  if (type === 'task') {
    return { measure: 'play', goal: 1, cadence: 'once', xp: 0, coins: 10 }
  }
  if (type === 'objective') {
    return { measure: 'play', goal: 1, cadence: 'once', xp: 50, coins: 0 }
  }
  if (type === 'reward') {
    return { xp: 25, coins: 0 }
  }
  if (type === 'area') {
    return { area_x: 10800, area_y: 9800, area_radius: 25, xp: 0, coins: 0 }
  }
  if (type === 'find') {
    return { item_type: 'Base.Axe', goal: 1, xp: 0, coins: 0 }
  }
  if (type === 'collect') {
    return { item_type: 'Base.Nails', goal: 20, xp: 0, coins: 0 }
  }
  if (type === 'kills') {
    return { goal: 10, xp: 0, coins: 0 }
  }
  return {}
}

function NodeInspector({
  node,
  onChange,
  onDelete,
}: {
  node: GraphNode
  onChange: (node: GraphNode) => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [mapOpen, setMapOpen] = useState(false)
  const measurable = node.type === 'task' || node.type === 'objective'
  const area = node.type === 'area'
  const item = node.type === 'find' || node.type === 'collect'
  const kills = node.type === 'kills'
  const payable = measurable || area || item || kills || node.type === 'reward'

  return (
    <div className="flex flex-col gap-3 border-t border-fence pt-4">
      <Field
        label={t('economy.item_name')}
        value={node.title}
        onChange={(event) => onChange({ ...node, title: event.target.value })}
      />
      {measurable || area || item || kills || node.type === 'stage' ? (
        <TextAreaField
          label={t('economy.objective_brief')}
          value={node.data.description ?? ''}
          onChange={(event) =>
            onChange({ ...node, data: { ...node.data, description: event.target.value } })
          }
          className="min-h-16"
        />
      ) : null}
      {measurable ? (
        <>
          <fieldset>
            <legend className="mb-2 font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
              {t('economy.objective_kind')}
            </legend>
            <div className="flex flex-wrap gap-1">
              {MEASURES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onChange({ ...node, data: { ...node.data, measure: item.id } })}
                  className={cn(
                    'border px-2 py-1 font-mono text-[0.625rem] uppercase',
                    node.data.measure === item.id
                      ? 'border-hazard bg-hazard-soft text-hazard'
                      : 'border-fence text-dust',
                  )}
                >
                  {t(item.label)}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-2">
            <Field
              type="number"
              min={1}
              label={t('economy.objective_goal')}
              value={node.data.goal ?? 1}
              onChange={(event) =>
                onChange({ ...node, data: { ...node.data, goal: Number(event.target.value) || 1 } })
              }
            />
            <label className="flex flex-col gap-2">
              <span className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
                {t('economy.objective_cadence')}
              </span>
              <select
                value={node.data.cadence ?? 'once'}
                onChange={(event) =>
                  onChange({ ...node, data: { ...node.data, cadence: event.target.value } })
                }
                className="h-12 border border-fence-bright bg-void px-3 font-mono text-sm text-bone"
              >
                <option value="once">{t('economy.objective_once')}</option>
                <option value="daily">{t('economy.objective_daily')}</option>
              </select>
            </label>
          </div>
        </>
      ) : null}
      {area ? (
        <>
          <Button size="sm" variant="outline" onClick={() => setMapOpen(true)}>
            {t('economy.flow_area_open')}
          </Button>
          {node.data.area_cells && node.data.area_cells.length > 0 ? (
            <p className="font-mono text-[0.6875rem] text-dust">
              {t('economy.flow_area_tiles', { count: node.data.area_cells.length })}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Field
              type="number"
              label={t('economy.flow_area_x')}
              value={node.data.area_x ?? ''}
              onChange={(event) =>
                onChange({
                  ...node,
                  data: { ...node.data, area_x: Number(event.target.value) || 0, area_cells: null },
                })
              }
            />
            <Field
              type="number"
              label={t('economy.flow_area_y')}
              value={node.data.area_y ?? ''}
              onChange={(event) =>
                onChange({
                  ...node,
                  data: { ...node.data, area_y: Number(event.target.value) || 0, area_cells: null },
                })
              }
            />
            <Field
              type="number"
              min={1}
              label={t('economy.flow_area_radius')}
              value={node.data.area_radius ?? 25}
              onChange={(event) =>
                onChange({
                  ...node,
                  data: { ...node.data, area_radius: Number(event.target.value) || 1, area_cells: null },
                })
              }
            />
            <Field
              type="number"
              label={t('economy.flow_area_z')}
              value={node.data.area_z ?? ''}
              onChange={(event) =>
                onChange({
                  ...node,
                  data: {
                    ...node.data,
                    area_z: event.target.value === '' ? null : Number(event.target.value),
                  },
                })
              }
            />
          </div>
          <AreaEditor
            open={mapOpen}
            data={node.data}
            onClose={() => setMapOpen(false)}
            onApply={(next) => onChange({ ...node, data: next })}
          />
        </>
      ) : null}
      {item ? (
        <div className="grid grid-cols-2 gap-2">
          <Field
            label={t('economy.item_type')}
            value={node.data.item_type ?? ''}
            onChange={(event) =>
              onChange({ ...node, data: { ...node.data, item_type: event.target.value } })
            }
          />
          {node.type === 'collect' ? (
            <Field
              type="number"
              min={1}
              label={t('economy.quantity')}
              value={node.data.goal ?? 1}
              onChange={(event) =>
                onChange({ ...node, data: { ...node.data, goal: Number(event.target.value) || 1 } })
              }
            />
          ) : null}
        </div>
      ) : null}
      {kills ? (
        <Field
          type="number"
          min={1}
          label={t('economy.flow_kill_count')}
          value={node.data.goal ?? 10}
          onChange={(event) =>
            onChange({ ...node, data: { ...node.data, goal: Number(event.target.value) || 1 } })
          }
        />
      ) : null}
      {payable ? (
        <div className="grid grid-cols-2 gap-2">
          <Field
            type="number"
            min={0}
            label={t('economy.xp_label')}
            value={node.data.xp ?? 0}
            onChange={(event) =>
              onChange({ ...node, data: { ...node.data, xp: Number(event.target.value) || 0 } })
            }
          />
          <Field
            type="number"
            min={0}
            label={t('economy.price')}
            value={node.data.coins ?? 0}
            onChange={(event) =>
              onChange({ ...node, data: { ...node.data, coins: Number(event.target.value) || 0 } })
            }
          />
        </div>
      ) : null}
      {node.type !== 'start' ? (
        <Button size="sm" variant="outline" className="border-blood text-blood" onClick={onDelete}>
          {t('common.delete')}
        </Button>
      ) : null}
    </div>
  )
}
