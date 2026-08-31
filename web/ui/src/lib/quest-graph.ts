import type { TranslationKey } from '@/i18n/locales'

export type GraphNodeType =
  | 'start'
  | 'stage'
  | 'task'
  | 'objective'
  | 'reward'
  | 'end'
  | 'area'
  | 'find'
  | 'collect'
  | 'kills'

export type GraphMeasure = 'play' | 'kills' | 'hours' | 'spend' | 'trade' | 'manual'
export type GraphCadence = 'daily' | 'once'
export type QuestAudience = 'all' | 'players' | 'group' | 'claimable'

export interface GraphNodeData {
  description?: string | null
  measure?: GraphMeasure | string | null
  goal?: number | null
  cadence?: GraphCadence | string | null
  xp?: number | null
  coins?: number | null
  item_type?: string | null
  area_x?: number | null
  area_y?: number | null
  area_z?: number | null
  area_radius?: number | null
  area_cells?: { x: number; y: number }[] | null
  area_cell_size?: number | null
}

export interface GraphNode {
  id: string
  type: GraphNodeType | string
  x: number
  y: number
  title: string
  data: GraphNodeData
}

export interface GraphEdge {
  id: string
  from: string
  to: string
}

export interface QuestGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface Quest {
  id: string
  title: string
  description: string | null
  audience: QuestAudience | string
  audience_usernames: string[]
  audience_group_id: string | null
  active: boolean
  graph: QuestGraph
  created_at: string
  updated_at: string
}

export interface QuestPatch {
  title?: string
  description?: string | null
  audience?: string
  audience_usernames?: string[]
  audience_group_id?: string | null
  active?: boolean
  graph?: QuestGraph
}

export interface PlayerGroup {
  id: string
  name: string
  members: number
  created_at: string
}

export interface QuestNodeView {
  id: string
  kind: string
  title: string
  description: string | null
  measure: string | null
  cadence: string
  xp: number
  coins: number
  progress: number
  goal: number
  item_type?: string | null
  area_x?: number | null
  area_y?: number | null
  area_radius?: number | null
  unlocked: boolean
  complete: boolean
  claimed: boolean
}

export interface QuestProgress {
  id: string
  title: string
  description: string | null
  stage: string | null
  nodes: QuestNodeView[]
}

export interface QuestOffer {
  id: string
  title: string
  description: string | null
}

/** Node kinds a player can finish and collect. */
export const CONDITION_KINDS = ['task', 'objective', 'area', 'find', 'collect', 'kills']

export function isCondition(kind: string): boolean {
  return CONDITION_KINDS.includes(kind)
}

/** A one-step flow, flattened back to the shape a plain objective had. */
export interface FlatObjective extends QuestNodeView {
  questId: string
  questTitle: string
}

/** Node ids are only unique within their own flow, so selection needs both. */
export function flatKey(item: FlatObjective): string {
  return `${item.questId}:${item.id}`
}

/**
 * Split flows by shape, not by type.
 *
 * Objectives used to be their own table and their own page. They are flows now,
 * but a flow holding a single step with nothing gated behind it is still just a
 * daily task, and drawing it as a one-node graph would be a worse way to show
 * the same thing.
 *
 * A new flow starts with a Stage node. Counting only gates used to flatten
 * "Stage 1 + one task" onto the objectives tab, so going live looked like the
 * flow had vanished. Stages or a payout keep it on the board.
 */
export function splitFlows(quests: QuestProgress[]): {
  flat: FlatObjective[]
  staged: QuestProgress[]
} {
  const flat: FlatObjective[] = []
  const staged: QuestProgress[] = []

  for (const quest of quests) {
    const steps = quest.nodes.filter((node) => isCondition(node.kind))
    const rewards = quest.nodes.filter((node) => node.kind === 'reward')
    const stages = quest.nodes.filter((node) => node.kind === 'stage')
    const step = steps[0]

    if (steps.length === 1 && rewards.length === 0 && stages.length === 0 && step) {
      flat.push({ ...step, questId: quest.id, questTitle: quest.title })
    } else {
      staged.push(quest)
    }
  }

  return { flat, staged }
}

export const NODE_W = 208
export const NODE_H = 92

/** Nodes land on this lattice, so a hand-dragged graph still lines up. */
export const GRID = 8

export function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

export function snap(value: number): number {
  return Math.round(value / GRID) * GRID
}

export function emptyGraph(): QuestGraph {
  return {
    nodes: [
      { id: 'start', type: 'start', x: 64, y: 160, title: 'Start', data: {} },
      { id: 'stage-1', type: 'stage', x: 360, y: 160, title: 'Stage 1', data: {} },
      { id: 'end', type: 'end', x: 656, y: 160, title: 'End', data: {} },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'stage-1' },
      { id: 'e2', from: 'stage-1', to: 'end' },
    ],
  }
}

export function port(node: GraphNode, side: 'in' | 'out'): { x: number; y: number } {
  return {
    x: node.x + (side === 'out' ? NODE_W : 0),
    y: node.y + NODE_H / 2,
  }
}

export interface Point {
  x: number
  y: number
}

/** How far a wire leaves its pin horizontally before it starts bending. */
function bend(from: Point, to: Point): number {
  return Math.max(40, Math.abs(to.x - from.x) * 0.45)
}

export function wirePath(from: Point, to: Point): string {
  const mid = bend(from, to)
  return `M ${from.x} ${from.y} C ${from.x + mid} ${from.y}, ${to.x - mid} ${to.y}, ${to.x} ${to.y}`
}

/** Where the cut-the-wire handle sits: the midpoint of that curve. */
export function wireMid(from: Point, to: Point): Point {
  const mid = bend(from, to)
  // Bezier at t = 0.5 reduces to this average of the four control points.
  return {
    x: (from.x + 3 * (from.x + mid) + 3 * (to.x - mid) + to.x) / 8,
    y: (from.y + 3 * from.y + 3 * to.y + to.y) / 8,
  }
}

/**
 * The box a wire cannot leave, so the layer drawing it knows how big to be.
 *
 * A cubic stays inside the hull of its four control points, and the two middle
 * ones sit a bend either side of the pins — a wire drawn back towards its own
 * source bows well past both ends, so its endpoints alone are not the extent.
 */
export function wireBox(from: Point, to: Point): { minX: number; minY: number; maxX: number; maxY: number } {
  const mid = bend(from, to)
  const xs = [from.x, from.x + mid, to.x - mid, to.x]
  return {
    minX: Math.min(...xs),
    minY: Math.min(from.y, to.y),
    maxX: Math.max(...xs),
    maxY: Math.max(from.y, to.y),
  }
}

export type NodeCategory = 'flow' | 'gate' | 'payout'

export interface NodeKind {
  type: GraphNodeType
  /** Which rail of the palette it belongs to, and which colour it wears. */
  category: NodeCategory
  label: TranslationKey
  /** Scored against something the server already counts (task, objective). */
  measured: boolean
  /** Carries an XP or coin payout. */
  pays: boolean
  /** A player has to finish and collect it before the next node opens. */
  gates: boolean
}

/**
 * One table the palette, the board and the inspector all read from, so a node
 * type cannot look like a gate in one place and a marker in another.
 */
export const NODE_KINDS: NodeKind[] = [
  { type: 'start', category: 'flow', label: 'economy.flow_start', measured: false, pays: false, gates: false },
  { type: 'stage', category: 'flow', label: 'economy.flow_stage', measured: false, pays: false, gates: false },
  { type: 'end', category: 'flow', label: 'economy.flow_end', measured: false, pays: false, gates: false },
  { type: 'area', category: 'gate', label: 'economy.flow_area', measured: false, pays: true, gates: true },
  { type: 'find', category: 'gate', label: 'economy.flow_find', measured: false, pays: true, gates: true },
  { type: 'collect', category: 'gate', label: 'economy.flow_collect', measured: false, pays: true, gates: true },
  { type: 'kills', category: 'gate', label: 'economy.flow_kills', measured: false, pays: true, gates: true },
  { type: 'task', category: 'gate', label: 'economy.flow_task', measured: true, pays: true, gates: true },
  { type: 'objective', category: 'gate', label: 'economy.flow_objective', measured: true, pays: true, gates: true },
  { type: 'reward', category: 'payout', label: 'economy.flow_reward', measured: false, pays: true, gates: false },
]

export const CATEGORY_LABELS: Record<NodeCategory, TranslationKey> = {
  flow: 'economy.flow_cat_flow',
  gate: 'economy.flow_cat_gate',
  payout: 'economy.flow_cat_payout',
}

export const MEASURE_LABELS: Record<string, TranslationKey> = {
  play: 'economy.objective_kind_play',
  kills: 'economy.objective_kind_kills',
  hours: 'economy.objective_kind_hours',
  spend: 'economy.objective_kind_spend',
  trade: 'economy.objective_kind_trade',
  manual: 'economy.objective_kind_manual',
}

export const MEASURES = Object.keys(MEASURE_LABELS)

export function kindOf(type: string): NodeKind | null {
  return NODE_KINDS.find((kind) => kind.type === type) ?? null
}

export function defaultData(type: GraphNodeType): GraphNodeData {
  switch (type) {
    case 'task':
      return { measure: 'play', goal: 1, cadence: 'once', xp: 0, coins: 10 }
    case 'objective':
      return { measure: 'play', goal: 1, cadence: 'once', xp: 50, coins: 0 }
    case 'reward':
      return { xp: 25, coins: 0 }
    case 'area':
      return { area_x: 10800, area_y: 9800, area_radius: 25, xp: 0, coins: 0 }
    case 'find':
      return { item_type: 'Base.Axe', goal: 1, xp: 0, coins: 0 }
    case 'collect':
      return { item_type: 'Base.Nails', goal: 20, xp: 0, coins: 0 }
    case 'kills':
      return { goal: 10, xp: 0, coins: 0 }
    default:
      return {}
  }
}

type Translate = (key: TranslationKey, replacements?: Record<string, string | number>) => string

/**
 * The node's rule in one line, so the board can be read without clicking
 * every card to find out what it asks for.
 */
export function summarise(node: GraphNode, t: Translate): string {
  const goal = node.data.goal ?? 1

  switch (node.type) {
    case 'start':
      return t('economy.flow_summary_start')
    case 'stage':
      return t('economy.flow_summary_stage')
    case 'end':
      return t('economy.flow_summary_end')
    case 'area':
      return node.data.area_cells && node.data.area_cells.length > 0
        ? t('economy.flow_area_tiles', { count: node.data.area_cells.length })
        : t('economy.flow_area_hint', {
            x: Math.round(node.data.area_x ?? 0),
            y: Math.round(node.data.area_y ?? 0),
            r: Math.round(node.data.area_radius ?? 0),
          })
    case 'find':
      return t('economy.flow_summary_find', { item: node.data.item_type || '—' })
    case 'collect':
      return t('economy.flow_summary_collect', { count: goal, item: node.data.item_type || '—' })
    case 'kills':
      return t('economy.flow_summary_kills', { count: goal })
    case 'task':
    case 'objective': {
      const measure = node.data.measure ? MEASURE_LABELS[node.data.measure] : undefined
      return t('economy.flow_summary_measure', {
        measure: measure ? t(measure) : t('economy.flow_summary_unset'),
        goal,
      })
    }
    case 'reward':
      return t('economy.flow_summary_reward')
    default:
      return ''
  }
}

export function payoutOf(node: GraphNode): { xp: number; coins: number } {
  return { xp: node.data.xp ?? 0, coins: node.data.coins ?? 0 }
}

export function totalPayout(graph: QuestGraph): { xp: number; coins: number } {
  return graph.nodes.reduce(
    (total, node) => {
      const payout = payoutOf(node)
      return { xp: total.xp + payout.xp, coins: total.coins + payout.coins }
    },
    { xp: 0, coins: 0 },
  )
}

export interface GraphProblem {
  id: string
  /** Errors are what the server rejects; warnings are traps it accepts. */
  level: 'error' | 'warning'
  nodeId: string | null
  key: TranslationKey
  params?: Record<string, string | number>
}

const MAX_NODES = 80

/**
 * The same rules `validate_graph` enforces on the server, plus the traps it
 * happily accepts: a node nothing wires into is live from the first second,
 * and a staff-grant step inside a flow can never be marked done, so every
 * node behind it stays locked forever.
 */
export function checkGraph(graph: QuestGraph): GraphProblem[] {
  const problems: GraphProblem[] = []
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, number>()

  for (const edge of graph.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1)
  }

  if (graph.nodes.length > MAX_NODES) {
    problems.push({
      id: 'max',
      level: 'error',
      nodeId: null,
      key: 'economy.flow_problem_max',
      params: { count: MAX_NODES },
    })
  }

  const starts = graph.nodes.filter((node) => node.type === 'start')
  if (starts.length === 0) {
    problems.push({ id: 'start', level: 'error', nodeId: null, key: 'economy.flow_problem_no_start' })
  } else if (starts.length > 1) {
    for (const node of starts.slice(1)) {
      problems.push({
        id: `many-start-${node.id}`,
        level: 'error',
        nodeId: node.id,
        key: 'economy.flow_problem_many_starts',
      })
    }
  }

  for (const node of graph.nodes) {
    const kind = kindOf(node.type)

    if (kind?.measured && !MEASURES.includes(node.data.measure ?? '')) {
      problems.push({
        id: `measure-${node.id}`,
        level: 'error',
        nodeId: node.id,
        key: 'economy.flow_problem_measure',
      })
    }

    if (node.type === 'area') {
      const painted = (node.data.area_cells ?? []).length > 0
      const circle =
        node.data.area_x != null && node.data.area_y != null && (node.data.area_radius ?? 0) >= 1
      if (!painted && !circle) {
        problems.push({
          id: `area-${node.id}`,
          level: 'error',
          nodeId: node.id,
          key: 'economy.flow_problem_area',
        })
      }
    }

    if ((node.type === 'find' || node.type === 'collect') && !isItemType(node.data.item_type)) {
      problems.push({
        id: `item-${node.id}`,
        level: 'error',
        nodeId: node.id,
        key: 'economy.flow_problem_item',
      })
    }

    if ((node.type === 'collect' || node.type === 'kills') && (node.data.goal ?? 0) < 1) {
      problems.push({
        id: `count-${node.id}`,
        level: 'error',
        nodeId: node.id,
        key: 'economy.flow_problem_count',
      })
    }

    if (node.type !== 'start' && !incoming.has(node.id)) {
      problems.push({
        id: `orphan-${node.id}`,
        level: 'warning',
        nodeId: node.id,
        key: 'economy.flow_problem_orphan',
      })
    }

    if (node.type !== 'end' && !outgoing.has(node.id)) {
      problems.push({
        id: `dead-${node.id}`,
        level: 'warning',
        nodeId: node.id,
        key: 'economy.flow_problem_dead_end',
      })
    }

    if (kind?.measured && node.data.measure === 'manual') {
      problems.push({
        id: `manual-${node.id}`,
        level: 'warning',
        nodeId: node.id,
        key: 'economy.flow_problem_manual',
      })
    }

    if (node.type === 'reward' && (node.data.xp ?? 0) === 0 && (node.data.coins ?? 0) === 0) {
      problems.push({
        id: `empty-${node.id}`,
        level: 'warning',
        nodeId: node.id,
        key: 'economy.flow_problem_reward_empty',
      })
    }

    if (kind?.gates && node.data.cadence === 'daily' && (outgoing.get(node.id) ?? 0) > 0) {
      problems.push({
        id: `daily-${node.id}`,
        level: 'warning',
        nodeId: node.id,
        key: 'economy.flow_problem_daily',
      })
    }
  }

  for (const node of cycleNodes(graph)) {
    problems.push({
      id: `loop-${node}`,
      level: 'error',
      nodeId: node,
      key: 'economy.flow_problem_loop',
    })
  }

  return problems
}

/** `Base.Axe` — what `economy::item_type` accepts on the way in. */
function isItemType(value: string | null | undefined): boolean {
  const trimmed = (value ?? '').trim()
  return trimmed.length >= 3 && trimmed.length <= 80 && /^[A-Za-z0-9._]+$/.test(trimmed) && trimmed.includes('.')
}

/** Ids that sit on a cycle, so the board can point at the loop it found. */
function cycleNodes(graph: QuestGraph): string[] {
  const next = new Map<string, string[]>()
  for (const edge of graph.edges) {
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to])
  }

  const found = new Set<string>()
  const done = new Set<string>()
  const stack: string[] = []

  function walk(id: string) {
    const loop = stack.indexOf(id)
    if (loop >= 0) {
      for (const member of stack.slice(loop)) {
        found.add(member)
      }
      return
    }
    if (done.has(id)) {
      return
    }
    stack.push(id)
    for (const child of next.get(id) ?? []) {
      walk(child)
    }
    stack.pop()
    done.add(id)
  }

  for (const node of graph.nodes) {
    walk(node.id)
  }
  return [...found]
}

/**
 * Depth of every node, counted as the longest path from a node nothing wires
 * into. Shared by the tidy button and the player-order preview.
 */
function depths(graph: QuestGraph): Map<string, number> {
  const incoming = new Map<string, string[]>()
  for (const edge of graph.edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from])
  }

  const depth = new Map<string, number>()
  const busy = new Set<string>()

  function walk(id: string): number {
    const known = depth.get(id)
    if (known !== undefined) {
      return known
    }
    if (busy.has(id)) {
      return 0
    }
    busy.add(id)
    const parents = incoming.get(id) ?? []
    const value = parents.length === 0 ? 0 : Math.max(...parents.map(walk)) + 1
    busy.delete(id)
    depth.set(id, value)
    return value
  }

  for (const node of graph.nodes) {
    walk(node.id)
  }
  return depth
}

/** Comb the graph into columns so a hand-dragged mess reads left to right. */
export function autoLayout(graph: QuestGraph): QuestGraph {
  const depth = depths(graph)
  const columns = new Map<number, GraphNode[]>()

  for (const node of graph.nodes) {
    const column = depth.get(node.id) ?? 0
    columns.set(column, [...(columns.get(column) ?? []), node])
  }

  const placed = new Map<string, { x: number; y: number }>()
  for (const [column, nodes] of columns) {
    const ordered = [...nodes].sort((a, b) => a.y - b.y)
    ordered.forEach((node, index) => {
      placed.set(node.id, {
        x: snap(64 + column * (NODE_W + 88)),
        y: snap(64 + index * (NODE_H + 44)),
      })
    })
  }

  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, ...(placed.get(node.id) ?? {}) })),
  }
}

export function graphBounds(graph: QuestGraph): { x: number; y: number; width: number; height: number } {
  if (graph.nodes.length === 0) {
    return { x: 0, y: 0, width: NODE_W, height: NODE_H }
  }
  const minX = Math.min(...graph.nodes.map((node) => node.x))
  const minY = Math.min(...graph.nodes.map((node) => node.y))
  const maxX = Math.max(...graph.nodes.map((node) => node.x + NODE_W))
  const maxY = Math.max(...graph.nodes.map((node) => node.y + NODE_H))
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * The gates and payouts in the order a player meets them — the same reading
 * the wallet page gives them, without leaving the editor.
 */
export function playerSteps(graph: QuestGraph): GraphNode[] {
  const depth = depths(graph)
  return graph.nodes
    .filter((node) => kindOf(node.type)?.category !== 'flow')
    .sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || a.y - b.y)
}
