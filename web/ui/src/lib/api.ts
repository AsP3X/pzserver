/**
 * Typed client for the Rust API.
 *
 * Requests are same-origin by default: Vite proxies /api in dev and nginx
 * proxies it in production, so the browser never makes a cross-origin call
 * unless VITE_API_BASE_URL points somewhere else.
 */

import type { PlayerLook } from '@/lib/player-look'

const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export type { PlayerLook }

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

/**
 * What the game server's last boot concluded about its own install.
 *
 * `unknown` means no report yet — a normal first boot, and healthy.
 * `unverifiable` is the odd one: it boots, but is *not* healthy. The manifest
 * was there and unreadable, so the ability to notice a stale build was lost.
 */
export type UpdateVerdict =
  | 'ok'
  | 'behind'
  | 'update_required'
  | 'manifest_retired'
  | 'missing'
  | 'unverifiable'
  | 'unknown'

/** Public-safe view. Never carries the diagnosis. */
export interface PublicUpdate {
  verdict: UpdateVerdict
  healthy: boolean
  installed_build: string | null
  target_build: string | null
}

/** Staff-only. `diagnosis` can name filesystem paths. */
export interface UpdateReport {
  verdict: UpdateVerdict
  installed_build: string | null
  target_build: string | null
  state_flags: number | null
  branch: string | null
  pinned_manifest: string | null
  last_updated: number | null
  checked_at: number | null
  /** False with a bad verdict means the game is deliberately held down. */
  booted: boolean
  auto_repaired: boolean
  diagnosis: string | null
}

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
  update: PublicUpdate
  checked_at: string
  connect: { host: string; port: number } | null
}

/**
 * The mod's own ranking of what finished someone off. Anything else the export
 * carries is shown as written rather than dropped — the dev seed says
 * `zombie`, and a future mod build may tell more causes apart.
 */
export type DeathCause = 'player' | 'fire' | 'infection' | 'unknown'

export interface Obit {
  username: string
  cause: DeathCause | string
  /** Set only when another player was credited. */
  killer: string | null
  /** The item type as the game names it — `Base.Axe`, not "Fire Axe". */
  weapon: string | null
  hours_survived: number
  zombie_kills: number
  x: number | null
  y: number | null
  /** The in-game date, as the mod wrote it. Reads 1993. */
  world_time: string | null
  occurred_at: string
}

export interface ObituaryPage {
  deaths: Obit[]
  /** Cursor for the next page, or null at the end of the roll. */
  next_before: string | null
}

export interface ObituarySummary {
  total_deaths: number
  total_pvp_deaths: number
  longest_life: number
  deadliest_survivor: string | null
  deadliest_survivor_kills: number
}

export interface StatsSummary {
  total_players: number
  total_zombie_kills: number
  total_hours_survived: number
  total_deaths: number
  total_pvp_kills: number
  most_popular_profession: string | null
}

export type LeaderboardStat = 'zombie_kills' | 'hours_survived' | 'deaths'

export interface LeaderboardEntry {
  rank: number
  username: string
  zombie_kills: number
  hours_survived: number
  profession: string | null
  is_dead: boolean
  deaths: number
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
  appearance: PlayerLook | null
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

export interface CharacterInfo {
  name: string | null
  profession: string | null
  traits: string[] | null
  /** Body weight in kilograms, not carried weight. */
  weight: number | null
  kills: number | null
  hours_survived: number | null
}

export interface SkillProgress {
  level: number
  /** Progress toward the next level, 0–1. */
  xp: number
}

/**
 * Needs and afflictions, each 0–1.
 *
 * All count up as things get worse except `endurance`, which is the reserve you
 * spend — a full bar there is good news.
 */
export interface Moodles {
  hunger: number | null
  thirst: number | null
  fatigue: number | null
  endurance: number | null
  stress: number | null
  panic: number | null
  boredom: number | null
  unhappiness: number | null
  pain: number | null
  wetness: number | null
  drunk: number | null
  sickness: number | null
  food_sickness: number | null
  has_cold: boolean | null
}

export interface Weapon {
  name: string | null
  /** Wear, 0–100, as a percent of the item's own condition ceiling. */
  condition: number | null
  sharpness: number | null
  attachments: string[] | null
  ammo: number | null
  chamber: boolean | null
  jam: boolean | null
}

export interface ClothingItem {
  slot: string
  name: string
  /** Wear, 0–100, as a percent of the garment's own condition ceiling. */
  condition: number
  holes: number
  /** Bite and scratch resistance, as percentages. */
  bite: number
  scratch: number
}

export interface Encumbrance {
  current: number | null
  capacity: number | null
}

export interface Recipe {
  name: string
  learned_at: string | null
}

/** The mod's per-player heartbeat: richer than the summary on the character. */
export interface PlayerBody {
  info: CharacterInfo | null
  health: { overall: number; parts: Record<string, BodyPartHealth> } | null
  wounds: BodyWound[] | null
  temperature: {
    core: number
    body_heat: number
    parts: Record<string, BodyPartTemperature>
  } | null
  moodles: Moodles | null
  weapon: Weapon | null
  clothing: { items: ClothingItem[] } | null
  encumbrance: Encumbrance | null
  skills: Record<string, SkillProgress> | null
  recipes: Recipe[] | null
  /** The file outlives the session, so this says how live the reading is. */
  reported_at: string | null
}

export interface InventoryItem {
  id: string
  full_type: string
  name: string
  category: string
  count: number
  /** Wear as a 0–1 fraction. Null for items that do not degrade. */
  condition: number | null
  equipped: boolean
  /** Display name of the container holding it. */
  container: string
  container_id: string
  /** Set when the item is itself a bag: the container id it opens into. */
  contains: string | null
}

export interface InventoryContainer {
  id: string
  /** Null for the player's own pockets. */
  parent: string | null
  name: string
  full_type: string | null
  item_id: string | null
  worn: boolean | null
  capacity: number | null
  /** Weight of this container's own contents. */
  weight: number | null
}

export interface InventorySnapshot {
  username: string
  timestamp: string | null
  items: InventoryItem[]
  containers: InventoryContainer[]
  weight: number
  max_weight: number
}

export interface InventoryHold {
  item_type: string
  item_name: string
  quantity: number
  kind: string
}

export interface MyInventoryResponse {
  /** Null until the mod has written a snapshot for this character. */
  snapshot: InventorySnapshot | null
  reported_at: string | null
  /** Whether a refresh would do anything — the mod only serves online players. */
  online: boolean
  /** Takes and gives waiting for the next join. */
  holds: InventoryHold[]
}

export interface MyPositionResponse {
  /** Null when the mod has never reported this character's position. */
  position: { x: number; y: number; z: number } | null
  reported_at: string | null
  online: boolean
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

/**
 * What a correct password produces.
 *
 * With two-factor on it is not a session — the cookie is only set once a code
 * is accepted, so a caller must handle both arms rather than assuming a user
 * came back.
 */
export type LoginOutcome =
  | { status: 'signed_in'; user: User }
  | { status: 'two_factor_required'; challenge: string; expires_at: string }

export interface TwoFactorStatus {
  enabled: boolean
  confirmed_at: string | null
  recovery_codes_left: number
}

/** Handed out once at the start of enrolment. */
export interface TwoFactorEnrolment {
  /** Base32, for typing in by hand. */
  secret: string
  /** `otpauth://…`, rendered as a QR code in the browser. */
  uri: string
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
  /** The in-game name. Registration collects an email too; login does not. */
  username: string
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

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' })
}

export interface AdminPlayer {
  username: string
  online: boolean
  is_dead: boolean
  zombie_kills: number
  hours_survived: number
  profession: string | null
  /** Overall body health 0–100, when the mod has written vitals. */
  health: number | null
  appearance: PlayerLook | null
  last_seen_at: string | null
  x: number | null
  y: number | null
  z: number | null
  sanction: PlayerSanction | null
}

export interface PlayerSanction {
  kind: 'suspend' | 'ban' | string
  expires_at: string | null
  reason: string | null
}

export interface CommandReply {
  output: string
}

export interface WipeResult {
  message: string
  include_config: boolean
  backup: string | null
  players_deleted: number
  filesystem_errors: string[]
}

export type AdminEventType = 'death' | 'pvp_kill'

export interface AdminEvent {
  id: number
  event_type: AdminEventType | string
  player: string
  target: string | null
  subject: string
  cause: string | null
  weapon: string | null
  x: number | null
  y: number | null
  z: number | null
  world_time: string | null
  occurred_at: string
}

export interface AdminEventLog {
  events: AdminEvent[]
  totals: {
    deaths: number
    pvp_kills: number
    last_24h: number
  }
}

export interface AdminEventsQuery {
  types?: AdminEventType[]
  from?: string
  to?: string
  limit?: number
}

export interface Sanction {
  id: number
  username: string
  reason: string | null
  duration_seconds: number | null
  starts_at: string
  expires_at: string | null
  lifted_at: string | null
  lifted_reason: string | null
}

export interface SanctionList {
  active: Sanction[]
  recent: Sanction[]
}

export type ReportKind = 'report' | 'support'
export type ReportStatus = 'open' | 'investigating' | 'resolved' | 'rejected'

export interface ReportMessage {
  id: number
  report_id: number
  author_role: 'player' | 'staff' | string
  author: string
  body: string
  created_at: string
}

export interface PlayerReport {
  id: number
  kind: ReportKind | string
  subject: string
  body: string
  accused: string | null
  status: ReportStatus | string
  resolution: string | null
  author: string
  handler: string | null
  created_at: string
  handled_at: string | null
  unread: boolean
  last_message_preview: string | null
  last_message_at: string | null
  messages: ReportMessage[]
}

export interface ReportQueue {
  reports: PlayerReport[]
  open_count: number
}

export interface ConfigField {
  key: string
  value: string
  secret: boolean
}

export interface ServerConfig {
  fields: ConfigField[]
  missing: boolean
}

export interface ModEntry {
  workshop_id: string
  mod_id: string
  protected: boolean
}

export interface WorkshopLookup {
  workshop_id: string
  found: boolean
  title: string
  preview_url: string | null
  mod_ids: string[]
  map_folders: string[]
}

export type BridgeFileStatus = 'fresh' | 'idle' | 'stale' | 'absent'

export interface BridgeFile {
  name: string
  present: boolean
  stale: boolean
  status: BridgeFileStatus
  reason: string
  modified_at: string | null
}

export interface BridgeHealth {
  files: BridgeFile[]
  directory: string
  world_paused: boolean
  world_fresh: boolean
}

export interface ContainerLogs {
  container: string
  lines: string[]
}

export type BackupType =
  | 'manual'
  | 'scheduled'
  | 'daily'
  | 'pre_rollback'
  | 'pre_update'
  | 'pre_import'

export interface BackupRecord {
  id: string
  filename: string
  size_bytes: number
  size_human: string
  type: BackupType | string
  game_version: string | null
  steam_branch: string | null
  notes: string | null
  created_at: string
  missing: boolean
}

export interface BackupJob {
  kind: string
  started_at: string
  detail: string
}

export interface BackupList {
  backups: BackupRecord[]
  job: BackupJob | null
  last_error: string | null
}

export interface BackupArchiveEntry {
  path: string
  size_bytes: number
  dir: boolean
}

export interface BackupArchiveListing {
  entries: BackupArchiveEntry[]
  file_count: number
  dir_count: number
}

export interface BackupArchiveFile {
  path: string
  name: string
  language: string
  size_bytes: number
  truncated: boolean
  content: string
}

export type AutomationAction =
  | 'restart'
  | 'start'
  | 'stop'
  | 'save'
  | 'backup'
  | 'broadcast'
  | 'rcon'
  | 'whitelist_open'
  | 'whitelist_close'
  | 'config'
  | 'kick_all'
  | 'rollback'
  | 'cycle'
  | 'chopper'
  | 'gunshot'
  | 'rain_start'
  | 'rain_stop'
  | 'thunder'

export type AutomationScheduleKind = 'times' | 'every'

export interface Automation {
  id: string
  name: string
  enabled: boolean
  action: AutomationAction | string
  message: string | null
  warn_seconds: number
  warn_message: string | null
  schedule_kind: AutomationScheduleKind | string
  times: string[]
  every_minutes: number | null
  last_run_at: string | null
  last_status: string | null
  last_error: string | null
  next_run_at: string | null
  created_at: string
}

export interface AutomationInput {
  name?: string
  enabled?: boolean
  action?: AutomationAction | string
  message?: string | null
  warn_seconds?: number
  warn_message?: string | null
  schedule_kind?: AutomationScheduleKind | string
  times?: string[]
  every_minutes?: number | null
}

export interface AutomationRun {
  id: string
  automation_id: string
  started_at: string
  finished_at: string | null
  status: string
  detail: string | null
}

export interface AuditEntry {
  id: string
  actor_id: string | null
  actor: string
  action: string
  method: string
  path: string
  target: string | null
  status: number
  details: unknown
  ip_address: string | null
  created_at: string
}

export interface WalletView {
  user_id: string
  balance: number
  available: number
  held: number
  total_earned: number
  total_spent: number
  updated_at: string
}

/** One survivor's public record, as the profile page shows it. */
export interface PlayerProfile {
  username: string
  zombie_kills: number
  hours_survived: number
  profession: string | null
  is_dead: boolean
  /** Perk name to level, as the mod exports it. */
  skills: Record<string, number>
  traits: unknown
  first_seen_at: string
  last_synced_at: string
  deaths: number
  pvp_kills: number
  kills_rank: number | null
  hours_rank: number | null
}

/** Steam branch the next game-server boot will install, plus install health. */
export interface UpdateStatus {
  branch: string
  branches: string[]
  report: UpdateReport
}

export interface WhitelistSync {
  added: string[]
  failed: string[]
  /** On the game whitelist with no website account — reported, not removed. */
  unmatched: string[]
}

/** One player waiting out a respawn cooldown. */
export interface RespawnTimer {
  username: string
  died_at: string
  minutes_left: number
}

/**
 * The respawn cooldown, which the mod can only ask for.
 *
 * `KR_Cooldown` queues a kick and the API performs it over RCON — Lua cannot
 * disconnect anyone on a dedicated server. With the setting off the mod still
 * tracks deaths but queues nothing.
 */
export interface RespawnView {
  enabled: boolean
  delay_minutes: number
  timers: RespawnTimer[]
}

/** Coins paid per cash item. Read from the mod's money_deposit_config.json. */
export interface DepositRates {
  money_value: number
  bundle_value: number
}

/**
 * One banking of in-game cash.
 *
 * `pending` means the mod has the request but the character has not been seen
 * online yet. Coins only move on `credited` — the rates are frozen onto the row
 * when it opens, so a later rate change never reprices it.
 */
export interface MoneyDeposit {
  id: string
  user_id: string
  username: string
  status: 'pending' | 'credited' | 'failed' | 'cancelled' | string
  note_count: number
  bundle_count: number
  coins: number
  note_value: number
  bundle_value: number
  detail: string | null
  wallet_transaction_id: string | null
  attempts: number
  created_at: string
  finished_at: string | null
}

/**
 * What banking right now would pay, from the mod's last inventory snapshot.
 *
 * A reading, not a promise: the mod counts again when it strips the cash, so
 * anything picked up since the snapshot is included and this number is low.
 */
export interface DepositPreview {
  note_count: number
  bundle_count: number
  coins: number
  note_value: number
  bundle_value: number
  snapshot_missing: boolean
  snapshot_at: string | null
  /** Set while one is in flight — a second would find no cash and fail. */
  pending: MoneyDeposit | null
}

export interface AdminDeposits {
  rates: DepositRates
  deposits: MoneyDeposit[]
}

export interface WalletTransaction {
  id: string
  user_id: string
  kind: 'credit' | 'debit' | string
  amount: number
  balance_after: number
  source: string
  reference_type: string | null
  reference_id: string | null
  description: string | null
  created_at: string
}

export interface AdminWalletRow {
  user_id: string
  username: string
  balance: number
  available: number
  total_earned: number
  total_spent: number
  updated_at: string
}

export interface DailyReward {
  available: boolean
  claimed_today: boolean
  coins: number
  streak: number
  next_claim_at: string
  last_claim_at: string | null
}

export interface RewardTask {
  id: string
  coins: number
  progress: number
  goal: number
  complete: boolean
  claimed: boolean
}

export interface AccountRank {
  current: number
  xp: number
  into: number
  per_rank: number
}

export interface RewardsView {
  daily: DailyReward
  tasks: RewardTask[]
  quests: import('@/lib/quest-graph').QuestProgress[]
  available_quests: import('@/lib/quest-graph').QuestOffer[]
  rank: AccountRank
}

export interface RewardClaimResult {
  claimed: number
  xp: number
  rewards: RewardsView
}

export type StoreCategory = 'weapons' | 'ammo' | 'food' | 'medical' | 'tools' | 'clothing' | 'other'

export interface StoreItem {
  id: string
  name: string
  item_type: string
  description: string | null
  category: StoreCategory | string
  quantity: number
  price: number
  stock: number | null
  max_per_player: number | null
  featured: boolean
  active: boolean
  sort_order: number
}

export interface StoreItemInput {
  name?: string
  item_type?: string
  description?: string | null
  category?: string
  quantity?: number
  price?: number
  stock?: number | null
  max_per_player?: number | null
  featured?: boolean
  active?: boolean
  sort_order?: number
}

export interface StorePurchase {
  id: string
  user_id: string
  username?: string
  item_id: string | null
  item_type: string
  item_name: string
  quantity: number
  unit_price: number
  total_price: number
  status: string
  created_at: string
  finished_at: string | null
}

export interface AuctionListing {
  id: string
  seller_id: string
  item_type: string
  item_name: string
  quantity: number
  condition: number | null
  start_price: number
  buyout_price: number | null
  current_price: number
  current_bidder_id: string | null
  status: string
  ends_at: string
  created_at: string
  settled_at: string | null
  seller: string
  current_bidder: string | null
  bid_count: number
  next_bid: number
  mine: boolean
}

export interface AuctionBid {
  id: string
  listing_id: string
  bidder_id: string
  bidder: string
  amount: number
  created_at: string
}

export interface AuctionListInput {
  item_type: string
  item_name?: string
  quantity?: number
  condition?: number | null
  start_price: number
  buyout_price?: number | null
  hours?: number
}

export interface VaultItem {
  id: string
  item_type: string
  item_name: string
  category: string
  condition_bp: number
  quantity: number
  cargo_count: number
}

export interface VaultMove {
  id: string
  direction: 'store' | 'retrieve' | string
  status: 'pending' | 'done' | 'failed' | 'partial' | string
  item_type: string
  item_name: string
  category: string
  condition_bp: number
  requested: number
  actual: number
  fee: number
  cargo_count: number
  created_at: string
  finished_at: string | null
}

export interface VaultView {
  enabled: boolean
  items: VaultItem[]
  capacity: {
    used: number
    reserved: number
    total: number
    max: number
    upgrade_cost: number
    upgrade_increment: number
    at_max: boolean
  }
  fees: { flat: number; per_item: number }
  wallet: WalletView
  moves: VaultMove[]
}

export interface VaultSettings {
  enabled: boolean
  default_slots: number
  max_slots: number
  slot_upgrade_increment: number
  slot_upgrade_cost: number
  withdraw_fee_flat: number
  withdraw_fee_per_item: number
}

export interface AdminVault {
  settings: VaultSettings
  vaults: { user_id: string; username: string; used: number; total: number }[]
}

export interface VaultStoreInput {
  item_type: string
  item_name?: string
  category?: string
  condition?: number | null
  quantity?: number
  container_id?: string | null
}

export interface BackupSchedule {
  hourly_enabled: boolean
  daily_enabled: boolean
  daily_time: string
  retention_manual: number
  retention_scheduled: number
  retention_daily: number
  retention_pre_rollback: number
  retention_pre_update: number
  retention_pre_import: number
}

export interface SiteUpdate {
  site_name?: string
  hero_badge?: string
  hero_title?: string
  hero_subtitle?: string
  hero_description?: string
  hero_cta_label?: string
  footer_text?: string
  connect_host?: string
  connect_port?: number
  discord_url?: string
}

export interface SafeZone {
  id: string
  name: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface SafeZoneConfig {
  enabled: boolean
  zones: SafeZone[]
}

export interface SafeZoneInput {
  id?: string
  name: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export type PvpViolationStatus = 'pending' | 'dismissed' | 'actioned'

export interface PvpViolation {
  id: string
  attacker: string
  victim: string
  zone_id: string
  zone_name: string
  attacker_x: number | null
  attacker_y: number | null
  strike_number: number
  status: PvpViolationStatus
  resolution_note: string | null
  resolved_by: string | null
  occurred_at: string
  resolved_at: string | null
}

export interface SafeZoneView {
  config: SafeZoneConfig
  violations: PvpViolation[]
}

export interface NewsSummary {
  id: string
  slug: string
  title: string
  excerpt: string | null
  pinned: boolean
  published_at: string | null
  author: string | null
}

export interface NewsPost extends NewsSummary {
  body: string
  author_id: string | null
  created_at: string
  updated_at: string
}

export interface NewsPatch {
  title?: string
  excerpt?: string | null
  body?: string
  pinned?: boolean
  published?: boolean
}

export interface UiLanguage {
  code: string
  name: string
  native_name: string
  is_default: boolean
  is_active: boolean
  created_at: string
}

export interface TranslationCatalog {
  languages: UiLanguage[]
  overrides: Record<string, Record<string, string>>
}

export interface LanguagePatch {
  code?: string
  name?: string
  native_name?: string
  is_default?: boolean
  is_active?: boolean
}

export const api = {
  serverStatus: () => request<ServerStatus>('/api/v1/server/status'),

  obituary: (before?: string | null, limit = 25) =>
    request<ObituaryPage>(
      `/api/v1/obituary?limit=${limit}` +
        (before ? `&before=${encodeURIComponent(before)}` : ''),
    ),

  obituarySummary: () => request<ObituarySummary>('/api/v1/obituary/summary'),

  serverHistory: (hours = 24) =>
    request<StatusSample[]>(`/api/v1/server/history?hours=${hours}`),

  statsSummary: () => request<StatsSummary>('/api/v1/stats/summary'),

  leaderboard: (stat: LeaderboardStat = 'zombie_kills', limit = 10) =>
    request<LeaderboardEntry[]>(
      `/api/v1/stats/leaderboard?stat=${stat}&limit=${limit}`,
    ),

  site: (locale: string) =>
    request<SiteSettings>(`/api/v1/site?locale=${encodeURIComponent(locale)}`),

  currentUser: () => request<MeResponse>('/api/v1/auth/me'),

  myCharacter: () => request<MyCharacterResponse>('/api/v1/me/character'),

  myInventory: () => request<MyInventoryResponse>('/api/v1/me/inventory'),

  myPosition: () => request<MyPositionResponse>('/api/v1/me/position'),

  refreshInventory: () => post<void>('/api/v1/me/inventory/refresh', {}),

  myReports: () => request<PlayerReport[]>('/api/v1/me/reports'),

  fileReport: (input: { kind: ReportKind; subject: string; body: string; accused?: string }) =>
    post<PlayerReport>('/api/v1/me/reports', input),

  replyMyReport: (id: number, body: string) =>
    post<PlayerReport>(`/api/v1/me/reports/${id}/messages`, { body }),

  readMyReport: (id: number) => post<PlayerReport>(`/api/v1/me/reports/${id}/read`, {}),

  register: (input: RegisterInput) =>
    post<SessionResponse>('/api/v1/auth/register', input),

  login: (input: LoginInput) => post<LoginOutcome>('/api/v1/auth/login', input),

  twoFactorStatus: () => request<TwoFactorStatus>('/api/v1/auth/2fa'),

  beginTwoFactor: () => post<TwoFactorEnrolment>('/api/v1/auth/2fa/begin', {}),

  confirmTwoFactor: (code: string) =>
    post<{ recovery_codes: string[] }>('/api/v1/auth/2fa/confirm', { code }),

  disableTwoFactor: (password: string) =>
    post<void>('/api/v1/auth/2fa/disable', { password }),

  /** `challenge` is null on the Steam path, where a cookie carries it. */
  answerTwoFactor: (challenge: string | null, code: string) =>
    post<SessionResponse>('/api/v1/auth/2fa/challenge', { challenge, code }),

  logout: () => post<void>('/api/v1/auth/logout', {}),

  changePassword: (input: ChangePasswordInput) =>
    post<void>('/api/v1/auth/password', input),

  adminPlayers: () => request<AdminPlayer[]>('/api/v1/admin/players'),

  adminKick: (username: string, reason?: string) =>
    post<CommandReply>(`/api/v1/admin/players/${encodeURIComponent(username)}/kick`, {
      reason,
    }),

  adminBan: (username: string, reason?: string) =>
    post<Sanction>(`/api/v1/admin/players/${encodeURIComponent(username)}/ban`, {
      reason,
    }),

  adminUnban: (username: string) =>
    post<CommandReply>(`/api/v1/admin/players/${encodeURIComponent(username)}/unban`, {}),

  adminSuspend: (username: string, durationSeconds: number, reason?: string) =>
    post<Sanction>(`/api/v1/admin/players/${encodeURIComponent(username)}/suspend`, {
      duration_seconds: durationSeconds,
      reason,
    }),

  adminSanctions: () => request<SanctionList>('/api/v1/admin/sanctions'),

  playerProfile: (username: string) =>
    request<PlayerProfile>(`/api/v1/stats/players/${encodeURIComponent(username)}`),

  changeEmail: (input: { password: string; email: string }) =>
    post<SessionResponse>('/api/v1/auth/email', input),

  adminUpdateStatus: () => request<UpdateStatus>('/api/v1/admin/server/update'),

  adminUpdateServer: (input: { branch?: string; message?: string }) =>
    post<{ message: string }>('/api/v1/admin/server/update', input),

  adminSetPlayerPassword: (username: string, password: string) =>
    post<{ output: string }>(`/api/v1/admin/players/${username}/password`, { password }),

  adminWhitelistToggle: (username: string) =>
    post<{ whitelisted: boolean }>(`/api/v1/admin/whitelist/${username}/toggle`, {}),

  adminWhitelistSync: () => post<WhitelistSync>('/api/v1/admin/whitelist/sync', {}),

  adminRespawn: () => request<RespawnView>('/api/v1/admin/respawn'),

  adminSetRespawn: (enabled: boolean, delayMinutes: number) =>
    patch<RespawnView>('/api/v1/admin/respawn', {
      enabled,
      delay_minutes: delayMinutes,
    }),

  adminResetRespawn: (username: string) =>
    post<RespawnView>(`/api/v1/admin/respawn/${username}/reset`, {}),

  adminAccess: (username: string, level: string) =>
    post<CommandReply>(`/api/v1/admin/players/${encodeURIComponent(username)}/access`, {
      level,
    }),

  adminTeleport: (username: string, x: number, y: number, z = 0) =>
    post<CommandReply>(`/api/v1/admin/players/${encodeURIComponent(username)}/teleport`, {
      x,
      y,
      z,
    }),

  adminInventory: (username: string) =>
    request<InventorySnapshot | null>(
      `/api/v1/admin/players/${encodeURIComponent(username)}/inventory`,
    ),

  adminGiveItem: (username: string, itemType: string, count = 1) =>
    post<{ message: string }>(
      `/api/v1/admin/players/${encodeURIComponent(username)}/items/give`,
      { item_type: itemType, count },
    ),

  adminTakeItem: (username: string, itemType: string, count = 1) =>
    post<{ message: string }>(
      `/api/v1/admin/players/${encodeURIComponent(username)}/items/take`,
      { item_type: itemType, count },
    ),

  adminStart: () => post<CommandReply>('/api/v1/admin/server/start', {}),

  adminStop: (message?: string) =>
    post<CommandReply>('/api/v1/admin/server/stop', { message }),

  adminRestart: (message?: string) =>
    post<CommandReply>('/api/v1/admin/server/restart', { message }),

  adminSave: () => post<CommandReply>('/api/v1/admin/server/save', {}),

  adminWipe: (input: { confirm: boolean; include_config?: boolean; message?: string }) =>
    post<WipeResult>('/api/v1/admin/server/wipe', input),

  adminBroadcast: (message: string) =>
    post<CommandReply>('/api/v1/admin/broadcast', { message }),

  adminConsole: (command: string) =>
    post<CommandReply>('/api/v1/admin/console', { command }),

  adminConfig: () => request<ServerConfig>('/api/v1/admin/config'),

  adminUpdateConfig: (updates: Record<string, string>) =>
    patch<ServerConfig>('/api/v1/admin/config', { updates }),

  adminMods: () => request<ModEntry[]>('/api/v1/admin/mods'),

  adminAddMod: (workshopId: string, modId: string, mapFolder?: string) =>
    post<ModEntry[]>('/api/v1/admin/mods', {
      workshop_id: workshopId,
      mod_id: modId,
      map_folder: mapFolder,
    }),

  adminLookupMod: (workshopId: string) =>
    post<WorkshopLookup>('/api/v1/admin/mods/lookup', { workshop_id: workshopId }),

  adminReorderMods: (mods: ModEntry[]) =>
    request<ModEntry[]>('/api/v1/admin/mods/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mods }),
    }),

  adminImportMods: (input: {
    workshop_ids: string[]
    mod_ids: string[]
    map_folders?: string[]
  }) => post<ModEntry[]>('/api/v1/admin/mods/import', input),

  adminRemoveMod: (workshopId: string) =>
    del<ModEntry[]>(`/api/v1/admin/mods/${encodeURIComponent(workshopId)}`),

  adminSetOpen: (open: boolean) =>
    patch<ServerConfig>('/api/v1/admin/whitelist', { open }),

  adminWhitelistAdd: (username: string) =>
    post<CommandReply>(`/api/v1/admin/whitelist/${encodeURIComponent(username)}`, {}),

  adminWhitelistRemove: (username: string) =>
    del<CommandReply>(`/api/v1/admin/whitelist/${encodeURIComponent(username)}`),

  adminBridge: () => request<BridgeHealth>('/api/v1/admin/bridge'),

  adminLogs: (tail = 200) =>
    request<ContainerLogs>(`/api/v1/admin/logs?tail=${tail}`),

  adminEvents: (query: AdminEventsQuery = {}) => {
    const params = new URLSearchParams()
    if (query.types && query.types.length > 0) {
      params.set('types', query.types.join(','))
    }
    if (query.from) {
      params.set('from', query.from)
    }
    if (query.to) {
      params.set('to', query.to)
    }
    params.set('limit', String(query.limit ?? 200))
    return request<AdminEventLog>(`/api/v1/admin/events?${params}`)
  },

  adminSite: () => request<SiteSettings>('/api/v1/admin/site'),

  adminUpdateSite: (input: SiteUpdate) =>
    patch<SiteSettings>('/api/v1/admin/site', input),

  adminReports: () => request<ReportQueue>('/api/v1/admin/reports'),

  adminHandleReport: (id: number, status: ReportStatus, resolution?: string) =>
    patch<PlayerReport>(`/api/v1/admin/reports/${id}`, {
      status,
      resolution,
    }),

  adminBackups: () => request<BackupList>('/api/v1/admin/backups'),

  adminCreateBackup: (input: { notes?: string; notify_players?: boolean; message?: string }) =>
    post<{ message: string }>('/api/v1/admin/backups', input),

  adminDeleteBackup: (id: string) =>
    del<{ message: string }>(`/api/v1/admin/backups/${id}`),

  adminDeleteBackups: (ids: string[]) =>
    request<{ message: string }>('/api/v1/admin/backups', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),

  adminRollbackBackup: (
    id: string,
    input: { confirm: boolean; countdown?: number; message?: string },
  ) => post<{ message: string }>(`/api/v1/admin/backups/${id}/rollback`, input),

  adminBackupContents: (id: string) =>
    request<BackupArchiveListing>(`/api/v1/admin/backups/${id}/contents`),

  adminBackupFile: (id: string, path: string) =>
    request<BackupArchiveFile>(
      `/api/v1/admin/backups/${id}/file?path=${encodeURIComponent(path)}`,
    ),

  adminBackupSchedule: () => request<BackupSchedule>('/api/v1/admin/backups/schedule'),

  adminUpdateBackupSchedule: (input: Partial<BackupSchedule>) =>
    patch<BackupSchedule>('/api/v1/admin/backups/schedule', input),

  adminAutomations: () => request<Automation[]>('/api/v1/admin/automations'),

  adminCreateAutomation: (input: AutomationInput) =>
    post<Automation>('/api/v1/admin/automations', input),

  adminUpdateAutomation: (id: string, input: AutomationInput) =>
    patch<Automation>(`/api/v1/admin/automations/${id}`, input),

  adminDeleteAutomation: (id: string) =>
    del<{ message: string }>(`/api/v1/admin/automations/${id}`),

  adminRunAutomation: (id: string) =>
    post<Automation>(`/api/v1/admin/automations/${id}/run`, {}),

  adminAutomationRuns: (id: string) =>
    request<AutomationRun[]>(`/api/v1/admin/automations/${id}/runs`),

  adminAudit: (filter?: { actor?: string; action?: string; target?: string }) => {
    const params = new URLSearchParams()
    if (filter?.actor) params.set('actor', filter.actor)
    if (filter?.action) params.set('action', filter.action)
    if (filter?.target) params.set('target', filter.target)
    const query = params.toString()
    return request<AuditEntry[]>(`/api/v1/admin/audit${query ? `?${query}` : ''}`)
  },

  adminAuditActions: () => request<string[]>('/api/v1/admin/audit/actions'),

  myWallet: () => request<WalletView>('/api/v1/me/wallet'),

  myWalletTransactions: () =>
    request<WalletTransaction[]>('/api/v1/me/wallet/transactions'),

  depositPreview: () => request<DepositPreview>('/api/v1/me/deposit'),

  openDeposit: () => post<MoneyDeposit>('/api/v1/me/deposit', {}),

  myDeposits: () => request<MoneyDeposit[]>('/api/v1/me/deposit/history'),

  adminDeposits: () => request<AdminDeposits>('/api/v1/admin/bridge/deposits'),

  adminSetDepositRates: (rates: DepositRates) =>
    patch<DepositRates>('/api/v1/admin/bridge/deposits', rates),

  adminCancelDeposit: (id: string) =>
    post<MoneyDeposit>(`/api/v1/admin/bridge/deposits/${id}/cancel`, {}),

  adminCreditDeposit: (id: string, coins: number) =>
    post<MoneyDeposit>(`/api/v1/admin/bridge/deposits/${id}/credit`, { coins }),

  myRewards: () => request<RewardsView>('/api/v1/me/rewards'),

  claimReward: (key: string) =>
    post<RewardClaimResult>('/api/v1/me/rewards/claim', { key }),

  adminGrantQuestNode: (questId: string, nodeId: string, username: string) =>
    post<{ xp: number; coins: number; message: string }>(
      `/api/v1/admin/quests/${questId}/nodes/${nodeId}/grant`,
      { username },
    ),

  claimQuest: (questId: string) =>
    post<RewardClaimResult>(`/api/v1/me/rewards/quests/${questId}/claim`, {}),

  claimQuestNode: (questId: string, nodeId: string) =>
    post<RewardClaimResult>(
      `/api/v1/me/rewards/quests/${questId}/nodes/${encodeURIComponent(nodeId)}`,
      {},
    ),

  adminQuests: () => request<import('@/lib/quest-graph').Quest[]>('/api/v1/admin/quests'),

  adminQuest: (id: string) =>
    request<import('@/lib/quest-graph').Quest>(`/api/v1/admin/quests/${id}`),

  adminCreateQuest: (input: import('@/lib/quest-graph').QuestPatch) =>
    post<import('@/lib/quest-graph').Quest>('/api/v1/admin/quests', input),

  adminUpdateQuest: (id: string, input: import('@/lib/quest-graph').QuestPatch) =>
    patch<import('@/lib/quest-graph').Quest>(`/api/v1/admin/quests/${id}`, input),

  adminDeleteQuest: (id: string) =>
    del<{ message: string }>(`/api/v1/admin/quests/${id}`),

  adminGroups: () => request<import('@/lib/quest-graph').PlayerGroup[]>('/api/v1/admin/groups'),

  adminCreateGroup: (name: string) =>
    post<import('@/lib/quest-graph').PlayerGroup>('/api/v1/admin/groups', { name }),

  adminDeleteGroup: (id: string) => del<{ message: string }>(`/api/v1/admin/groups/${id}`),

  adminGroupMembers: (id: string) => request<string[]>(`/api/v1/admin/groups/${id}/members`),

  adminAddGroupMember: (id: string, username: string) =>
    post<{ message: string }>(`/api/v1/admin/groups/${id}/members`, { username }),

  adminRemoveGroupMember: (id: string, username: string) =>
    del<{ message: string }>(
      `/api/v1/admin/groups/${id}/members/${encodeURIComponent(username)}`,
    ),

  storeItems: () => request<StoreItem[]>('/api/v1/store'),

  buyStoreItem: (id: string, quantity = 1) =>
    post<StorePurchase>(`/api/v1/store/${id}/buy`, { quantity }),

  myStorePurchases: () => request<StorePurchase[]>('/api/v1/me/store/purchases'),

  auctions: () => request<AuctionListing[]>('/api/v1/auctions'),

  myAuctions: () => request<AuctionListing[]>('/api/v1/auctions/mine'),

  auction: (id: string) => request<AuctionListing>(`/api/v1/auctions/${id}`),

  listAuction: (input: AuctionListInput) =>
    post<AuctionListing>('/api/v1/auctions', input),

  bidAuction: (id: string, amount: number) =>
    post<AuctionListing>(`/api/v1/auctions/${id}/bid`, { amount }),

  buyoutAuction: (id: string) =>
    post<AuctionListing>(`/api/v1/auctions/${id}/buyout`, {}),

  cancelAuction: (id: string) =>
    post<{ message: string }>(`/api/v1/auctions/${id}/cancel`, {}),

  adminStoreItems: () => request<StoreItem[]>('/api/v1/admin/store'),

  adminCreateStoreItem: (input: StoreItemInput) =>
    post<StoreItem>('/api/v1/admin/store', input),

  adminUpdateStoreItem: (id: string, input: StoreItemInput) =>
    patch<StoreItem>(`/api/v1/admin/store/${id}`, input),

  adminDeleteStoreItem: (id: string) =>
    del<{ message: string }>(`/api/v1/admin/store/${id}`),

  adminStorePurchases: () => request<StorePurchase[]>('/api/v1/admin/store/purchases'),

  adminWallets: () => request<AdminWalletRow[]>('/api/v1/admin/wallets'),

  adminAdjustWallet: (userId: string, amount: number, reason?: string) =>
    post<WalletView>(`/api/v1/admin/wallets/${userId}`, { amount, reason }),

  adminWalletTransactions: (userId: string) =>
    request<WalletTransaction[]>(`/api/v1/admin/wallets/${userId}/transactions`),

  adminAuctions: () => request<AuctionListing[]>('/api/v1/admin/auctions'),

  adminAuctionBids: (id: string) =>
    request<AuctionBid[]>(`/api/v1/admin/auctions/${id}/bids`),

  adminCancelAuction: (id: string) =>
    post<{ message: string }>(`/api/v1/admin/auctions/${id}/cancel`, {}),

  myVault: () => request<VaultView>('/api/v1/me/vault'),

  storeInVault: (input: VaultStoreInput) =>
    post<VaultView>('/api/v1/me/vault/store', input),

  retrieveFromVault: (itemId: string, quantity: number) =>
    post<VaultView>('/api/v1/me/vault/retrieve', { item_id: itemId, quantity }),

  upgradeVault: () => post<VaultView>('/api/v1/me/vault/upgrade', {}),

  adminVault: () => request<AdminVault>('/api/v1/admin/vault'),

  adminUpdateVault: (input: Partial<VaultSettings>) =>
    patch<AdminVault>('/api/v1/admin/vault', input),

  adminImportWorld: async (file: File) => {
    const body = new FormData()
    body.append('file', file)
    return request<{ message: string }>('/api/v1/admin/backups/import', {
      method: 'POST',
      body,
    })
  },

  news: () => request<NewsSummary[]>('/api/v1/news'),

  newsPost: (slug: string) =>
    request<NewsPost>(`/api/v1/news/${encodeURIComponent(slug)}`),

  adminNews: () => request<NewsPost[]>('/api/v1/admin/news'),

  adminCreateNews: (input: NewsPatch) => post<NewsPost>('/api/v1/admin/news', input),

  adminUpdateNews: (id: string, input: NewsPatch) =>
    patch<NewsPost>(`/api/v1/admin/news/${id}`, input),

  adminDeleteNews: (id: string) =>
    del<{ message: string }>(`/api/v1/admin/news/${id}`),

  i18nLanguages: () => request<UiLanguage[]>('/api/v1/i18n/languages'),

  i18nOverrides: (locale: string) =>
    request<Record<string, string>>(`/api/v1/i18n/${encodeURIComponent(locale)}`),

  adminLanguages: () => request<UiLanguage[]>('/api/v1/admin/languages'),

  adminCreateLanguage: (input: LanguagePatch) =>
    post<UiLanguage>('/api/v1/admin/languages', input),

  adminUpdateLanguage: (code: string, input: LanguagePatch) =>
    patch<UiLanguage>(`/api/v1/admin/languages/${encodeURIComponent(code)}`, input),

  adminDeleteLanguage: (code: string) =>
    del<{ message: string }>(`/api/v1/admin/languages/${encodeURIComponent(code)}`),

  adminTranslations: () => request<TranslationCatalog>('/api/v1/admin/translations'),

  adminPutTranslation: (locale: string, key: string, value: string) =>
    put<{ message: string }>('/api/v1/admin/translations', { locale, key, value }),

  adminClearTranslation: (locale: string, key: string) =>
    request<{ message: string }>(
      `/api/v1/admin/translations?locale=${encodeURIComponent(locale)}&key=${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    ),

  adminImportTranslations: (locale: string, entries: Record<string, string>) =>
    put<{ message: string; count: number }>('/api/v1/admin/translations/import', {
      locale,
      entries,
    }),

  adminExportTranslations: (locale: string) =>
    request<Record<string, string>>(
      `/api/v1/admin/translations/export/${encodeURIComponent(locale)}`,
    ),

  safeZones: () => request<SafeZoneConfig>('/api/v1/safe-zones'),

  adminSafeZones: () => request<SafeZoneView>('/api/v1/admin/safe-zones'),

  adminSetSafeZonesEnabled: (enabled: boolean) =>
    patch<SafeZoneConfig>('/api/v1/admin/safe-zones/config', { enabled }),

  adminCreateSafeZone: (input: SafeZoneInput) =>
    post<SafeZoneConfig>('/api/v1/admin/safe-zones', input),

  adminDeleteSafeZone: (id: string) =>
    del<SafeZoneConfig>(`/api/v1/admin/safe-zones/${encodeURIComponent(id)}`),

  adminResolveViolation: (
    id: string,
    status: Exclude<PvpViolationStatus, 'pending'>,
    note?: string,
  ) =>
    post<PvpViolation>(`/api/v1/admin/safe-zones/violations/${id}`, {
      status,
      note,
    }),
}
