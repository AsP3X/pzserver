/**
 * Typed client for the Rust API.
 *
 * Requests are same-origin by default: Vite proxies /api in dev and nginx
 * proxies it in production, so the browser never makes a cross-origin call
 * unless VITE_API_BASE_URL points somewhere else.
 */

const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export type GameState = 'offline' | 'starting' | 'online'

export type ContainerState =
  | 'not_found'
  | 'created'
  | 'running'
  | 'paused'
  | 'restarting'
  | 'removing'
  | 'exited'
  | 'dead'
  | 'unknown'

export type DataSource = 'lua_bridge' | 'rcon' | 'none'

export interface ServerStatus {
  state: GameState
  online: boolean
  container: ContainerState
  player_count: number
  players: string[]
  max_players: number | null
  map: string | null
  uptime_seconds: number | null
  data_source: DataSource
  checked_at: string
  connect: { host: string; port: number } | null
}

export interface StatsSummary {
  total_players: number
  total_zombie_kills: number
  total_hours_survived: number
  total_deaths: number
  total_pvp_kills: number
  most_popular_profession: string | null
}

export interface LeaderboardEntry {
  rank: number
  username: string
  zombie_kills: number
  hours_survived: number
  profession: string | null
  is_dead: boolean
}

export interface StatusSample {
  sampled_at: string
  online: boolean
  player_count: number
}

export interface SiteFeature {
  icon: string
  title: string
  description: string
}

export interface SiteSettings {
  site_name: string
  hero_badge: string
  hero_title: string
  hero_subtitle: string
  hero_description: string
  hero_cta_label: string
  footer_text: string
  features: SiteFeature[]
  connect_host: string | null
  connect_port: number
  discord_url: string | null
  default_locale: string
}

export interface CharacterVitals {
  health: number | null
  bleeding_parts: number
  infected: boolean
  has_cold: boolean
}

export interface CharacterTrait {
  id: string
  label: string
}

export interface Character {
  username: string
  zombie_kills: number
  hours_survived: number
  profession: string | null
  /** Perk name to level. Untrained perks are absent, not zero. */
  skills: Record<string, number>
  /** Absent on KnoxRelay builds older than 1.3. */
  traits: CharacterTrait[] | null
  vitals: CharacterVitals | null
  is_dead: boolean
  rank: number
  last_synced_at: string
}

export interface BodyPartHealth {
  health: number
  /** `Scratch`, `Bite`, `Cut`, `Burn`, `Infection`, … as the mod names them. */
  wounds: string[]
}

export interface BodyWound {
  part: string
  type: string
  severity: string | null
  /** Bandaged or stitched — as close as PZ gets to a treated flag. */
  treated: boolean
}

export interface BodyPartTemperature {
  skin: number
  insulation: number
}

/** The mod's per-player heartbeat: richer than the summary on the character. */
export interface PlayerBody {
  health: { overall: number; parts: Record<string, BodyPartHealth> } | null
  wounds: BodyWound[] | null
  temperature: {
    core: number
    body_heat: number
    parts: Record<string, BodyPartTemperature>
  } | null
  /** The file outlives the session, so this says how live the reading is. */
  reported_at: string | null
}

export interface MyCharacterResponse {
  /** Null when the account has never been seen in game. */
  character: Character | null
  online: boolean
  body: PlayerBody | null
}

export type UserRole = 'super_admin' | 'admin' | 'moderator' | 'player'

export interface User {
  id: string
  /** The PZ name. Always present: an account only exists for a proven character. */
  username: string
  email: string
  role: UserRole
  steam_id: string | null
  created_at: string
}

/** `user` is null when nobody is signed in — this endpoint never 401s. */
export interface MeResponse {
  user: User | null
}

export interface SessionResponse {
  user: User
}

export interface RegisterInput {
  /** Issued in game by `/account register`. */
  code: string
  email: string
  password: string
}

export interface LoginInput {
  email: string
  password: string
}

export interface ChangePasswordInput {
  current_password: string
  new_password: string
}

/** An error the API reported in its own envelope, or a transport failure. */
export class ApiError extends Error {
  // Declared as fields rather than constructor parameter properties, which
  // `erasableSyntaxOnly` disallows.
  readonly status: number
  readonly code: string
  /** Which input the message belongs to, when the API said. */
  readonly field: string | null

  constructor(message: string, status: number, code: string, field: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.field = field
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response

  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...init?.headers },
      // Same-origin would send the session cookie anyway; this keeps auth
      // working if VITE_API_BASE_URL ever points at another host.
      credentials: 'include',
    })
  } catch (cause) {
    // Network-level failure: no response at all. Status 0 marks it as such.
    throw new ApiError(
      cause instanceof Error ? cause.message : 'Network request failed',
      0,
      'network_error',
    )
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string; field?: string } }
      | null

    throw new ApiError(
      body?.error?.message ?? `Request failed with ${response.status}`,
      response.status,
      body?.error?.code ?? 'unknown_error',
      body?.error?.field ?? null,
    )
  }

  // 204 has no body to parse.
  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export const api = {
  serverStatus: () => request<ServerStatus>('/api/v1/server/status'),

  serverHistory: (hours = 24) =>
    request<StatusSample[]>(`/api/v1/server/history?hours=${hours}`),

  statsSummary: () => request<StatsSummary>('/api/v1/stats/summary'),

  leaderboard: (stat: 'zombie_kills' | 'hours_survived' = 'zombie_kills', limit = 10) =>
    request<LeaderboardEntry[]>(
      `/api/v1/stats/leaderboard?stat=${stat}&limit=${limit}`,
    ),

  site: (locale: string) =>
    request<SiteSettings>(`/api/v1/site?locale=${encodeURIComponent(locale)}`),

  currentUser: () => request<MeResponse>('/api/v1/auth/me'),

  myCharacter: () => request<MyCharacterResponse>('/api/v1/me/character'),

  register: (input: RegisterInput) =>
    post<SessionResponse>('/api/v1/auth/register', input),

  login: (input: LoginInput) => post<SessionResponse>('/api/v1/auth/login', input),

  logout: () => post<void>('/api/v1/auth/logout', {}),

  changePassword: (input: ChangePasswordInput) =>
    post<void>('/api/v1/auth/password', input),
}
