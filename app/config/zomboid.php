<?php

return [
    /*
    |--------------------------------------------------------------------------
    | RCON Configuration
    |--------------------------------------------------------------------------
    */
    'rcon' => [
        'host' => env('PZ_RCON_HOST', 'game-server'),
        'port' => (int) env('PZ_RCON_PORT', 27015),
        'password' => env('PZ_RCON_PASSWORD', ''),
        'timeout' => (int) env('PZ_RCON_TIMEOUT', 5),
    ],

    /*
    |--------------------------------------------------------------------------
    | Docker Engine API
    |--------------------------------------------------------------------------
    */
    'docker' => [
        'proxy_url' => env('DOCKER_PROXY_URL', 'http://docker-socket-proxy:2375'),
        'container_name' => env('GAME_SERVER_CONTAINER_NAME', 'pz-game-server'),
    ],

    /*
    |--------------------------------------------------------------------------
    | PZ Server Paths (inside app container)
    |--------------------------------------------------------------------------
    */
    'paths' => [
        'data' => env('PZ_DATA_PATH', '/pz-data'),
        'server_ini' => env('PZ_DATA_PATH', '/pz-data').'/Server/'.env('PZ_SERVER_NAME', 'ZomboidServer').'.ini',
        'sandbox_lua' => env('PZ_DATA_PATH', '/pz-data').'/Server/'.env('PZ_SERVER_NAME', 'ZomboidServer').'_SandboxVars.lua',
        'db' => env('PZ_DATA_PATH', '/pz-data').'/db/serverPZ.db',
        'players_db' => env('PZ_DATA_PATH', '/pz-data').'/Saves/Multiplayer/'.env('PZ_SERVER_NAME', 'ZomboidServer').'/players.db',
    ],

    /*
    |--------------------------------------------------------------------------
    | Steam Branch
    |--------------------------------------------------------------------------
    */
    'steam_branch' => env('PZ_STEAM_BRANCH', 'unstable'),

    /*
    |--------------------------------------------------------------------------
    | Protected Mods
    |--------------------------------------------------------------------------
    |
    | Mods the manager refuses to remove and re-attaches automatically if they
    | go missing, keyed by Workshop ID with the mod_id as the value. Defaults to
    | the published Knox Relay bridge mod, which the panel depends on for
    | inventory, deliveries, the player map and deposits. Set
    | PZ_BRIDGE_WORKSHOP_ID to an empty string to protect nothing.
    |
    */
    'protected_mods' => array_filter([
        (string) env('PZ_BRIDGE_WORKSHOP_ID', '3777446787') => (string) env('PZ_BRIDGE_MOD_ID', 'KnoxRelay'),
    ], static fn ($workshopId): bool => (string) $workshopId !== '', ARRAY_FILTER_USE_KEY),

    /*
    |--------------------------------------------------------------------------
    | Map Tile Configuration
    |--------------------------------------------------------------------------
    */
    'game_server_path' => env('PZ_SERVER_PATH', '/pz-server'),

    'map' => [
        // Local tiles live as a single SQLite pack (tiles.sqlite) under this path.
        // pzmap2dzi still renders a temporary multi-file pyramid; generation packs it and deletes the loose files.
        'tiles_path' => env('PZ_MAP_TILES_PATH', '/map-tiles'),
        'tile_size' => 256,
        'min_zoom' => 13,
        'max_zoom' => 17,
        'default_zoom' => 13,
        'center_x' => 10500.0,
        'center_y' => 9800.0,
        'proxy_url' => env('PZ_MAP_PROXY_URL', 'https://map.projectzomboid.com/maps/SurvivalB417812L0/map_files/{z}/{x}_{y}.jpg'),
        'proxy_tile_size' => 1024,
        'proxy_dzi' => [
            'width' => 2285184,
            'height' => 990400,
            'x0' => 1017856,
            'y0' => -152032,
            'sqr' => 128,
        ],
        // Generation is I/O heavy — keep workers low so the game disk is not saturated.
        // Override with PZ_MAP_WORKERS=1 for quietest hosts.
        'generate_workers' => max(1, (int) env('PZ_MAP_WORKERS', 1)),
        // nice + ionice when available. Prefer best-effort low prio over "idle" class:
        // ionice -c 3 (idle) can starve for hours while the game server is writing.
        'generate_low_priority' => filter_var(env('PZ_MAP_LOW_PRIORITY', true), FILTER_VALIDATE_BOOL),
        // 2 = best-effort (with nice level), 3 = idle (only when disk is free)
        'generate_ionice_class' => max(1, min(3, (int) env('PZ_MAP_IONICE_CLASS', 2))),
        'generate_ionice_level' => max(0, min(7, (int) env('PZ_MAP_IONICE_LEVEL', 7))),
        'generate_nice' => max(-20, min(19, (int) env('PZ_MAP_NICE', 15))),
        // Micro-pauses while packing millions of files into SQLite
        'pack_pause_every' => max(50, (int) env('PZ_MAP_PACK_PAUSE_EVERY', 100)),
        'pack_pause_us' => max(0, (int) env('PZ_MAP_PACK_PAUSE_US', 10000)),
    ],

    /*
    |--------------------------------------------------------------------------
    | Server Identity
    |--------------------------------------------------------------------------
    */
    'server_name' => env('PZ_SERVER_NAME', 'ZomboidServer'),

    /*
    |--------------------------------------------------------------------------
    | Backup Configuration
    |--------------------------------------------------------------------------
    */
    'backups' => [
        'path' => env('BACKUP_PATH', '/backups'),
        'retention' => [
            'manual' => (int) env('BACKUP_RETENTION_MANUAL', 10),
            'scheduled' => (int) env('BACKUP_RETENTION_SCHEDULED', 24),
            'daily' => (int) env('BACKUP_RETENTION_DAILY', 7),
            'pre_rollback' => (int) env('BACKUP_RETENTION_PRE_ROLLBACK', 5),
            'pre_update' => (int) env('BACKUP_RETENTION_PRE_UPDATE', 3),
            'pre_import' => (int) env('BACKUP_RETENTION_PRE_IMPORT', 3),
        ],
    ],

    /*
    |--------------------------------------------------------------------------
    | Lua Bridge — File-based communication with PZ Lua mod
    |--------------------------------------------------------------------------
    */
    'lua_bridge' => [
        'path' => env('LUA_BRIDGE_PATH', '/lua-bridge'),
        'inventory_dir' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/inventory',
        'delivery_queue' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/delivery_queue.json',
        'delivery_results' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/delivery_results.json',
        'players_live' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/players_live.json',
        'items_catalog' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/items_catalog.json',
        'game_state' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/game_state.json',
        'player_stats' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/player_stats.json',
        'respawn_config' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/respawn_config.json',
        'respawn_deaths' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/respawn_deaths.json',
        'respawn_resets' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/respawn_resets.json',
        'respawn_kicks' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/respawn_kicks.json',
        'safezone_config' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/safezone_config.json',
        'safezone_violations' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/safezone_violations.json',
        'pvp_kills' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/pvp_kills.json',
        'deaths' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/deaths.json',
        'deposit_requests' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/deposit_requests.json',
        'deposit_results' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/deposit_results.json',
        'export_requests' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/export_requests.json',
        'holdings' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/holdings.json',
        'world_actions' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/world_actions.json',
        'world_results' => env('LUA_BRIDGE_PATH', '/lua-bridge').'/world_results.json',
    ],

    /*
    |--------------------------------------------------------------------------
    | Money Deposit — In-game money to wallet conversion
    |--------------------------------------------------------------------------
    */
    'money_deposit' => [
        'money_value' => (int) env('PZ_MONEY_VALUE', 1),
        // MoneyBundle is crafted from 100x Money in vanilla; override via env or Admin → Lua Bridge
        'bundle_value' => (int) env('PZ_MONEY_BUNDLE_VALUE', env('PZ_MONEY_STACK_VALUE', 100)),
        'stack_value' => (int) env('PZ_MONEY_STACK_VALUE', 100), // legacy alias
    ],

    /*
    |--------------------------------------------------------------------------
    | Player rewards
    |--------------------------------------------------------------------------
    */
    'rewards' => [
        'daily_coins' => (int) env('PZ_DAILY_REWARD_COINS', 25),
    ],

    /*
    |--------------------------------------------------------------------------
    | API Authentication
    |--------------------------------------------------------------------------
    */
    'api_key' => env('API_KEY', ''),

    /*
    |--------------------------------------------------------------------------
    | Initial Admin Account
    |--------------------------------------------------------------------------
    */
    'admin' => [
        'username' => env('ADMIN_USERNAME', ''),
        'email' => env('ADMIN_EMAIL', ''),
        'password' => env('ADMIN_PASSWORD', ''),
    ],
];
