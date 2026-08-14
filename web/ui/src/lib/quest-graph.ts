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

export const NODE_W = 196
export const NODE_H = 88

export function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

export function emptyGraph(): QuestGraph {
  return {
    nodes: [
      { id: 'start', type: 'start', x: 80, y: 180, title: 'Start', data: {} },
      { id: 'stage-1', type: 'stage', x: 320, y: 180, title: 'Stage 1', data: {} },
      { id: 'end', type: 'end', x: 560, y: 180, title: 'End', data: {} },
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

export function wirePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const mid = Math.max(40, Math.abs(to.x - from.x) * 0.45)
  return `M ${from.x} ${from.y} C ${from.x + mid} ${from.y}, ${to.x - mid} ${to.y}, ${to.x} ${to.y}`
}
