--
-- KR_Cooldown.lua — respawn cooldown after death.
--
-- When enabled, a player who dies cannot come back for a configured number of
-- minutes. The kick itself is not issued here: the mod queues a request in
-- respawn_kicks.json and Laravel performs it over RCON, which is the only
-- reliable way to disconnect someone on a dedicated server.
--
-- Deaths are noticed by polling isDead() on the minute hook rather than by
-- listening for a death event. OnPlayerDeath and OnCreatePlayer are client
-- side events and simply do not fire on a dedicated server.
--
-- Death times survive a restart via respawn_deaths.json, so a server bounce
-- is not a way around the cooldown.
--

local Bridge = require("KR_Bridge")
local Roster = require("KR_Roster")

KR_Cooldown = {}

local LOG = "[KnoxRelay] "
local CONFIG = "respawn_config.json"
local DEATHS = "respawn_deaths.json"
local RESETS = "respawn_resets.json"
local KICKS = "respawn_kicks.json"

--- Re-reading the config every tick would mean a file read every 2.5 seconds
--- for a setting that changes once a month.
local RELOAD_EVERY = 10
local sinceReload = 0

local settings = { enabled = false, delay_minutes = 60 }

--- username -> epoch seconds of death
local diedAt = {}

--- username -> true while we have already logged this death
local counted = {}

local unsaved = false

--------------------------------------------------------------------------
-- Persistence
--------------------------------------------------------------------------

local function persist()
    if not unsaved then
        return
    end

    Bridge.writeJson(DEATHS, { deaths = diedAt })
    unsaved = false
end

local function reloadSettings()
    local config = Bridge.readJson(CONFIG)
    if not config then
        return
    end

    if config.enabled ~= nil then
        settings.enabled = config.enabled
    end
    if config.delay_minutes ~= nil then
        settings.delay_minutes = tonumber(config.delay_minutes) or 60
    end
end

--- Clear timers an admin released from the dashboard, then empty the file.
local function applyResets()
    local pending = Bridge.readJson(RESETS)
    if not pending or not pending.resets then
        return
    end

    local cleared = 0
    for _, username in ipairs(pending.resets) do
        if diedAt[username] then
            diedAt[username] = nil
            counted[username] = nil
            cleared = cleared + 1
        end
    end

    if cleared > 0 then
        unsaved = true
        print(LOG .. "RespawnDelay: reset " .. cleared .. " player timer(s)")
    end

    Bridge.writeJson(RESETS, { resets = {} })
end

--------------------------------------------------------------------------
-- Enforcement
--------------------------------------------------------------------------

--- Queue a kick for Laravel to execute. Repeated calls for the same player
--- collapse into one entry so a player still in cooldown is not spammed.
local function queueKick(username, minutesLeft)
    local queued = Bridge.readJson(KICKS)
    local kicks = (queued and queued.kicks) or {}

    for _, entry in ipairs(kicks) do
        if entry.username == username then
            return
        end
    end

    kicks[#kicks + 1] = {
        username = username,
        reason = "Respawn cooldown: " .. minutesLeft .. " minute(s) remaining. Please wait.",
        timestamp = os.time(),
    }

    Bridge.writeJson(KICKS, { kicks = kicks })
    print(LOG .. "RespawnDelay: queued kick for " .. username .. " (" .. minutesLeft .. " min remaining)")
end

--- Note new deaths, and bounce anyone who respawned before their time.
local function sweep()
    local players = Roster.online()
    if not players then
        return
    end

    local now = os.time()
    local window = settings.delay_minutes * 60

    for _, player in ipairs(players) do
        local ok, failure = pcall(function()
            local username = player:getUsername()
            if not username then
                return
            end

            if player:isDead() then
                if not counted[username] then
                    counted[username] = true
                    diedAt[username] = now
                    unsaved = true
                    print(LOG .. "RespawnDelay: recorded death for " .. username)
                end

                return
            end

            counted[username] = nil

            local death = diedAt[username]
            if not death then
                return
            end

            local left = window - (now - death)
            if left > 0 then
                queueKick(username, math.ceil(left / 60))
            else
                diedAt[username] = nil
                unsaved = true
            end
        end)

        if not ok then
            print(LOG .. "RespawnDelay: scan error: " .. tostring(failure))
        end
    end
end

--- Drop records whose cooldown has fully elapsed.
local function forgetExpired()
    local now = os.time()
    local window = settings.delay_minutes * 60

    for username, death in pairs(diedAt) do
        if (now - death) >= window then
            diedAt[username] = nil
            counted[username] = nil
            unsaved = true
        end
    end
end

--------------------------------------------------------------------------
-- Lifecycle
--------------------------------------------------------------------------

function KR_Cooldown.tick()
    sinceReload = sinceReload + 1
    if sinceReload >= RELOAD_EVERY then
        sinceReload = 0
        reloadSettings()
        applyResets()
    end

    if settings.enabled then
        sweep()
        forgetExpired()
    end

    persist()
end

function KR_Cooldown.init()
    reloadSettings()

    local stored = Bridge.readJson(DEATHS)
    if stored and stored.deaths then
        diedAt = stored.deaths

        local total = 0
        for _ in pairs(diedAt) do
            total = total + 1
        end
        print(LOG .. "RespawnDelay: loaded " .. total .. " death record(s)")
    end

    print(LOG .. "RespawnDelay: initialized (enabled=" .. tostring(settings.enabled)
        .. ", delay=" .. settings.delay_minutes .. "min)")
end

return KR_Cooldown
