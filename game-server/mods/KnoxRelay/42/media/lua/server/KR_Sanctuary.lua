--
-- KR_Sanctuary.lua — no-PvP zones.
--
-- Rectangles defined in the dashboard land in safezone_config.json. When one
-- player wounds another inside a rectangle the damage is handed straight back,
-- so an attack inside a safe zone is a no-op rather than a fight.
--
-- Attackers get one spoken warning. From the second strike on, the incident is
-- queued into safezone_violations.json for the admin log. Strike counts live in
-- memory only, so a server restart is a clean slate — deliberately, since the
-- durable record is the violation list.
--

local Bridge = require("KR_Bridge")
local Roster = require("KR_Roster")

KR_Sanctuary = {}

local LOG = "[KnoxRelay] "
local CONFIG = "safezone_config.json"
local VIOLATIONS = "safezone_violations.json"

local RELOAD_EVERY = 10
local sinceReload = 0

local settings = { enabled = false, zones = {} }

--- Mirrored out of `settings` because onWeaponHit runs on every single melee
--- swing on the server; this keeps the disabled case to one upvalue read.
local armed = false

--- attacker username -> strike count
local strikes = {}

--- Violations waiting to be flushed on the next tick.
local queued = {}

local function reloadSettings()
    local config = Bridge.readJson(CONFIG)
    if config then
        if config.enabled ~= nil then
            settings.enabled = config.enabled
        end
        if config.zones ~= nil then
            settings.zones = config.zones
        end
    end

    armed = settings.enabled
end

--- The zone covering this point, or nil.
local function zoneAt(x, y)
    for _, zone in ipairs(settings.zones) do
        if x >= zone.x1 and x <= zone.x2 and y >= zone.y1 and y <= zone.y2 then
            return zone
        end
    end

    return nil
end

--- Append queued violations to the file Laravel imports from.
local function flush()
    if #queued == 0 then
        return
    end

    local stored = Bridge.readJson(VIOLATIONS)
    local all = (stored and stored.violations) or {}

    for _, violation in ipairs(queued) do
        all[#all + 1] = violation
    end

    Bridge.writeJson(VIOLATIONS, { violations = all })
    print(LOG .. "SafeZone: flushed " .. #queued .. " violation(s) to disk")
    queued = {}
end

--- Say something in-world without letting a failed call break the hit handler.
local function announce(player, message)
    local ok, failure = pcall(function()
        player:Say(message)
    end)

    if not ok then
        print(LOG .. "SafeZone: ERROR sending warning: " .. tostring(failure))
    end
end

--- Hooked to OnWeaponHitCharacter. Runs before the PvP tracker so the health
--- is already restored by the time a kill would be attributed.
function KR_Sanctuary.onWeaponHit(attacker, target, weapon, damage)
    if not armed then
        return
    end

    if not Roster.isPlayer(attacker) or not Roster.isPlayer(target) then
        return
    end

    local zone = zoneAt(target:getX(), target:getY())
    if not zone then
        return
    end

    -- Give the damage back. Health is a 0..1 fraction.
    local healed, failure = pcall(function()
        target:setHealth(math.min(1.0, target:getHealth() + damage))
    end)
    if not healed then
        print(LOG .. "SafeZone: ERROR restoring health: " .. tostring(failure))
    end

    local attackerName = attacker:getUsername()
    if not attackerName then
        return
    end

    strikes[attackerName] = (strikes[attackerName] or 0) + 1
    local strike = strikes[attackerName]
    local zoneName = zone.name or zone.id or "unknown"

    if strike <= 1 then
        announce(attacker, "[Safe Zone] PvP is not allowed here. Warning 1/2")
        print(LOG .. "SafeZone: warned " .. attackerName .. " (strike 1) in zone " .. zoneName)

        return
    end

    announce(attacker, "[Safe Zone] Violation reported to admins.")

    queued[#queued + 1] = {
        attacker = attackerName,
        victim = target:getUsername() or "unknown",
        zone_id = zone.id or "",
        zone_name = zoneName,
        attacker_x = math.floor(attacker:getX()),
        attacker_y = math.floor(attacker:getY()),
        strike_number = strike,
        occurred_at = os.time(),
    }

    print(LOG .. "SafeZone: violation queued for " .. attackerName
        .. " (strike " .. strike .. ") in zone " .. zoneName)
end

function KR_Sanctuary.tick()
    sinceReload = sinceReload + 1
    if sinceReload >= RELOAD_EVERY then
        sinceReload = 0
        reloadSettings()
    end

    if armed then
        flush()
    end
end

function KR_Sanctuary.init()
    reloadSettings()
    print(LOG .. "SafeZone: initialized (enabled=" .. tostring(settings.enabled)
        .. ", zones=" .. #settings.zones .. ")")
end

return KR_Sanctuary
