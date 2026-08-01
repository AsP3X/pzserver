--
-- ZM_RespawnDelay.lua — Configurable respawn cooldown enforced server-side.
-- Uses file-based IPC: reads config from Laravel, writes death records, processes resets.
--
-- Detection uses EveryOneMinute tick (OnPlayerDeath/OnCreatePlayer are client-side
-- events that do not fire on a PZ dedicated server).
--

require("ZM_Utils")

ZM_RespawnDelay = {}

local CONFIG_FILE = "respawn_config.json"
local DEATHS_FILE = "respawn_deaths.json"
local RESETS_FILE = "respawn_resets.json"
local KICKS_FILE = "respawn_kicks.json"

-- Config reload interval (reload every N ticks instead of every tick)
local configReloadCounter = 0
local CONFIG_RELOAD_INTERVAL = 10

-- In-memory state
local config = { enabled = false, delay_minutes = 60 }
local deathRecords = {} -- { username = epoch_timestamp }
local deadPlayers = {} -- { username = true } — tracks who we've already recorded as dead
local deathRecordsDirty = false -- dirty flag for batched writes

--- Mark death records as needing a write
local function markDeathRecordsDirty()
    deathRecordsDirty = true
end

--- Persist death records to disk (only if dirty)
local function flushDeathRecords()
    if not deathRecordsDirty then
        return
    end
    ZM_Utils.writeJsonFile(DEATHS_FILE, { deaths = deathRecords })
    deathRecordsDirty = false
end

--- Load config from respawn_config.json
local function loadConfig()
    local data = ZM_Utils.readJsonFile(CONFIG_FILE)
    if data then
        if data.enabled ~= nil then
            config.enabled = data.enabled
        end
        if data.delay_minutes ~= nil then
            config.delay_minutes = tonumber(data.delay_minutes) or 60
        end
    end
end

--- Process reset requests from Laravel
local function processResets()
    local data = ZM_Utils.readJsonFile(RESETS_FILE)
    if not data or not data.resets then
        return
    end

    local count = 0
    for _, username in ipairs(data.resets) do
        if deathRecords[username] then
            deathRecords[username] = nil
            deadPlayers[username] = nil
            count = count + 1
        end
    end

    if count > 0 then
        markDeathRecordsDirty()
        print("[ZomboidManager] RespawnDelay: reset " .. count .. " player timer(s)")
    end

    -- Clear the resets file after processing
    ZM_Utils.writeJsonFile(RESETS_FILE, { resets = {} })
end

--- Clean up expired death records
local function cleanExpired()
    local now = os.time()
    local delaySeconds = config.delay_minutes * 60

    for username, deathTime in pairs(deathRecords) do
        if (now - deathTime) >= delaySeconds then
            deathRecords[username] = nil
            deadPlayers[username] = nil
            markDeathRecordsDirty()
        end
    end
end

--- Write kick requests for Laravel to process via RCON.
--- Laravel reads this file and executes "kickuser" RCON commands.
local function requestKick(username, remainingMinutes)
    -- Read existing kick queue (may have entries from other players)
    local data = ZM_Utils.readJsonFile(KICKS_FILE)
    local kicks = {}
    if data and data.kicks then
        kicks = data.kicks
    end

    -- Avoid duplicate entries
    for _, entry in ipairs(kicks) do
        if entry.username == username then
            return
        end
    end

    table.insert(kicks, {
        username = username,
        reason = "Respawn cooldown: " .. remainingMinutes .. " minute(s) remaining. Please wait.",
        timestamp = os.time(),
    })

    ZM_Utils.writeJsonFile(KICKS_FILE, { kicks = kicks })
    print("[ZomboidManager] RespawnDelay: queued kick for " .. username .. " (" .. remainingMinutes .. " min remaining)")
end

--- Scan all online players for deaths and respawns.
--- Called every game minute from the tick() function.
local function scanPlayers()
    local players = getOnlinePlayers()
    if not players then
        return
    end

    local now = os.time()
    local delaySeconds = config.delay_minutes * 60

    for i = 0, players:size() - 1 do
        local player = players:get(i)
        if player then
            local ok, err = pcall(function()
                local username = player:getUsername()
                if not username then
                    return
                end

                if player:isDead() then
                    -- Player is dead — record death if not already tracked
                    if not deadPlayers[username] then
                        deadPlayers[username] = true
                        deathRecords[username] = now
                        markDeathRecordsDirty()
                        print("[ZomboidManager] RespawnDelay: recorded death for " .. username)
                    end
                else
                    -- Player is alive — clear dead flag
                    deadPlayers[username] = nil

                    -- Check if this player has an active cooldown (they just respawned)
                    local deathTime = deathRecords[username]
                    if deathTime then
                        local remaining = delaySeconds - (now - deathTime)
                        if remaining > 0 then
                            local remainingMinutes = math.ceil(remaining / 60)
                            requestKick(username, remainingMinutes)
                        else
                            -- Cooldown expired, clean up
                            deathRecords[username] = nil
                            markDeathRecordsDirty()
                        end
                    end
                end
            end)
            if not ok then
                print("[ZomboidManager] RespawnDelay: scan error: " .. tostring(err))
            end
        end
    end
end

--- Called every minute: reload config periodically, process resets, scan players, clean expired
function ZM_RespawnDelay.tick()
    -- Reload config every CONFIG_RELOAD_INTERVAL ticks instead of every tick
    configReloadCounter = configReloadCounter + 1
    if configReloadCounter >= CONFIG_RELOAD_INTERVAL then
        configReloadCounter = 0
        loadConfig()
        processResets() -- check for resets when we reload config (same cadence)
    end

    if config.enabled then
        scanPlayers()
        cleanExpired()
    end

    -- Flush death records once at end of tick (batched writes)
    flushDeathRecords()
end

--- Called on server start: load config and persisted death records
function ZM_RespawnDelay.init()
    loadConfig()

    local data = ZM_Utils.readJsonFile(DEATHS_FILE)
    if data and data.deaths then
        deathRecords = data.deaths
        local count = 0
        for _ in pairs(deathRecords) do
            count = count + 1
        end
        print("[ZomboidManager] RespawnDelay: loaded " .. count .. " death record(s)")
    end

    print("[ZomboidManager] RespawnDelay: initialized (enabled=" .. tostring(config.enabled) .. ", delay=" .. config.delay_minutes .. "min)")
end

return ZM_RespawnDelay
