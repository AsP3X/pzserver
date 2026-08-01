export type SettingMeta = {
    type: 'boolean' | 'number' | 'string' | 'enum' | 'list';
    group: string;
    description: string;
    default?: string | number | boolean;
    sensitive?: boolean;
    readOnly?: boolean;
    options?: { value: string; label: string }[];
    min?: number;
    max?: number;
};

// ── Server.ini settings ─────────────────────────────────────────────

export const SERVER_INI_META: Record<string, SettingMeta> = {
    // General
    ServerName: {
        type: 'string',
        group: 'General',
        description: 'The name of the server as it appears in the server browser.',
        default: 'servertest',
    },
    Public: {
        type: 'boolean',
        group: 'General',
        description: 'Whether the server is visible in the public server browser.',
        default: true,
    },
    Open: {
        type: 'boolean',
        group: 'General',
        description: 'Allow new players to join. Set to false to only allow whitelisted players.',
        default: true,
    },
    AutoCreateUserInWhiteList: {
        type: 'boolean',
        group: 'General',
        description: 'Automatically store player credentials when they join. Required for web login sync.',
        default: true,
    },
    PauseEmpty: {
        type: 'boolean',
        group: 'General',
        description: 'Pause the server when no players are connected.',
        default: true,
    },
    Password: {
        type: 'string',
        group: 'General',
        description: 'Password required to join the server. Leave empty for no password.',
        sensitive: true,
    },
    AdminPassword: {
        type: 'string',
        group: 'General',
        description: 'Password for in-game admin access.',
        sensitive: true,
    },

    // Network
    DefaultPort: {
        type: 'number',
        group: 'Network',
        description: 'Primary game server port (TCP/UDP).',
        default: 16261,
        min: 1024,
        max: 65535,
    },
    UDPPort: {
        type: 'number',
        group: 'Network',
        description: 'Secondary UDP port for game traffic.',
        default: 16262,
        min: 1024,
        max: 65535,
    },
    RCONPort: {
        type: 'number',
        group: 'Network',
        description: 'RCON (remote console) port for server management.',
        default: 27015,
        min: 1024,
        max: 65535,
    },
    RCONPassword: {
        type: 'string',
        group: 'Network',
        description: 'Password for RCON connections.',
        sensitive: true,
    },

    // Players
    MaxPlayers: {
        type: 'number',
        group: 'Players',
        description: 'Maximum number of players allowed on the server.',
        default: 16,
        min: 1,
        max: 100,
    },

    // Saves
    AutoSave: {
        type: 'boolean',
        group: 'Saves',
        description: 'Automatically save the world at regular intervals.',
        default: true,
    },
    SaveWorldEveryMinutes: {
        type: 'number',
        group: 'Saves',
        description: 'How often the world auto-saves, in minutes.',
        default: 15,
        min: 1,
        max: 120,
    },
    ResetID: {
        type: 'number',
        group: 'Saves',
        description: 'Reset counter — incrementing this forces a world wipe on next restart.',
        default: 0,
        min: 0,
    },

    // Security
    SteamVAC: {
        type: 'boolean',
        group: 'Security',
        description: 'Enable Valve Anti-Cheat (VAC) for the server.',
        default: true,
    },

    // Mods (read-only — managed on mods page)
    Mods: {
        type: 'list',
        group: 'Mods',
        description: 'Active mod IDs. Managed on the Mods page.',
        readOnly: true,
    },
    WorkshopItems: {
        type: 'list',
        group: 'Mods',
        description: 'Steam Workshop item IDs for active mods. Managed on the Mods page.',
        readOnly: true,
    },

    // Map
    Map: {
        type: 'string',
        group: 'Map',
        description: 'Map name. PZ uses semicolons to separate multiple map entries.',
        default: 'Muldraugh, KY',
    },
};

export const SERVER_INI_GROUP_ORDER = [
    'General',
    'Network',
    'Players',
    'Saves',
    'Security',
    'Mods',
    'Map',
];

// ── SandboxVars.lua settings ────────────────────────────────────────

export const SANDBOX_META: Record<string, SettingMeta> = {
    // Zombie Lore
    'ZombieLore.Speed': {
        type: 'enum',
        group: 'Zombie Lore',
        description: 'Zombie movement speed.',
        default: 2,
        options: [
            { value: '1', label: 'Sprinters' },
            { value: '2', label: 'Fast Shamblers' },
            { value: '3', label: 'Shamblers' },
            { value: '4', label: 'Random' },
        ],
    },
    'ZombieLore.Strength': {
        type: 'enum',
        group: 'Zombie Lore',
        description: 'How strong zombies are in combat.',
        default: 2,
        options: [
            { value: '1', label: 'Superhuman' },
            { value: '2', label: 'Normal' },
            { value: '3', label: 'Weak' },
        ],
    },
    'ZombieLore.Toughness': {
        type: 'enum',
        group: 'Zombie Lore',
        description: 'How tough zombies are (damage to kill).',
        default: 2,
        options: [
            { value: '1', label: 'Tough' },
            { value: '2', label: 'Normal' },
            { value: '3', label: 'Fragile' },
        ],
    },
    'ZombieLore.Transmission': {
        type: 'enum',
        group: 'Zombie Lore',
        description: 'How the zombie infection spreads.',
        default: 1,
        options: [
            { value: '1', label: 'Blood + Saliva' },
            { value: '2', label: 'Saliva Only' },
            { value: '3', label: 'Everyone\'s Infected' },
            { value: '4', label: 'None' },
        ],
    },
    'ZombieLore.Mortality': {
        type: 'enum',
        group: 'Zombie Lore',
        description: 'Time from infection to death.',
        default: 5,
        options: [
            { value: '1', label: '0-30 seconds' },
            { value: '2', label: '0-1 minutes' },
            { value: '3', label: '0-12 hours' },
            { value: '4', label: '2-3 days' },
            { value: '5', label: '1-2 weeks' },
            { value: '6', label: 'Never' },
        ],
    },
    'ZombieLore.Reanimate': {
        type: 'enum',
        group: 'Zombie Lore',
        description: 'Time for dead bodies to reanimate.',
        default: 3,
        options: [
            { value: '1', label: '0-30 seconds' },
            { value: '2', label: '0-1 minutes' },
            { value: '3', label: '0-12 hours' },
            { value: '4', label: '2-3 days' },
            { value: '5', label: '1-2 weeks' },
        ],
    },
    'ZombieLore.Cognition': {
        type: 'enum',
        group: 'Zombie Lore',
        description: 'Zombie navigation intelligence.',
        default: 2,
        options: [
            { value: '1', label: 'Navigate + Use Doors' },
            { value: '2', label: 'Navigate' },
            { value: '3', label: 'Basic Navigation' },
        ],
    },
    'ZombieLore.Memory': {
        type: 'enum',
        group: 'Zombie Lore',
        description: 'How long zombies remember seeing a player.',
        default: 2,
        options: [
            { value: '1', label: 'Long' },
            { value: '2', label: 'Normal' },
            { value: '3', label: 'Short' },
            { value: '4', label: 'None' },
        ],
    },
    'ZombieLore.Decomp': {
        type: 'enum',
        group: 'Zombie Lore',
        description: 'Zombie decomposition over time — weakens them gradually.',
        default: 1,
        options: [
            { value: '1', label: 'Slows + Weakens' },
            { value: '2', label: 'Slows' },
            { value: '3', label: 'Weakens' },
            { value: '4', label: 'None' },
        ],
    },
    'ZombieLore.Sight': {
        type: 'enum',
        group: 'Zombie Lore',
        description: 'How far zombies can see players.',
        default: 2,
        options: [
            { value: '1', label: 'Eagle' },
            { value: '2', label: 'Normal' },
            { value: '3', label: 'Poor' },
        ],
    },
    'ZombieLore.Hearing': {
        type: 'enum',
        group: 'Zombie Lore',
        description: 'How well zombies hear sounds.',
        default: 2,
        options: [
            { value: '1', label: 'Pinpoint' },
            { value: '2', label: 'Normal' },
            { value: '3', label: 'Poor' },
        ],
    },
    'ZombieLore.Smell': {
        type: 'enum',
        group: 'Zombie Lore',
        description: 'How well zombies smell blood.',
        default: 2,
        options: [
            { value: '1', label: 'Bloodhound' },
            { value: '2', label: 'Normal' },
            { value: '3', label: 'Poor' },
        ],
    },

    // Zombie Population
    'ZombieConfig.PopulationMultiplier': {
        type: 'number',
        group: 'Zombie Population',
        description: 'Overall zombie population multiplier.',
        default: 1.0,
        min: 0,
        max: 4,
    },
    'ZombieConfig.PopulationStartMultiplier': {
        type: 'number',
        group: 'Zombie Population',
        description: 'Zombie population at day 1 (multiplier).',
        default: 1.0,
        min: 0,
        max: 4,
    },
    'ZombieConfig.PopulationPeakMultiplier': {
        type: 'number',
        group: 'Zombie Population',
        description: 'Zombie population at peak day (multiplier).',
        default: 1.5,
        min: 0,
        max: 4,
    },
    'ZombieConfig.PopulationPeakDay': {
        type: 'number',
        group: 'Zombie Population',
        description: 'Day when zombie population reaches peak.',
        default: 28,
        min: 1,
        max: 365,
    },
    'ZombieConfig.RespawnHours': {
        type: 'number',
        group: 'Zombie Population',
        description: 'Hours before zombies can respawn in cleared areas.',
        default: 72,
        min: 0,
        max: 8760,
    },
    'ZombieConfig.RespawnUnseenHours': {
        type: 'number',
        group: 'Zombie Population',
        description: 'Hours a cell must be unseen before zombies respawn.',
        default: 16,
        min: 0,
        max: 8760,
    },
    'ZombieConfig.RespawnMultiplier': {
        type: 'number',
        group: 'Zombie Population',
        description: 'Fraction of original zombies that respawn.',
        default: 0.1,
        min: 0,
        max: 1,
    },
    'ZombieConfig.RedistributeHours': {
        type: 'number',
        group: 'Zombie Population',
        description: 'Hours between zombie redistribution across the map.',
        default: 12,
        min: 0,
        max: 8760,
    },

    // Time & Start
    DayLength: {
        type: 'enum',
        group: 'Time & Start',
        description: 'Length of an in-game day in real-time.',
        default: 2,
        options: [
            { value: '1', label: '15 minutes' },
            { value: '2', label: '30 minutes' },
            { value: '3', label: '1 hour' },
            { value: '4', label: '2 hours' },
            { value: '5', label: '3 hours' },
            { value: '6', label: '4 hours' },
            { value: '7', label: '5 hours' },
            { value: '8', label: '6 hours' },
            { value: '9', label: '7 hours' },
            { value: '10', label: '8 hours' },
            { value: '11', label: '9 hours' },
            { value: '12', label: '10 hours' },
            { value: '13', label: '11 hours' },
            { value: '14', label: '12 hours' },
        ],
    },
    StartYear: {
        type: 'number',
        group: 'Time & Start',
        description: 'Starting year of the game world.',
        default: 1993,
        min: 1,
    },
    StartMonth: {
        type: 'number',
        group: 'Time & Start',
        description: 'Starting month (1 = January, 12 = December).',
        default: 7,
        min: 1,
        max: 12,
    },
    StartDay: {
        type: 'number',
        group: 'Time & Start',
        description: 'Starting day of the month.',
        default: 9,
        min: 1,
        max: 31,
    },

    // World
    Temperature: {
        type: 'enum',
        group: 'World',
        description: 'World temperature modifier.',
        default: 3,
        options: [
            { value: '1', label: 'Very Cold' },
            { value: '2', label: 'Cold' },
            { value: '3', label: 'Normal' },
            { value: '4', label: 'Hot' },
            { value: '5', label: 'Very Hot' },
        ],
    },
    Rain: {
        type: 'enum',
        group: 'World',
        description: 'Amount of rain.',
        default: 3,
        options: [
            { value: '1', label: 'Very Dry' },
            { value: '2', label: 'Dry' },
            { value: '3', label: 'Normal' },
            { value: '4', label: 'Rainy' },
            { value: '5', label: 'Very Rainy' },
        ],
    },
    ErosionSpeed: {
        type: 'enum',
        group: 'World',
        description: 'Speed of nature reclaiming the world.',
        default: 3,
        options: [
            { value: '1', label: 'Very Fast (20 days)' },
            { value: '2', label: 'Fast (50 days)' },
            { value: '3', label: 'Normal (100 days)' },
            { value: '4', label: 'Slow (200 days)' },
            { value: '5', label: 'Very Slow (500 days)' },
        ],
    },
    WaterShut: {
        type: 'number',
        group: 'World',
        description: 'Day when water shuts off (0 = instant, -1 = never).',
        default: 14,
        min: -1,
        max: 365,
    },
    ElecShut: {
        type: 'number',
        group: 'World',
        description: 'Day when electricity shuts off (0 = instant, -1 = never).',
        default: 14,
        min: -1,
        max: 365,
    },

    // Loot & Resources
    LootRespawn: {
        type: 'enum',
        group: 'Loot & Resources',
        description: 'Frequency of loot respawning.',
        default: 1,
        options: [
            { value: '1', label: 'None' },
            { value: '2', label: 'Every Day' },
            { value: '3', label: 'Every Week' },
            { value: '4', label: 'Every Month' },
            { value: '5', label: 'Every 2 Months' },
        ],
    },
    NatureAbundance: {
        type: 'enum',
        group: 'Loot & Resources',
        description: 'Abundance of foraging, fishing, and trapping.',
        default: 3,
        options: [
            { value: '1', label: 'Very Poor' },
            { value: '2', label: 'Poor' },
            { value: '3', label: 'Normal' },
            { value: '4', label: 'Abundant' },
            { value: '5', label: 'Very Abundant' },
        ],
    },
    Farming: {
        type: 'enum',
        group: 'Loot & Resources',
        description: 'Speed of farming growth.',
        default: 2,
        options: [
            { value: '1', label: 'Very Fast' },
            { value: '2', label: 'Fast' },
            { value: '3', label: 'Normal' },
            { value: '4', label: 'Slow' },
            { value: '5', label: 'Very Slow' },
        ],
    },
    Alarm: {
        type: 'enum',
        group: 'Loot & Resources',
        description: 'Frequency of house alarms triggering.',
        default: 6,
        options: [
            { value: '1', label: 'Never' },
            { value: '2', label: 'Extremely Rare' },
            { value: '3', label: 'Rare' },
            { value: '4', label: 'Sometimes' },
            { value: '5', label: 'Often' },
            { value: '6', label: 'Very Often' },
        ],
    },
    LockedHouses: {
        type: 'enum',
        group: 'Loot & Resources',
        description: 'Frequency of houses being locked.',
        default: 6,
        options: [
            { value: '1', label: 'Never' },
            { value: '2', label: 'Extremely Rare' },
            { value: '3', label: 'Rare' },
            { value: '4', label: 'Sometimes' },
            { value: '5', label: 'Often' },
            { value: '6', label: 'Very Often' },
        ],
    },

    // Gameplay
    Zombies: {
        type: 'enum',
        group: 'Gameplay',
        description: 'Overall zombie count preset.',
        default: 4,
        options: [
            { value: '0', label: 'None' },
            { value: '1', label: 'Insane' },
            { value: '2', label: 'Very High' },
            { value: '3', label: 'High' },
            { value: '4', label: 'Normal' },
            { value: '5', label: 'Low' },
        ],
    },
    Distribution: {
        type: 'enum',
        group: 'Gameplay',
        description: 'How zombies are distributed across the map.',
        default: 1,
        options: [
            { value: '1', label: 'Urban Focused' },
            { value: '2', label: 'Uniform' },
        ],
    },
    XpMultiplier: {
        type: 'number',
        group: 'Gameplay',
        description: 'Experience point gain multiplier.',
        default: 1.0,
        min: 0.01,
        max: 1000,
    },
};

export const SANDBOX_GROUP_ORDER = [
    'Zombie Lore',
    'Zombie Population',
    'Time & Start',
    'World',
    'Loot & Resources',
    'Gameplay',
];

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Group settings by their metadata group.
 * Unknown keys (not in metadata) are placed in an "Other" group.
 */
export function groupSettings(
    settings: Record<string, string>,
    meta: Record<string, SettingMeta>,
    groupOrder: string[],
): { group: string; entries: { key: string; value: string; meta?: SettingMeta }[] }[] {
    const groups = new Map<string, { key: string; value: string; meta?: SettingMeta }[]>();

    // Initialize ordered groups
    for (const g of groupOrder) {
        groups.set(g, []);
    }

    for (const [key, value] of Object.entries(settings)) {
        const m = meta[key];
        const group = m?.group ?? 'Other';
        if (!groups.has(group)) {
            groups.set(group, []);
        }
        groups.get(group)!.push({ key, value, meta: m });
    }

    // Return in order, filtering empty groups
    const result: { group: string; entries: { key: string; value: string; meta?: SettingMeta }[] }[] = [];
    for (const g of groupOrder) {
        const entries = groups.get(g);
        if (entries && entries.length > 0) {
            result.push({ group: g, entries });
        }
    }

    // Append "Other" at the end if it has entries
    const other = groups.get('Other');
    if (other && other.length > 0) {
        result.push({ group: 'Other', entries: other });
    }

    return result;
}
