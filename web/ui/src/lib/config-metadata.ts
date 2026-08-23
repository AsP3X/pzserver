import { fallback, type TranslationKey } from '@/i18n/locales'

export const CONFIG_GROUPS = [
  'featured',
  'general',
  'players',
  'pvp',
  'world',
  'safehouses',
  'network',
  'chat',
  'saves',
  'security',
  'mods',
  'other',
] as const

export const SANDBOX_GROUPS = [
  'featured',
  'population',
  'lore',
  'time',
  'climate',
  'utilities',
  'loot',
  'world',
  'vehicles',
  'animals',
  'combat',
  'character',
  'skills',
  'map',
  'mods',
  'other',
] as const

export type ServerGroupId = (typeof CONFIG_GROUPS)[number]
export type SandboxGroupId = (typeof SANDBOX_GROUPS)[number]
export type ConfigGroupId = ServerGroupId | SandboxGroupId
export type ConfigSource = 'server' | 'sandbox'

export type SettingType = 'boolean' | 'number' | 'string' | 'text' | 'enum' | 'list' | 'password'

export interface SettingOption {
  value: string
  label?: TranslationKey
  /** Raw label from SandboxVars comments — already in the game's wording. */
  text?: string
}

export interface SettingMeta {
  type: SettingType
  group: string
  sensitive?: boolean
  readOnly?: boolean
  options?: readonly SettingOption[]
  min?: number
  max?: number
  step?: number | 'any'
}

/** Settings an operator changes on purpose, pinned at the top of the nav. */
export const FEATURED_KEYS = [
  'PublicName',
  'PublicDescription',
  'ServerWelcomeMessage',
  'MaxPlayers',
  'Password',
  'Open',
  'Public',
  'PVP',
  'PauseEmpty',
  'SaveWorldEveryMinutes',
  'SteamVAC',
  'Map',
  'SpawnPoint',
  'SleepAllowed',
  'VoiceEnable',
  'PlayerSafehouse',
  'Faction',
] as const

/** Sandbox options an operator actually means to change. */
export const SANDBOX_FEATURED_KEYS = [
  'Zombies',
  'DayLength',
  'NightLength',
  'HoursForLootRespawn',
  'ZombieLore.Speed',
  'ZombieLore.Transmission',
  'ZombieConfig.PopulationMultiplier',
  'FoodLootNew',
  'WaterShut',
  'ElecShut',
  'StarterKit',
  'MultiHitZombies',
  'CarSpawnRate',
] as const

const VISIBILITY: readonly SettingOption[] = [
  { value: '1', label: 'admin.config_opt_hidden' },
  { value: '2', label: 'admin.config_opt_friends' },
  { value: '3', label: 'admin.config_opt_everyone' },
]

export const SERVER_INI_META: Record<string, SettingMeta> = {
  // General
  PublicName: { type: 'string', group: 'general' },
  ServerName: { type: 'string', group: 'general' },
  PublicDescription: { type: 'text', group: 'general' },
  ServerWelcomeMessage: { type: 'text', group: 'general' },
  Public: { type: 'boolean', group: 'general' },
  Open: { type: 'boolean', group: 'general' },
  Password: { type: 'password', group: 'general', sensitive: true },
  AdminPassword: { type: 'password', group: 'general', sensitive: true },
  PauseEmpty: { type: 'boolean', group: 'general' },
  AutoCreateUserInWhiteList: { type: 'boolean', group: 'general' },
  MaxAccountsPerUser: { type: 'number', group: 'general', min: 0, max: 32 },
  AllowNonAsciiUsername: { type: 'boolean', group: 'general' },
  AllowCoop: { type: 'boolean', group: 'general' },
  server_browser_announced_ip: { type: 'string', group: 'general' },

  // Players
  MaxPlayers: { type: 'number', group: 'players', min: 1, max: 100 },
  SpawnPoint: { type: 'string', group: 'players' },
  SpawnItems: { type: 'string', group: 'players' },
  DisplayUserName: { type: 'boolean', group: 'players' },
  ShowFirstAndLastName: { type: 'boolean', group: 'players' },
  UsernameDisguises: { type: 'boolean', group: 'players' },
  HideDisguisedUserName: { type: 'boolean', group: 'players' },
  PlayerRespawnWithSelf: { type: 'boolean', group: 'players' },
  PlayerRespawnWithOther: { type: 'boolean', group: 'players' },
  RemovePlayerCorpsesOnCorpseRemoval: { type: 'boolean', group: 'players' },
  AnnounceDeath: { type: 'boolean', group: 'players' },
  AnnounceAnimalDeath: { type: 'boolean', group: 'players' },
  DropOffWhiteListAfterDeath: { type: 'boolean', group: 'players' },
  MouseOverToSeeDisplayName: { type: 'boolean', group: 'players' },
  HidePlayersBehindYou: { type: 'boolean', group: 'players' },
  HideAdminsInPlayerList: { type: 'boolean', group: 'players' },
  DisableScoreboard: { type: 'boolean', group: 'players' },
  ShowCoordinates: { type: 'boolean', group: 'players' },
  SteamScoreboard: { type: 'boolean', group: 'players' },

  // PVP
  PVP: { type: 'boolean', group: 'pvp' },
  SafetySystem: { type: 'boolean', group: 'pvp' },
  ShowSafety: { type: 'boolean', group: 'pvp' },
  SafetyToggleTimer: { type: 'number', group: 'pvp', min: 0, max: 60 },
  SafetyCooldownTimer: { type: 'number', group: 'pvp', min: 0, max: 60 },
  SafetyDisconnectDelay: { type: 'number', group: 'pvp', min: 0, max: 600 },
  PVPMeleeWhileHitReaction: { type: 'boolean', group: 'pvp' },
  PVPMeleeDamageModifier: { type: 'number', group: 'pvp', min: 0, max: 500, step: 0.1 },
  PVPFirearmDamageModifier: { type: 'number', group: 'pvp', min: 0, max: 500, step: 0.1 },
  PlayerBumpPlayer: { type: 'boolean', group: 'pvp' },
  PVPLogToolChat: { type: 'boolean', group: 'pvp' },
  PVPLogToolFile: { type: 'boolean', group: 'pvp' },

  // World
  Map: { type: 'string', group: 'world' },
  Seed: { type: 'string', group: 'world' },
  NightLength: { type: 'number', group: 'world', min: 0, max: 24 },
  DayLength: { type: 'number', group: 'world', min: 0, max: 24 },
  HoursForLootRespawn: { type: 'number', group: 'world', min: 0, max: 8760 },
  HoursForZombiesRespawn: { type: 'number', group: 'world', min: 0, max: 8760 },
  NoFire: { type: 'boolean', group: 'world' },
  SleepAllowed: { type: 'boolean', group: 'world' },
  SleepNeeded: { type: 'boolean', group: 'world' },
  KnockedDownAllowed: { type: 'boolean', group: 'world' },
  SneakModeHideFromOtherPlayers: { type: 'boolean', group: 'world' },
  UltraSpeedDoesnotAffectToAnimals: { type: 'boolean', group: 'world' },
  FastForwardMultiplier: { type: 'number', group: 'world', min: 1, max: 200, step: 0.1 },
  AllowDestructionBySledgehammer: { type: 'boolean', group: 'world' },
  SledgehammerOnlyInSafehouse: { type: 'boolean', group: 'world' },
  BloodSplatLifespanDays: { type: 'number', group: 'world', min: 0, max: 365 },
  ItemNumbersLimitPerContainer: { type: 'number', group: 'world', min: 0, max: 10000 },
  CarEngineAttractionModifier: { type: 'number', group: 'world', min: 0, max: 10, step: 0.1 },
  UsePhysicsHitReaction: { type: 'boolean', group: 'world' },
  SwitchZombiesOwnershipEachUpdate: { type: 'boolean', group: 'world' },
  DisableVehicleTowing: { type: 'boolean', group: 'world' },
  DisableTrailerTowing: { type: 'boolean', group: 'world' },
  DisableBurntTowing: { type: 'boolean', group: 'world' },
  MapRemotePlayerVisibility: { type: 'enum', group: 'world', options: VISIBILITY },
  TrashDeleteAll: { type: 'boolean', group: 'world' },

  // Safehouses / factions / war
  PlayerSafehouse: { type: 'boolean', group: 'safehouses' },
  AdminSafehouse: { type: 'boolean', group: 'safehouses' },
  SafehouseAllowTrepass: { type: 'boolean', group: 'safehouses' },
  SafehouseAllowFire: { type: 'boolean', group: 'safehouses' },
  SafehouseAllowLoot: { type: 'boolean', group: 'safehouses' },
  SafehouseAllowRespawn: { type: 'boolean', group: 'safehouses' },
  SafehouseDaySurvivedToClaim: { type: 'number', group: 'safehouses', min: 0, max: 365 },
  SafeHouseRemovalTime: { type: 'number', group: 'safehouses', min: 0, max: 8760 },
  SafehouseAllowNonResidential: { type: 'boolean', group: 'safehouses' },
  SafehouseDisableDisguises: { type: 'boolean', group: 'safehouses' },
  MaxSafezoneSize: { type: 'number', group: 'safehouses', min: 0, max: 100000 },
  DisableSafehouseWhenOwnerConnected: { type: 'boolean', group: 'safehouses' },
  SafehousePreventsLootRespawn: { type: 'boolean', group: 'safehouses' },
  Faction: { type: 'boolean', group: 'safehouses' },
  FactionDaySurvivedToCreate: { type: 'number', group: 'safehouses', min: 0, max: 365 },
  FactionPlayersRequiredForTag: { type: 'number', group: 'safehouses', min: 1, max: 64 },
  War: { type: 'boolean', group: 'safehouses' },
  WarStartDelay: { type: 'number', group: 'safehouses', min: 0, max: 86400 },
  WarDuration: { type: 'number', group: 'safehouses', min: 0, max: 86400 },
  WarSafehouseHitPoints: { type: 'number', group: 'safehouses', min: 1, max: 100 },

  // Network
  DefaultPort: { type: 'number', group: 'network', min: 1024, max: 65535 },
  UDPPort: { type: 'number', group: 'network', min: 1024, max: 65535 },
  RCONPort: { type: 'number', group: 'network', min: 1024, max: 65535, readOnly: true },
  RCONPassword: { type: 'password', group: 'network', sensitive: true, readOnly: true },
  PingLimit: { type: 'number', group: 'network', min: 0, max: 2000 },
  UPnP: { type: 'boolean', group: 'network' },
  VoiceEnable: { type: 'boolean', group: 'network' },
  VoiceMinDistance: { type: 'number', group: 'network', min: 0, max: 200, step: 0.1 },
  VoiceMaxDistance: { type: 'number', group: 'network', min: 0, max: 500, step: 0.1 },
  Voice3D: { type: 'boolean', group: 'network' },
  SpeedLimit: { type: 'number', group: 'network', min: 0, max: 200, step: 0.1 },
  LoginQueueEnabled: { type: 'boolean', group: 'network' },
  LoginQueueConnectTimeout: { type: 'number', group: 'network', min: 10, max: 600 },
  ServerPlayerID: { type: 'string', group: 'network', readOnly: true },
  SteamVAC: { type: 'boolean', group: 'network' },
  DenyLoginOnOverloadedServer: { type: 'boolean', group: 'network' },
  MaxPacketsPerSecond: { type: 'number', group: 'network', min: 0, max: 5000 },

  // Chat / Discord / radio
  GlobalChat: { type: 'boolean', group: 'chat' },
  ChatStreams: { type: 'string', group: 'chat' },
  ChatMessageCharacterLimit: { type: 'number', group: 'chat', min: 0, max: 2000 },
  ChatMessageSlowModeTime: { type: 'number', group: 'chat', min: 0, max: 300 },
  DiscordEnable: { type: 'boolean', group: 'chat' },
  DiscordToken: { type: 'password', group: 'chat', sensitive: true },
  DiscordChatChannel: { type: 'string', group: 'chat' },
  DiscordLogChannel: { type: 'string', group: 'chat' },
  DiscordCommandChannel: { type: 'string', group: 'chat' },
  WebhookAddress: { type: 'string', group: 'chat' },
  DisableRadioStaff: { type: 'boolean', group: 'chat' },
  DisableRadioAdmin: { type: 'boolean', group: 'chat' },
  DisableRadioGM: { type: 'boolean', group: 'chat' },
  DisableRadioOverseer: { type: 'boolean', group: 'chat' },
  DisableRadioModerator: { type: 'boolean', group: 'chat' },
  DisableRadioInvisible: { type: 'boolean', group: 'chat' },
  BanKickGlobalSound: { type: 'boolean', group: 'chat' },

  // Saves
  SaveWorldEveryMinutes: { type: 'number', group: 'saves', min: 0, max: 240 },
  ResetID: { type: 'number', group: 'saves', min: 0 },
  BackupsCount: { type: 'number', group: 'saves', min: 0, max: 50 },
  BackupsOnStart: { type: 'boolean', group: 'saves' },
  BackupsOnVersionChange: { type: 'boolean', group: 'saves' },
  BackupsPeriod: { type: 'number', group: 'saves', min: 0, max: 10080 },

  // Security
  DoLuaChecksum: { type: 'boolean', group: 'security' },
  AntiCheatSafety: { type: 'number', group: 'security', min: 0, max: 4 },
  AntiCheatSpeed: { type: 'number', group: 'security', min: 0, max: 4 },
  AntiCheatNoClip: { type: 'number', group: 'security', min: 0, max: 4 },
  AntiCheatHit: { type: 'number', group: 'security', min: 0, max: 4 },
  AntiCheatPacketException: { type: 'number', group: 'security', min: 0, max: 4 },
  AntiCheatPermission: { type: 'number', group: 'security', min: 0, max: 4 },
  AntiCheatXP: { type: 'number', group: 'security', min: 0, max: 4 },
  AntiCheatSafeHouse: { type: 'number', group: 'security', min: 0, max: 4 },
  AntiCheatPlayer: { type: 'number', group: 'security', min: 0, max: 4 },
  AntiCheatChecksum: { type: 'number', group: 'security', min: 0, max: 4 },
  ClientCommandFilter: { type: 'string', group: 'security' },
  ClientActionLogs: { type: 'string', group: 'security' },
  PerkLogs: { type: 'boolean', group: 'security' },
  MultiplayerStatisticsPeriod: { type: 'number', group: 'security', min: 0, max: 60 },
  BadWordListFile: { type: 'string', group: 'security' },
  GoodWordListFile: { type: 'string', group: 'security' },
  BadWordPolicy: { type: 'number', group: 'security', min: 0, max: 4 },
  BadWordReplacement: { type: 'string', group: 'security' },

  // Mods
  Mods: { type: 'list', group: 'mods', readOnly: true },
  WorkshopItems: { type: 'list', group: 'mods', readOnly: true },
}

export function settingMeta(key: string): SettingMeta | undefined {
  return SERVER_INI_META[key]
}

export function settingGroup(key: string): string {
  return SERVER_INI_META[key]?.group ?? 'other'
}

export function groupLabelKey(group: string): TranslationKey {
  return `admin.config_group_${group}` as TranslationKey
}

export function groupsFor(source: ConfigSource): readonly string[] {
  return source === 'sandbox' ? SANDBOX_GROUPS : CONFIG_GROUPS
}

export function featuredKeysFor(source: ConfigSource): readonly string[] {
  return source === 'sandbox' ? SANDBOX_FEATURED_KEYS : FEATURED_KEYS
}

export function settingLabelKey(key: string): TranslationKey {
  return `admin.config_set_${key}` as TranslationKey
}

export function settingHelpKey(key: string): TranslationKey {
  return `admin.config_help_${key}` as TranslationKey
}

export function hasSettingLabel(key: string): boolean {
  return settingLabelKey(key) in fallback
}

export function hasSettingHelp(key: string): boolean {
  return settingHelpKey(key) in fallback
}

function expandCamel(key: string): string {
  return key
    .replaceAll('_', ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
}

/** Split a raw INI key so an unknown setting is still readable. */
export function humanizeKey(key: string): string {
  const leaf = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : key
  return expandCamel(leaf)
}

/** Parent table of a dotted sandbox key (`CHStatusHUD.RestrictStats` → `CH Status HUD`). */
export function humanizeTable(table: string): string {
  return expandCamel(table)
}

/** Keep file order: one section per nested table. */
export function groupByParentTable<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): { table: string; items: T[] }[] {
  const order: string[] = []
  const buckets = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const index = key.indexOf('.')
    const table = index > 0 ? key.slice(0, index) : 'other'
    let list = buckets.get(table)
    if (!list) {
      list = []
      buckets.set(table, list)
      order.push(table)
    }
    list.push(item)
  }
  return order.map((table) => ({ table, items: buckets.get(table) ?? [] }))
}

export function isSensitive(key: string, meta: SettingMeta | undefined, secret: boolean): boolean {
  return Boolean(secret || meta?.sensitive || /password|token/i.test(key))
}

export function parseBoolean(value: string): boolean {
  return value.trim().toLowerCase() === 'true'
}

/** Decimal places in a number or numeric string. `0.01` is 2; `1.0` is 1. */
function decimalPlaces(value: string | number | undefined): number {
  if (value === undefined || value === '') {
    return 0
  }
  const text = String(value)
  const index = text.indexOf('.')
  if (index === -1) {
    return 0
  }
  return text.length - index - 1
}

/**
 * HTML number inputs only accept `min + n * step`. A hardcoded 0.1 with
 * min 0.01 rejects the game's own 1.0 (Chrome offers 0.91 and 1.01).
 * Use the finest precision among the current value and the bounds.
 */
export function numberInputStep(
  value: string,
  min?: number,
  max?: number,
): number | 'any' {
  const places = Math.max(decimalPlaces(value), decimalPlaces(min), decimalPlaces(max))
  const step = places <= 0 ? 1 : Number(`1e-${places}`)
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return 'any'
  }
  const base = min ?? 0
  const ratio = (numeric - base) / step
  if (Math.abs(ratio - Math.round(ratio)) > 1e-6) {
    return 'any'
  }
  return step
}

export function splitList(value: string): string[] {
  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
}
