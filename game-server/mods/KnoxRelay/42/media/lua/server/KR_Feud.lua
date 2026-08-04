--
-- KR_Feud.lua — attributing player-versus-player kills.
--
-- There is no "player killed player" event to listen for, so a kill is
-- reconstructed from two signals: who last wounded whom, and who is newly
-- dead. Every player-on-player hit is remembered against the victim, and when
-- that victim turns up dead within the expiry window the hit becomes a kill in
-- pvp_kills.json.
--
-- The window matters. Without it, being punched once and dying to a horde half
-- an hour later would be recorded as murder.
--

local Bridge = require("KR_Bridge")
local Roster = require("KR_Roster")
local Obituary = require("KR_Obituary")

KR_Feud = {}

local LOG = "[KnoxRelay] "
local FILE = "pvp_kills.json"
local KILL_LIMIT = 200

--- How long a wound stays capable of explaining a death, in seconds.
local ATTRIBUTION_WINDOW = 30

--- victim username -> details of the most recent hit taken from a player
local lastWound = {}

--- username -> true while we have already processed this death
local counted = {}

--- Kills waiting to be flushed on the next tick.
local queued = {}

--- Hooked to OnWeaponHitCharacter, after the safe-zone handler.
function KR_Feud.onWeaponHit(attacker, target, weapon, damage)
    if not Roster.isPlayer(attacker) or not Roster.isPlayer(target) then
        return
    end

    local attackerName = attacker:getUsername()
    local targetName = target:getUsername()
    if not attackerName or not targetName then
        return
    end

    -- Self-inflicted damage is not a feud.
    if attackerName == targetName then
        return
    end

    local weaponType = "unknown"
    local named, fullType = pcall(function() return weapon:getFullType() end)
    if named and fullType then
        weaponType = fullType
    end

    lastWound[targetName] = {
        attacker = attackerName,
        weapon = weaponType,
        attacker_x = math.floor(attacker:getX()),
        attacker_y = math.floor(attacker:getY()),
        victim_x = math.floor(target:getX()),
        victim_y = math.floor(target:getY()),
        timestamp = os.time(),
    }
end

--- Look for players who died since the last pass and blame the recent wound.
local function detect()
    local players = Roster.online()
    if not players then
        return
    end

    local now = os.time()

    for _, player in ipairs(players) do
        local ok, failure = pcall(function()
            local username = player:getUsername()
            if not username then
                return
            end

            if not player:isDead() then
                counted[username] = nil

                return
            end

            if counted[username] then
                return
            end
            counted[username] = true

            local wound = lastWound[username]
            local attributed = wound and (now - wound.timestamp) <= ATTRIBUTION_WINDOW

            --- Every corpse gets an obituary; only some of them get a killer.
            Obituary.record(player, attributed and wound or nil)

            if attributed then
                queued[#queued + 1] = {
                    killer = wound.attacker,
                    victim = username,
                    weapon = wound.weapon,
                    killer_x = wound.attacker_x,
                    killer_y = wound.attacker_y,
                    victim_x = wound.victim_x,
                    victim_y = wound.victim_y,
                    occurred_at = now,
                }
                print(LOG .. "PvpTracker: kill recorded — " .. wound.attacker
                    .. " killed " .. username .. " with " .. wound.weapon)
            end

            -- Spend the wound either way, so one hit can only ever be cashed
            -- in for one kill.
            lastWound[username] = nil
        end)

        if not ok then
            print(LOG .. "PvpTracker: scan error: " .. tostring(failure))
        end
    end
end

--- Append queued kills to the file, oldest trimmed off the front.
local function flush()
    if #queued == 0 then
        return
    end

    local stored = Bridge.readJson(FILE)
    local all = (stored and stored.kills) or {}

    for _, kill in ipairs(queued) do
        all[#all + 1] = kill
    end

    while #all > KILL_LIMIT do
        table.remove(all, 1)
    end

    Bridge.writeJson(FILE, { kills = all })
    print(LOG .. "PvpTracker: flushed " .. #queued .. " kill(s) to disk")
    queued = {}
end

function KR_Feud.tick()
    detect()
    flush()
end

function KR_Feud.init()
    lastWound = {}
    counted = {}
    queued = {}
    print(LOG .. "PvpTracker: initialized")
end

return KR_Feud
