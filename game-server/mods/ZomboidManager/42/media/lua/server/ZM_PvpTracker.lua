--
-- ZM_PvpTracker.lua — Tracks actual PvP kills (player-kills-player) via death detection.
-- Uses file-based IPC: writes confirmed kills to pvp_kills.json for Laravel import.
--
-- Distinguishes real kills from weapon hits by pairing OnWeaponHitCharacter data
-- with player death detection (isDead check on tick).
--

require("ZM_Utils")

ZM_PvpTracker = {}

local KILLS_FILE = "pvp_kills.json"
local MAX_KILLS = 200
local HIT_EXPIRY_SECONDS = 30

-- In-memory state
local lastAttacker = {} -- { victimUsername = { attacker, weapon, attacker_x, attacker_y, victim_x, victim_y, timestamp } }
local deadPlayers = {} -- { username = true } — tracks who we've already recorded as dead
local pendingKills = {} -- queued for flush to disk

--- Called on every weapon hit. Filters for player-vs-player and records last attacker.
function ZM_PvpTracker.onWeaponHitCharacter(attacker, target, weapon, damage)
    -- Guard: both must be IsoPlayer instances
    local ok1, isPlayerA = pcall(function() return instanceof(attacker, "IsoPlayer") end)
    local ok2, isPlayerT = pcall(function() return instanceof(target, "IsoPlayer") end)
    if not ok1 or not isPlayerA or not ok2 or not isPlayerT then
        return
    end

    local attackerName = attacker:getUsername()
    local targetName = target:getUsername()
    if not attackerName or not targetName then
        return
    end

    -- Don't track self-damage
    if attackerName == targetName then
        return
    end

    local weaponType = "unknown"
    local wOk, wName = pcall(function() return weapon:getFullType() end)
    if wOk and wName then
        weaponType = wName
    end

    lastAttacker[targetName] = {
        attacker = attackerName,
        weapon = weaponType,
        attacker_x = math.floor(attacker:getX()),
        attacker_y = math.floor(attacker:getY()),
        victim_x = math.floor(target:getX()),
        victim_y = math.floor(target:getY()),
        timestamp = os.time(),
    }
end

--- Scan online players for deaths. When a player is dead and was recently hit by another player,
--- record a PvP kill.
local function scanForKills()
    local players = getOnlinePlayers()
    if not players then
        return
    end

    local now = os.time()

    for i = 0, players:size() - 1 do
        local player = players:get(i)
        if player then
            local ok, err = pcall(function()
                local username = player:getUsername()
                if not username then
                    return
                end

                if player:isDead() then
                    -- Player is dead — check if we already processed this death
                    if not deadPlayers[username] then
                        deadPlayers[username] = true

                        -- Check if there's a recent attacker record
                        local hit = lastAttacker[username]
                        if hit and (now - hit.timestamp) <= HIT_EXPIRY_SECONDS then
                            table.insert(pendingKills, {
                                killer = hit.attacker,
                                victim = username,
                                weapon = hit.weapon,
                                killer_x = hit.attacker_x,
                                killer_y = hit.attacker_y,
                                victim_x = hit.victim_x,
                                victim_y = hit.victim_y,
                                occurred_at = now,
                            })
                            print("[ZomboidManager] PvpTracker: kill recorded — " .. hit.attacker .. " killed " .. username .. " with " .. hit.weapon)
                        end

                        -- Clear attacker record to prevent double-counting
                        lastAttacker[username] = nil
                    end
                else
                    -- Player is alive — clear dead flag
                    deadPlayers[username] = nil
                end
            end)
            if not ok then
                print("[ZomboidManager] PvpTracker: scan error: " .. tostring(err))
            end
        end
    end
end

--- Flush pending kills to disk (appends to existing file, caps at MAX_KILLS)
local function flushKills()
    if #pendingKills == 0 then
        return
    end

    -- Read existing kills from file
    local existing = ZM_Utils.readJsonFile(KILLS_FILE)
    local list = {}
    if existing and existing.kills then
        list = existing.kills
    end

    -- Append new kills
    for _, k in ipairs(pendingKills) do
        table.insert(list, k)
    end

    -- Cap to prevent unbounded growth
    while #list > MAX_KILLS do
        table.remove(list, 1)
    end

    ZM_Utils.writeJsonFile(KILLS_FILE, { kills = list })
    print("[ZomboidManager] PvpTracker: flushed " .. #pendingKills .. " kill(s) to disk")
    pendingKills = {}
end

--- Called every game minute from onEveryOneMinute
function ZM_PvpTracker.tick()
    scanForKills()
    flushKills()
end

--- Called on server start
function ZM_PvpTracker.init()
    lastAttacker = {}
    deadPlayers = {}
    pendingKills = {}
    print("[ZomboidManager] PvpTracker: initialized")
end

return ZM_PvpTracker
