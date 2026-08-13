--
-- KR_Obituary.lua — what killed a character, and what they had done first.
--
-- The server log already records that someone died, and Laravel already parses
-- it. What the log cannot say is *why*: a bite, a fire, a fall, or another
-- player. That is only knowable from inside the game, at the moment of death,
-- which is what this module captures.
--
-- Deaths are found by the scan KR_Feud already runs over connected players, so
-- there is exactly one pass looking for corpses. KR_Feud owns the wound that
-- explains a PvP death; everything else about the death is written here to
-- deaths.json.
--

local Bridge = require("KR_Bridge")

KR_Obituary = {}

local LOG = "[KnoxRelay] "
local FILE = "deaths.json"

--- Deaths kept on disk. Laravel drains the file every few minutes, so this is
--- only a ceiling for the case where nothing is draining it.
local DEATH_LIMIT = 200

--- Deaths waiting to be flushed on the next tick.
local queued = {}

--- Best available explanation for a death.
---
--- Only the PvP case can be known for certain — KR_Feud saw the hit land. The
--- rest are read off the body afterwards and are therefore ranked: a burnt
--- corpse that was also infected is reported as burnt, because the fire is
--- what finished it.
--- Call a no-argument predicate if the object has it. Method names drift
--- between builds (IsInfected/isInfected), so every candidate is tried.
local function truth(object, ...)
    for _, accessor in ipairs({ ... }) do
        if object[accessor] then
            local ok, value = pcall(function() return object[accessor](object) end)
            if ok and value then
                return true
            end
        end
    end

    return false
end

local function cause(player, wound)
    if wound then
        return "player"
    end

    local ok, damage = pcall(function() return player:getBodyDamage() end)
    if not ok or not damage then
        return "unknown"
    end

    if truth(damage, "WasBurntToDeath") then
        return "fire"
    end

    if truth(damage, "isInfected", "IsInfected") then
        return "infection"
    end

    return "unknown"
end

--- Read a number off the character without letting a missing accessor throw.
local function reading(player, accessor, fallback)
    if not player[accessor] then
        return fallback
    end

    local ok, value = pcall(function() return player[accessor](player) end)
    if not ok or type(value) ~= "number" then
        return fallback
    end

    return value
end

--- Record one death. `wound` is KR_Feud's attributed hit, or nil when nothing
--- explains the death.
function KR_Obituary.record(player, wound)
    if not player then
        return
    end

    local username = player:getUsername()
    if not username or username == "" then
        return
    end

    queued[#queued + 1] = {
        username = username,
        cause = cause(player, wound),
        killer = wound and wound.attacker or nil,
        weapon = wound and wound.weapon or nil,
        x = math.floor(reading(player, "getX", 0)),
        y = math.floor(reading(player, "getY", 0)),
        z = math.floor(reading(player, "getZ", 0)),
        hours_survived = math.floor(reading(player, "getHoursSurvived", 0) * 10) / 10,
        zombie_kills = math.floor(reading(player, "getZombieKills", 0)),
        occurred_at = os.time(),
        world_time = Bridge.worldStamp(false),
    }
end

--- Append queued deaths to the file, oldest trimmed off the front.
function KR_Obituary.flush()
    if #queued == 0 then
        return 0
    end

    local stored = Bridge.readJson(FILE)
    local all = (stored and stored.deaths) or {}

    for _, death in ipairs(queued) do
        all[#all + 1] = death
    end

    while #all > DEATH_LIMIT do
        table.remove(all, 1)
    end

    if not Bridge.writeJson(FILE, { deaths = all }) then
        print(LOG .. "Obituary: ERROR writing " .. FILE)

        return 0
    end

    local written = #queued
    print(LOG .. "Obituary: recorded " .. written .. " death(s)")
    queued = {}

    return written
end

function KR_Obituary.init()
    queued = {}
    -- An empty ledger is still a ledger: the panel should see a file, not a
    -- missing one, on a server nobody has died on yet.
    if not Bridge.readJson(FILE) then
        Bridge.writeJson(FILE, { deaths = {} })
    end
    print(LOG .. "Obituary: initialized")
end

return KR_Obituary
