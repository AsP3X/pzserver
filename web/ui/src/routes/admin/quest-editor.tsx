import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Crosshair,
  Maximize2,
  Minus,
  Plus,
  Redo2,
  TriangleAlert,
  Trash2,
  Undo2,
  Wand2,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FormError, TextAreaField } from '@/components/ui/field'
import { TabPanel, TabStrip } from '@/components/ui/tabs'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  CATEGORY_LABELS,
  GRID,
  MEASURE_LABELS,
  NODE_H,
  NODE_KINDS,
  NODE_W,
  autoLayout,
  checkGraph,
  defaultData,
  emptyGraph,
  graphBounds,
  kindOf,
  payoutOf,
  playerSteps,
  port,
  snap,
  summarise,
  totalPayout,
  uid,
  wireBox,
  wireMid,
  wirePath,
  type GraphNode,
  type GraphNodeType,
  type GraphProblem,
  type NodeCategory,
  type QuestGraph,
  isCondition,
} from '@/lib/quest-graph'
import { adminGroupsQuery, adminQuestQuery } from '@/lib/queries'
import { useTranslation } from '@/i18n/use-translation'
import type { TranslationKey } from '@/i18n/locales'
import { AreaEditor } from '@/routes/admin/area-editor'

const AUDIENCES: { id: string; label: TranslationKey }[] = [
  { id: 'all', label: 'economy.flow_audience_all' },
  { id: 'players', label: 'economy.flow_audience_players' },
  { id: 'group', label: 'economy.flow_audience_group' },
  { id: 'claimable', label: 'economy.flow_audience_claimable' },
]

/** Flow control is quiet, gates are the amber the eye follows, payouts are green. */
const TONES: Record<NodeCategory, { bar: string; text: string; border: string }> = {
  flow: { bar: 'bg-smoke', text: 'text-smoke', border: 'border-fence-bright' },
  gate: { bar: 'bg-hazard', text: 'text-hazard', border: 'border-hazard/35' },
  payout: { bar: 'bg-moss', text: 'text-moss', border: 'border-moss/35' },
}

const ZOOM_MIN = 0.3
const ZOOM_MAX = 1.6

/** Breathing room around the wire layer, so a stroke never ends on its edge. */
const MARGIN = 64

type Selection = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null

interface View {
  x: number
  y: number
  zoom: number
}

/**
 * The flow board: a graph of gates a player walks left to right.
 *
 * The board is only half the tool. The other half is the checks strip, which
 * runs the server's own rules — plus the traps it accepts — while you draw,
 * so a flow is never saved with a step nothing can ever finish.
 */
export function AdminQuestEditorPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
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
  const graph = useHistory<QuestGraph>(emptyGraph())
  const [selection, setSelection] = useState<Selection>(null)
  const [tab, setTab] = useState<'node' | 'flow'>('node')
  const [view, setView] = useState<View>({ x: 48, y: 48, zoom: 1 })
  const [problemsOpen, setProblemsOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [saved, setSaved] = useState('')
  const board = useRef<HTMLDivElement>(null)
  const loaded = useRef<string | null>(null)

  const value = graph.value
  const { reset, set: change, checkpoint, undo, redo } = graph
  const problems = useMemo(() => checkGraph(value), [value])
  const errors = problems.filter((problem) => problem.level === 'error')
  const flags = useMemo(() => {
    const map = new Map<string, GraphProblem['level']>()
    for (const problem of problems) {
      if (problem.nodeId && (problem.level === 'error' || !map.has(problem.nodeId))) {
        map.set(problem.nodeId, problem.level)
      }
    }
    return map
  }, [problems])

  const draft = useMemo(
    () => JSON.stringify({ title, description, audience, usernames, groupId, active, graph: value }),
    [active, audience, description, groupId, title, usernames, value],
  )
  const dirty = saved.length > 0 && draft !== saved

  /** Frame a whole graph in the board, never magnified past 1:1. */
  const fitTo: (target: QuestGraph, attempt?: number) => void = useCallback((target, attempt = 0) => {
    const box = board.current?.getBoundingClientRect()
    if (!box || target.nodes.length === 0) {
      return
    }
    // On the frame the editor first paints, the board is still a zero-height
    // box. Framing against that puts the whole graph off the top-left corner.
    if ((box.width < 120 || box.height < 120) && attempt < 10) {
      requestAnimationFrame(() => fitTo(target, attempt + 1))
      return
    }
    const bounds = graphBounds(target)
    const zoom = Math.min(
      1,
      Math.max(ZOOM_MIN, Math.min((box.width - 96) / bounds.width, (box.height - 96) / bounds.height)),
    )
    setView({
      zoom,
      x: box.width / 2 - (bounds.x + bounds.width / 2) * zoom,
      y: box.height / 2 - (bounds.y + bounds.height / 2) * zoom,
    })
  }, [])

  const fit = useCallback(() => fitTo(value), [fitTo, value])

  useEffect(() => {
    if (!quest.data || loaded.current === quest.data.id) {
      return
    }
    loaded.current = quest.data.id
    const next = quest.data.graph.nodes.length > 0 ? quest.data.graph : emptyGraph()
    setTitle(quest.data.title)
    setDescription(quest.data.description ?? '')
    setAudience(quest.data.audience)
    setUsernames(quest.data.audience_usernames.join(', '))
    setGroupId(quest.data.audience_group_id ?? '')
    setActive(quest.data.active)
    reset(next)
    setSaved(
      JSON.stringify({
        title: quest.data.title,
        description: quest.data.description ?? '',
        audience: quest.data.audience,
        usernames: quest.data.audience_usernames.join(', '),
        groupId: quest.data.audience_group_id ?? '',
        active: quest.data.active,
        graph: next,
      }),
    )
    // Open on the whole flow. Landing at 100% in the corner of a wide graph is
    // how a board full of work looks empty.
    fitTo(next)
  }, [fitTo, quest.data, reset])

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
        graph: value,
      }),
    onSuccess: async () => {
      setNotice(t('economy.saved'))
      setError(null)
      setSaved(draft)
      await queryClient.invalidateQueries({ queryKey: ['admin', 'quests'] })
    },
    onError: (cause) => {
      setNotice(null)
      setError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  const savable = errors.length === 0 && title.trim().length > 0 && !save.isPending
  const submit = useCallback(() => {
    if (savable) {
      save.mutate()
    }
  }, [save, savable])

  /** Put a node in the middle of what the user is actually looking at. */
  const centreOf = useCallback(() => {
    const box = board.current?.getBoundingClientRect()
    if (!box) {
      return { x: 240, y: 160 }
    }
    return {
      x: snap((box.width / 2 - view.x) / view.zoom - NODE_W / 2),
      y: snap((box.height / 2 - view.y) / view.zoom - NODE_H / 2),
    }
  }, [view])

  const addNode = useCallback(
    (type: GraphNodeType, at?: { x: number; y: number }) => {
      const spot = at ?? centreOf()
      // Nudge off anything already parked on that exact spot.
      const offset = occupied(value, spot) * GRID * 3
      const node: GraphNode = {
        id: uid(type),
        type,
        x: snap(spot.x + offset),
        y: snap(spot.y + offset),
        title: t(kindOf(type)?.label ?? 'economy.flow_untitled'),
        data: defaultData(type),
      }
      change((current) => ({ ...current, nodes: [...current.nodes, node] }))
      setSelection({ kind: 'node', id: node.id })
      setTab('node')
    },
    [centreOf, change, t, value],
  )

  const focusNode = useCallback((node: GraphNode) => {
    const box = board.current?.getBoundingClientRect()
    setSelection({ kind: 'node', id: node.id })
    setTab('node')
    if (!box) {
      return
    }
    setView((current) => ({
      ...current,
      x: box.width / 2 - (node.x + NODE_W / 2) * current.zoom,
      y: box.height / 2 - (node.y + NODE_H / 2) * current.zoom,
    }))
  }, [])

  const remove = useCallback(
    (target: Selection) => {
      if (!target) {
        return
      }
      if (target.kind === 'edge') {
        change((current) => ({
          ...current,
          edges: current.edges.filter((edge) => edge.id !== target.id),
        }))
        setSelection(null)
        return
      }
      if (value.nodes.find((node) => node.id === target.id)?.type === 'start') {
        return
      }
      change((current) => ({
        nodes: current.nodes.filter((node) => node.id !== target.id),
        edges: current.edges.filter((edge) => edge.from !== target.id && edge.to !== target.id),
      }))
      setSelection(null)
    },
    [change, value.nodes],
  )

  const duplicate = useCallback(() => {
    if (selection?.kind !== 'node') {
      return
    }
    const source = value.nodes.find((node) => node.id === selection.id)
    if (!source || source.type === 'start') {
      return
    }
    const copy: GraphNode = {
      ...source,
      id: uid(source.type),
      x: snap(source.x + 32),
      y: snap(source.y + 32),
      data: { ...source.data },
    }
    change((current) => ({ ...current, nodes: [...current.nodes, copy] }))
    setSelection({ kind: 'node', id: copy.id })
  }, [change, selection, value.nodes])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const tag = (event.target as HTMLElement | null)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        submit()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        if (typing) {
          return
        }
        event.preventDefault()
        if (event.shiftKey) {
          redo()
        } else {
          undo()
        }
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd' && !typing) {
        event.preventDefault()
        duplicate()
        return
      }
      if (typing) {
        return
      }
      if (event.key === 'Escape') {
        setSelection(null)
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        remove(selection)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [duplicate, redo, remove, selection, submit, undo])

  useEffect(() => {
    if (!dirty) {
      return
    }
    function onLeave(event: BeforeUnloadEvent) {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [dirty])

  const current = value.nodes.find((node) => node.id === (selection?.kind === 'node' ? selection.id : null)) ?? null
  const gates = value.nodes.filter((node) => kindOf(node.type)?.category === 'gate').length
  const payout = totalPayout(value)

  function leave() {
    if (dirty) {
      setLeaving(true)
      return
    }
    void navigate({ to: '/admin/quests' })
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-fence px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <button
            type="button"
            onClick={leave}
            className="flex shrink-0 items-center gap-1.5 font-mono text-[0.6875rem] tracking-widest text-dust uppercase hover:text-hazard"
          >
            <ArrowLeft aria-hidden="true" className="size-3.5" />
            {t('economy.flows_title')}
          </button>
          <div className="min-w-0 flex-1">
            <input
              value={title}
              aria-label={t('economy.item_name')}
              onChange={(event) => setTitle(event.target.value)}
              className="display w-full min-w-0 border border-transparent bg-transparent px-1 text-xl text-bone focus:border-hazard"
            />
            <p className="mt-0.5 px-1 font-mono text-[0.6875rem] text-dust">
              {t('economy.flow_node_count', { count: value.nodes.length })}
              {' · '}
              {t('economy.flow_gate_count', { count: gates })}
              {' · '}
              {t('economy.flow_payout', { xp: payout.xp, coins: payout.coins })}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {dirty ? (
            <span className="flex items-center gap-1.5 font-mono text-[0.625rem] tracking-widest text-hazard uppercase">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-hazard" />
              {t('economy.flow_unsaved')}
            </span>
          ) : null}
          <button
            type="button"
            role="switch"
            aria-checked={active}
            onClick={() => setActive((state) => !state)}
            className={cn(
              'flex items-center gap-2 border px-3 py-2 font-mono text-[0.625rem] tracking-widest uppercase',
              active ? 'border-moss bg-moss-soft text-moss' : 'border-fence text-dust hover:text-bone',
            )}
          >
            <span aria-hidden="true" className={cn('size-1.5 rounded-full', active ? 'bg-moss' : 'bg-dust')} />
            {active ? t('economy.flow_live') : t('economy.flow_draft')}
          </button>
          <Button size="sm" disabled={!savable} onClick={submit}>
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
        <div className="grid min-h-0 flex-1 lg:grid-cols-[12rem_minmax(0,1fr)_20rem]">
          <Palette onAdd={addNode} />

          <div className="flex min-h-0 min-w-0 flex-col">
            <Board
              ref={board}
              graph={value}
              flags={flags}
              selection={selection}
              view={view}
              onView={setView}
              onSelect={(next) => {
                setSelection(next)
                if (next?.kind === 'node') {
                  setTab('node')
                }
              }}
              onChange={change}
              onCheckpoint={checkpoint}
              onDrop={addNode}
            >
              <BoardControls
                zoom={view.zoom}
                canUndo={graph.canUndo}
                canRedo={graph.canRedo}
                onZoom={(factor) =>
                  setView((state) => ({
                    ...state,
                    zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, state.zoom * factor)),
                  }))
                }
                onFit={fit}
                onTidy={() => change((state) => autoLayout(state))}
                onUndo={undo}
                onRedo={redo}
              />
            </Board>

            <ProblemStrip
              problems={problems}
              open={problemsOpen}
              onToggle={() => setProblemsOpen((state) => !state)}
              onPick={(problem) => {
                const node = value.nodes.find((item) => item.id === problem.nodeId)
                if (node) {
                  focusNode(node)
                }
              }}
            />
          </div>

          <aside className="flex min-h-0 flex-col border-l border-fence">
            <div className="border-b border-fence p-3">
              <TabStrip<'node' | 'flow'>
                label={t('economy.flow_inspector')}
                active={tab}
                onSelect={setTab}
                items={[
                  { id: 'node', label: t('economy.flow_tab_node') },
                  { id: 'flow', label: t('economy.flow_tab_flow') },
                ]}
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {tab === 'node' ? (
                <TabPanel id="node">
                  {current ? (
                    <NodeInspector
                      key={current.id}
                      questId={questId}
                      node={current}
                      onCheckpoint={checkpoint}
                      onChange={(next) =>
                        change(
                          (state) => ({
                            ...state,
                            nodes: state.nodes.map((item) => (item.id === next.id ? next : item)),
                          }),
                          false,
                        )
                      }
                      onDuplicate={duplicate}
                      onDelete={() => remove(selection)}
                    />
                  ) : (
                    <p className="text-sm text-dust">{t('economy.flow_pick_node')}</p>
                  )}
                </TabPanel>
              ) : (
                <TabPanel id="flow">
                  <FlowInspector
                    graph={value}
                    description={description}
                    audience={audience}
                    usernames={usernames}
                    groupId={groupId}
                    groups={groups.data ?? []}
                    onDescription={setDescription}
                    onAudience={setAudience}
                    onUsernames={setUsernames}
                    onGroup={setGroupId}
                    onPick={focusNode}
                  />
                </TabPanel>
              )}
            </div>
          </aside>
        </div>
      )}

      <ConfirmDialog
        open={leaving}
        title={t('economy.flow_leave_title')}
        description={t('economy.flow_leave_body')}
        confirmLabel={t('economy.flow_leave_confirm')}
        tone="danger"
        onConfirm={() => {
          setLeaving(false)
          void navigate({ to: '/admin/quests' })
        }}
        onClose={() => setLeaving(false)}
      />
    </section>
  )
}

/** How many nodes already sit on the spot a new one is about to land. */
function occupied(graph: QuestGraph, spot: { x: number; y: number }): number {
  return graph.nodes.filter((node) => Math.abs(node.x - spot.x) < NODE_W && Math.abs(node.y - spot.y) < NODE_H)
    .length
}

interface History<T> {
  value: T
  /** `record` false keeps drags and keystrokes out of the undo stack. */
  set: (next: T | ((current: T) => T), record?: boolean) => void
  /** Mark the state before an edit that will arrive as unrecorded changes. */
  checkpoint: () => void
  reset: (next: T) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

const HISTORY_DEPTH = 60

function useHistory<T>(initial: T): History<T> {
  const [state, setState] = useState<{ past: T[]; present: T; future: T[] }>({
    past: [],
    present: initial,
    future: [],
  })

  const set = useCallback((next: T | ((current: T) => T), record = true) => {
    setState((current) => {
      const value = typeof next === 'function' ? (next as (value: T) => T)(current.present) : next
      if (value === current.present) {
        return current
      }
      if (!record) {
        return { ...current, present: value }
      }
      return {
        past: [...current.past, current.present].slice(-HISTORY_DEPTH),
        present: value,
        future: [],
      }
    })
  }, [])

  const checkpoint = useCallback(() => {
    setState((current) => {
      const top = current.past[current.past.length - 1]
      // Focus moving between two fields must not stack identical states.
      if (top !== undefined && JSON.stringify(top) === JSON.stringify(current.present)) {
        return current
      }
      return { ...current, past: [...current.past, current.present].slice(-HISTORY_DEPTH), future: [] }
    })
  }, [])

  const reset = useCallback((next: T) => {
    setState({ past: [], present: next, future: [] })
  }, [])

  const undo = useCallback(() => {
    setState((current) => {
      const previous = current.past[current.past.length - 1]
      if (previous === undefined) {
        return current
      }
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future],
      }
    })
  }, [])

  const redo = useCallback(() => {
    setState((current) => {
      const [next, ...rest] = current.future
      if (next === undefined) {
        return current
      }
      return { past: [...current.past, current.present], present: next, future: rest }
    })
  }, [])

  return {
    value: state.present,
    set,
    checkpoint,
    reset,
    undo,
    redo,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  }
}

/** The node rail, split into what the three kinds of node are actually for. */
function Palette({ onAdd }: { onAdd: (type: GraphNodeType) => void }) {
  const { t } = useTranslation()
  const categories: NodeCategory[] = ['flow', 'gate', 'payout']

  return (
    <aside className="flex flex-col gap-4 overflow-y-auto border-r border-fence p-3">
      <p className="text-[0.6875rem] leading-relaxed text-dust">{t('economy.flow_palette_hint')}</p>
      {categories.map((category) => (
        <div key={category} className="flex flex-col gap-1">
          <p className="eyebrow mb-1">{t(CATEGORY_LABELS[category])}</p>
          {NODE_KINDS.filter((kind) => kind.category === category).map((kind) => (
            <button
              key={kind.type}
              type="button"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData('text/x-flow-node', kind.type)
                event.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={() => onAdd(kind.type)}
              className={cn(
                'flex items-center gap-2 border border-fence px-2 py-2 text-left font-mono text-[0.6875rem] uppercase',
                'text-smoke hover:border-hazard hover:text-hazard active:cursor-grabbing',
              )}
            >
              <span aria-hidden="true" className={cn('h-4 w-0.5 shrink-0', TONES[kind.category].bar)} />
              {t(kind.label)}
            </button>
          ))}
        </div>
      ))}
    </aside>
  )
}

function Board({
  ref,
  graph,
  flags,
  selection,
  view,
  onView,
  onSelect,
  onChange,
  onCheckpoint,
  onDrop,
  children,
}: {
  ref: RefObject<HTMLDivElement | null>
  graph: QuestGraph
  flags: Map<string, GraphProblem['level']>
  selection: Selection
  view: View
  onView: (next: View | ((current: View) => View)) => void
  onSelect: (next: Selection) => void
  onChange: (next: QuestGraph | ((current: QuestGraph) => QuestGraph), record?: boolean) => void
  onCheckpoint: () => void
  onDrop: (type: GraphNodeType, at: { x: number; y: number }) => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  const drag = useRef<
    | { kind: 'pan'; x: number; y: number; ox: number; oy: number }
    | { kind: 'node'; id: string; x: number; y: number; ox: number; oy: number; moved: boolean }
    | { kind: 'wire'; from: string }
    | null
  >(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

  const linking = drag.current?.kind === 'wire' ? drag.current.from : null
  // Only the loose end of a wire being dragged has to stretch the layer; the
  // pointer wandering across an idle board does not.
  const reach = linking ? cursor : null

  /**
   * The rectangle the wire layer covers, in board coordinates.
   *
   * An `<svg>` clips to its own viewport, so this cannot simply start at the
   * board origin and run to the far side of the last node: a node dragged left
   * of the origin, or a wire pulled out into empty board, would be sliced off
   * at an edge with nothing on screen to explain it. Every wire reports the box
   * it needs, negative coordinates included, and the layer is the union.
   */
  const world = useMemo(() => {
    let minX = 0
    let minY = 0
    let maxX = 1200
    let maxY = 700

    function cover(box: { minX: number; minY: number; maxX: number; maxY: number }) {
      minX = Math.min(minX, box.minX)
      minY = Math.min(minY, box.minY)
      maxX = Math.max(maxX, box.maxX)
      maxY = Math.max(maxY, box.maxY)
    }

    for (const node of graph.nodes) {
      cover({ minX: node.x, minY: node.y, maxX: node.x + NODE_W, maxY: node.y + NODE_H })
    }

    for (const edge of graph.edges) {
      const from = graph.nodes.find((node) => node.id === edge.from)
      const to = graph.nodes.find((node) => node.id === edge.to)
      if (from && to) {
        cover(wireBox(port(from, 'out'), port(to, 'in')))
      }
    }

    const source = reach ? graph.nodes.find((node) => node.id === linking) : null
    if (source && reach) {
      cover(wireBox(port(source, 'out'), reach))
    }

    return {
      x: minX - MARGIN,
      y: minY - MARGIN,
      width: maxX - minX + MARGIN * 2,
      height: maxY - minY + MARGIN * 2,
    }
  }, [graph, linking, reach])

  function local(event: { clientX: number; clientY: number }) {
    const box = ref.current?.getBoundingClientRect()
    if (!box) {
      return { x: 0, y: 0 }
    }
    return {
      x: (event.clientX - box.left - view.x) / view.zoom,
      y: (event.clientY - box.top - view.y) / view.zoom,
    }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    const pin = target.closest('[data-pin]')?.getAttribute('data-pin')
    const nodeId = target.closest('[data-node]')?.getAttribute('data-node')

    if (pin === 'out' && nodeId) {
      drag.current = { kind: 'wire', from: nodeId }
      onSelect({ kind: 'node', id: nodeId })
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    if (nodeId) {
      const node = graph.nodes.find((item) => item.id === nodeId)
      if (!node) {
        return
      }
      const point = local(event)
      drag.current = { kind: 'node', id: nodeId, x: point.x, y: point.y, ox: node.x, oy: node.y, moved: false }
      onSelect({ kind: 'node', id: nodeId })
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    drag.current = { kind: 'pan', x: event.clientX, y: event.clientY, ox: view.x, oy: view.y }
    onSelect(null)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (!current) {
      return
    }
    const point = local(event)
    if (current.kind === 'wire') {
      setCursor(point)
    } else if (current.kind === 'pan') {
      onView((state) => ({
        ...state,
        x: current.ox + (event.clientX - current.x),
        y: current.oy + (event.clientY - current.y),
      }))
    } else if (current.kind === 'node') {
      // Only a drag that actually shifts a node is worth an undo step; a plain
      // click to select is not.
      if (!current.moved) {
        current.moved = true
        onCheckpoint()
      }
      onChange(
        (state) => ({
          ...state,
          nodes: state.nodes.map((node) =>
            node.id === current.id
              ? {
                  ...node,
                  x: snap(current.ox + (point.x - current.x)),
                  y: snap(current.oy + (point.y - current.y)),
                }
              : node,
          ),
        }),
        false,
      )
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
    onChange((state) =>
      state.edges.some((edge) => edge.from === current.from && edge.to === to)
        ? state
        : { ...state, edges: [...state.edges, { id: uid('e'), from: current.from, to }] },
    )
  }

  return (
    <div
      ref={ref}
      className="relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden bg-void"
      style={{
        backgroundImage:
          'linear-gradient(to right, rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.035) 1px, transparent 1px)',
        backgroundSize: `${GRID * 3 * view.zoom}px ${GRID * 3 * view.zoom}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = null
        setCursor(null)
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('text/x-flow-node')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(event) => {
        const type = event.dataTransfer.getData('text/x-flow-node')
        if (!type) {
          return
        }
        event.preventDefault()
        const point = local(event)
        onDrop(type as GraphNodeType, { x: snap(point.x - NODE_W / 2), y: snap(point.y - NODE_H / 2) })
      }}
      onWheel={(event) => {
        const box = ref.current?.getBoundingClientRect()
        if (!box) {
          return
        }
        const cx = event.clientX - box.left
        const cy = event.clientY - box.top
        onView((state) => {
          const zoom = Math.min(
            ZOOM_MAX,
            Math.max(ZOOM_MIN, state.zoom * (event.deltaY > 0 ? 0.92 : 1.08)),
          )
          // Hold the world point under the cursor still while the scale changes.
          return {
            zoom,
            x: cx - ((cx - state.x) / state.zoom) * zoom,
            y: cy - ((cy - state.y) / state.zoom) * zoom,
          }
        })
      }}
    >
      <div
        className="absolute origin-top-left"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          width: world.x + world.width,
          height: world.y + world.height,
        }}
      >
        {/* Offset and viewBox move together, so paths are still drawn in board
            coordinates however far into the negative the layer reaches. */}
        <svg
          className="pointer-events-none absolute"
          style={{ left: world.x, top: world.y }}
          width={world.width}
          height={world.height}
          viewBox={`${world.x} ${world.y} ${world.width} ${world.height}`}
        >
          {graph.edges.map((edge) => {
            const from = graph.nodes.find((node) => node.id === edge.from)
            const to = graph.nodes.find((node) => node.id === edge.to)
            if (!from || !to) {
              return null
            }
            const path = wirePath(port(from, 'out'), port(to, 'in'))
            const chosen = selection?.kind === 'edge' && selection.id === edge.id
            return (
              <g key={edge.id}>
                <path
                  d={path}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={18}
                  className="pointer-events-auto cursor-pointer"
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    onSelect({ kind: 'edge', id: edge.id })
                  }}
                />
                <path
                  d={path}
                  fill="none"
                  stroke="var(--color-hazard)"
                  strokeWidth={chosen ? 3 : 2}
                  strokeOpacity={chosen ? 1 : 0.55}
                  className="pointer-events-none"
                />
              </g>
            )
          })}
          {linking && cursor
            ? (() => {
                const from = graph.nodes.find((node) => node.id === linking)
                return from ? (
                  <path
                    d={wirePath(port(from, 'out'), cursor)}
                    fill="none"
                    stroke="var(--color-hazard)"
                    strokeWidth={2}
                    strokeDasharray="6 4"
                  />
                ) : null
              })()
            : null}
        </svg>

        {graph.edges.map((edge) => {
          if (selection?.kind !== 'edge' || selection.id !== edge.id) {
            return null
          }
          const from = graph.nodes.find((node) => node.id === edge.from)
          const to = graph.nodes.find((node) => node.id === edge.to)
          if (!from || !to) {
            return null
          }
          const mid = wireMid(port(from, 'out'), port(to, 'in'))
          return (
            <button
              key={edge.id}
              type="button"
              aria-label={t('economy.flow_delete_wire')}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() =>
                onChange((state) => ({
                  ...state,
                  edges: state.edges.filter((item) => item.id !== edge.id),
                }))
              }
              className="absolute flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center border border-blood bg-void text-blood hover:bg-blood hover:text-void"
              style={{ left: mid.x, top: mid.y }}
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          )
        })}

        {graph.nodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            selected={selection?.kind === 'node' && selection.id === node.id}
            flag={flags.get(node.id) ?? null}
            linking={linking !== null}
          />
        ))}
      </div>

      {children}
    </div>
  )
}

function NodeCard({
  node,
  selected,
  flag,
  linking,
}: {
  node: GraphNode
  selected: boolean
  flag: GraphProblem['level'] | null
  linking: boolean
}) {
  const { t } = useTranslation()
  const kind = kindOf(node.type)
  const tone = TONES[kind?.category ?? 'flow']
  const payout = payoutOf(node)

  return (
    <article
      data-node={node.id}
      className={cn(
        'absolute flex cursor-grab flex-col border bg-ash select-none active:cursor-grabbing',
        selected ? 'border-hazard shadow-[0_0_0_1px_var(--color-hazard)]' : tone.border,
      )}
      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
    >
      <header className="flex items-center gap-2 border-b border-fence px-2 py-1">
        <span aria-hidden="true" className={cn('h-3 w-0.5 shrink-0', tone.bar)} />
        <span className={cn('font-mono text-[0.625rem] tracking-widest uppercase', tone.text)}>
          {kind ? t(kind.label) : node.type}
        </span>
        {flag ? (
          <TriangleAlert
            aria-hidden="true"
            className={cn('ml-auto size-3.5', flag === 'error' ? 'text-blood' : 'text-hazard')}
          />
        ) : null}
      </header>

      <div className="min-h-0 flex-1 px-2 py-1.5">
        <p className="truncate text-sm text-bone">{node.title || t('economy.flow_untitled')}</p>
        <p className="truncate font-mono text-[0.625rem] text-dust">{summarise(node, t)}</p>
      </div>

      {payout.xp > 0 || payout.coins > 0 ? (
        <p className="truncate border-t border-fence px-2 py-1 font-mono text-[0.625rem] text-moss">
          {t('economy.flow_payout', { xp: payout.xp, coins: payout.coins })}
        </p>
      ) : null}

      <span
        aria-hidden="true"
        className={cn(
          'absolute top-1/2 left-[-5px] size-2.5 -translate-y-1/2 border bg-void',
          linking ? 'border-hazard' : 'border-dust',
        )}
      />
      <span
        data-pin="out"
        title={t('economy.flow_wire_hint')}
        className="absolute top-1/2 right-[-7px] size-3.5 -translate-y-1/2 cursor-crosshair border border-hazard bg-void hover:bg-hazard"
      />
    </article>
  )
}

function BoardControls({
  zoom,
  canUndo,
  canRedo,
  onZoom,
  onFit,
  onTidy,
  onUndo,
  onRedo,
}: {
  zoom: number
  canUndo: boolean
  canRedo: boolean
  onZoom: (factor: number) => void
  onFit: () => void
  onTidy: () => void
  onUndo: () => void
  onRedo: () => void
}) {
  const { t } = useTranslation()

  return (
    <>
      <div className="absolute bottom-3 left-3 flex items-center gap-1 border border-fence-bright bg-ash/95 p-1">
        <Tool label={t('economy.flow_zoom_out')} onClick={() => onZoom(0.88)}>
          <Minus aria-hidden="true" className="size-3.5" />
        </Tool>
        <span className="w-10 text-center font-mono text-[0.625rem] text-dust">{Math.round(zoom * 100)}%</span>
        <Tool label={t('economy.flow_zoom_in')} onClick={() => onZoom(1.12)}>
          <Plus aria-hidden="true" className="size-3.5" />
        </Tool>
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-fence" />
        <Tool label={t('economy.flow_fit')} onClick={onFit}>
          <Maximize2 aria-hidden="true" className="size-3.5" />
        </Tool>
        <Tool label={t('economy.flow_tidy')} onClick={onTidy}>
          <Wand2 aria-hidden="true" className="size-3.5" />
        </Tool>
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-fence" />
        <Tool label={t('economy.flow_undo')} disabled={!canUndo} onClick={onUndo}>
          <Undo2 aria-hidden="true" className="size-3.5" />
        </Tool>
        <Tool label={t('economy.flow_redo')} disabled={!canRedo} onClick={onRedo}>
          <Redo2 aria-hidden="true" className="size-3.5" />
        </Tool>
      </div>

      <p className="pointer-events-none absolute top-3 right-3 hidden font-mono text-[0.625rem] text-dust xl:block">
        {t('economy.flow_shortcuts')}
      </p>
    </>
  )
}

function Tool({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      className="flex size-7 items-center justify-center text-smoke hover:bg-ash-raised hover:text-hazard disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-smoke"
    >
      {children}
    </button>
  )
}

/** What the server would reject, and what it accepts but players cannot finish. */
function ProblemStrip({
  problems,
  open,
  onToggle,
  onPick,
}: {
  problems: GraphProblem[]
  open: boolean
  onToggle: () => void
  onPick: (problem: GraphProblem) => void
}) {
  const { t } = useTranslation()
  const errors = problems.filter((problem) => problem.level === 'error').length
  const warnings = problems.length - errors

  return (
    <div className="shrink-0 border-t border-fence bg-ash">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-2 text-left"
      >
        <span className="eyebrow">{t('economy.flow_problems')}</span>
        {problems.length === 0 ? (
          <span className="flex items-center gap-1.5 font-mono text-[0.6875rem] text-moss">
            <Check aria-hidden="true" className="size-3.5" />
            {t('economy.flow_problems_clear')}
          </span>
        ) : (
          <span className="flex items-center gap-3 font-mono text-[0.6875rem]">
            {errors > 0 ? (
              <span className="text-blood">{t('economy.flow_problem_errors', { count: errors })}</span>
            ) : null}
            {warnings > 0 ? (
              <span className="text-hazard">{t('economy.flow_problem_warnings', { count: warnings })}</span>
            ) : null}
          </span>
        )}
        <ChevronDown
          aria-hidden="true"
          className={cn('ml-auto size-4 text-dust transition-transform', open ? '' : '-rotate-90')}
        />
      </button>

      {open && problems.length > 0 ? (
        <ul className="max-h-36 divide-y divide-fence overflow-y-auto border-t border-fence">
          {problems.map((problem) => (
            <li key={problem.id}>
              <button
                type="button"
                disabled={!problem.nodeId}
                onClick={() => onPick(problem)}
                className={cn(
                  'flex w-full items-start gap-2 px-4 py-2 text-left text-xs',
                  problem.nodeId ? 'hover:bg-ash-raised' : 'cursor-default',
                )}
              >
                <TriangleAlert
                  aria-hidden="true"
                  className={cn(
                    'mt-0.5 size-3.5 shrink-0',
                    problem.level === 'error' ? 'text-blood' : 'text-hazard',
                  )}
                />
                <span className="text-smoke">{t(problem.key, problem.params)}</span>
                {problem.nodeId ? (
                  <Crosshair aria-hidden="true" className="mt-0.5 ml-auto size-3.5 shrink-0 text-dust" />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function NodeInspector({
  questId,
  node,
  onChange,
  onCheckpoint,
  onDuplicate,
  onDelete,
}: {
  questId: string
  node: GraphNode
  onChange: (node: GraphNode) => void
  onCheckpoint: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [mapOpen, setMapOpen] = useState(false)
  const kind = kindOf(node.type)
  const area = node.type === 'area'
  const item = node.type === 'find' || node.type === 'collect'
  const kills = node.type === 'kills'
  const measured = kind?.measured ?? false
  const describable = measured || area || item || kills || node.type === 'stage'
  const collectable = isCondition(node.type)

  // A `manual` node has no measure the server can read, so nobody but staff can
  // ever finish it. Before this the panel had no way to say so and those nodes
  // simply sat there.
  const [grantTo, setGrantTo] = useState('')
  const [grantNote, setGrantNote] = useState<string | null>(null)
  const [grantError, setGrantError] = useState<string | null>(null)
  const grant = useMutation({
    mutationFn: () => api.adminGrantQuestNode(questId, node.id, grantTo.trim()),
    onSuccess: (result) => {
      setGrantError(null)
      setGrantTo('')
      setGrantNote(result.message)
    },
    onError: (cause: unknown) => {
      setGrantNote(null)
      setGrantError(cause instanceof ApiError ? cause.message : t('auth.unexpected_error'))
    },
  })

  return (
    <div className="flex flex-col gap-3" onFocusCapture={onCheckpoint}>
      <div className="flex items-center gap-2 border-b border-fence pb-3">
        <span aria-hidden="true" className={cn('h-4 w-0.5', TONES[kind?.category ?? 'flow'].bar)} />
        <span className={cn('font-mono text-[0.625rem] tracking-widest uppercase', TONES[kind?.category ?? 'flow'].text)}>
          {kind ? t(kind.label) : node.type}
        </span>
      </div>

      <Field
        label={t('economy.item_name')}
        value={node.title}
        onChange={(event) => onChange({ ...node, title: event.target.value })}
      />

      {describable ? (
        <TextAreaField
          label={t('economy.objective_brief')}
          value={node.data.description ?? ''}
          onChange={(event) => onChange({ ...node, data: { ...node.data, description: event.target.value } })}
          className="min-h-16"
        />
      ) : null}

      {measured ? (
        <>
          <fieldset>
            <legend className="mb-2 font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
              {t('economy.objective_kind')}
            </legend>
            <div className="flex flex-wrap gap-1">
              {Object.entries(MEASURE_LABELS).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    onCheckpoint()
                    onChange({ ...node, data: { ...node.data, measure: id } })
                  }}
                  className={cn(
                    'border px-2 py-1 font-mono text-[0.625rem] uppercase',
                    node.data.measure === id
                      ? 'border-hazard bg-hazard-soft text-hazard'
                      : 'border-fence text-dust hover:text-bone',
                  )}
                >
                  {t(label)}
                </button>
              ))}
            </div>
            {node.data.measure === 'manual' ? (
              <p className="mt-2 text-xs text-hazard">{t('economy.flow_problem_manual')}</p>
            ) : null}
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
                onChange={(event) => onChange({ ...node, data: { ...node.data, cadence: event.target.value } })}
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
                  data: { ...node.data, area_z: event.target.value === '' ? null : Number(event.target.value) },
                })
              }
            />
          </div>
          <AreaEditor
            open={mapOpen}
            data={node.data}
            onClose={() => setMapOpen(false)}
            onApply={(next) => {
              onCheckpoint()
              onChange({ ...node, data: next })
            }}
          />
        </>
      ) : null}

      {item ? (
        <div className="grid grid-cols-2 gap-2">
          <Field
            label={t('economy.item_type')}
            value={node.data.item_type ?? ''}
            hint={t('economy.flow_item_hint')}
            onChange={(event) => onChange({ ...node, data: { ...node.data, item_type: event.target.value } })}
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
          onChange={(event) => onChange({ ...node, data: { ...node.data, goal: Number(event.target.value) || 1 } })}
        />
      ) : null}

      {kind?.pays ? (
        <div className="grid grid-cols-2 gap-2">
          <Field
            type="number"
            min={0}
            label={t('economy.xp_label')}
            value={node.data.xp ?? 0}
            onChange={(event) => onChange({ ...node, data: { ...node.data, xp: Number(event.target.value) || 0 } })}
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

      {collectable ? (
        <div className="flex flex-col gap-2 border-t border-fence pt-3">
          <span className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
            {t('economy.objective_grant')}
          </span>
          <p className="text-xs text-dust">{t('economy.objective_grant_hint')}</p>
          <div className="flex gap-2">
            <input
              value={grantTo}
              placeholder={t('economy.objective_player')}
              onChange={(event) => setGrantTo(event.target.value)}
              className="h-10 min-w-0 flex-1 border border-fence-bright bg-void px-3 font-mono text-sm text-bone"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={grantTo.trim() === '' || grant.isPending}
              onClick={() => grant.mutate()}
            >
              {t('economy.objective_grant')}
            </Button>
          </div>
          {grantNote ? <p className="text-xs text-moss">{grantNote}</p> : null}
          {grantError ? <p className="text-xs text-blood">{grantError}</p> : null}
        </div>
      ) : null}

      {node.type !== 'start' ? (
        <div className="flex gap-2 border-t border-fence pt-3">
          <Button size="sm" variant="outline" onClick={onDuplicate}>
            <Copy aria-hidden="true" className="size-3.5" />
            {t('economy.flow_duplicate_node')}
          </Button>
          <Button size="sm" variant="outline" className="border-blood text-blood" onClick={onDelete}>
            <Trash2 aria-hidden="true" className="size-3.5" />
            {t('common.delete')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function FlowInspector({
  graph,
  description,
  audience,
  usernames,
  groupId,
  groups,
  onDescription,
  onAudience,
  onUsernames,
  onGroup,
  onPick,
}: {
  graph: QuestGraph
  description: string
  audience: string
  usernames: string
  groupId: string
  groups: { id: string; name: string }[]
  onDescription: (value: string) => void
  onAudience: (value: string) => void
  onUsernames: (value: string) => void
  onGroup: (value: string) => void
  onPick: (node: GraphNode) => void
}) {
  const { t } = useTranslation()
  const steps = playerSteps(graph)

  return (
    <div className="flex flex-col gap-4">
      <TextAreaField
        label={t('economy.objective_brief')}
        value={description}
        onChange={(event) => onDescription(event.target.value)}
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
                onChange={() => onAudience(item.id)}
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
          onChange={(event) => onUsernames(event.target.value)}
        />
      ) : null}

      {audience === 'group' ? (
        <label className="flex flex-col gap-2">
          <span className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
            {t('economy.flow_group')}
          </span>
          <select
            value={groupId}
            onChange={(event) => onGroup(event.target.value)}
            className="h-12 border border-fence-bright bg-void px-3 font-mono text-sm text-bone"
          >
            <option value="">{t('common.none_found')}</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {audience === 'claimable' ? <p className="text-xs text-dust">{t('economy.flow_claimable_later')}</p> : null}

      <div className="border-t border-fence pt-3">
        <p className="eyebrow mb-1">{t('economy.flow_preview')}</p>
        <p className="mb-3 text-xs text-dust">{t('economy.flow_preview_hint')}</p>
        {steps.length === 0 ? (
          <p className="text-sm text-dust">{t('economy.flow_preview_empty')}</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {steps.map((node, index) => {
              const payout = payoutOf(node)
              return (
                <li key={node.id}>
                  <button
                    type="button"
                    onClick={() => onPick(node)}
                    className="flex w-full items-start gap-2 border border-fence px-2 py-1.5 text-left hover:border-hazard"
                  >
                    <span className="font-mono text-[0.625rem] text-dust">{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-bone">{node.title}</span>
                      <span className="block truncate font-mono text-[0.625rem] text-dust">
                        {summarise(node, t)}
                      </span>
                    </span>
                    {payout.xp > 0 || payout.coins > 0 ? (
                      <span className="shrink-0 font-mono text-[0.625rem] text-moss">
                        {t('economy.flow_payout', { xp: payout.xp, coins: payout.coins })}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </div>
  )
}
