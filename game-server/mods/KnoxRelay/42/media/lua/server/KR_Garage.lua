--
-- KR_Garage.lua — every vehicle the server knows about.
--
-- Written to Lua/vehicles.json so the dashboard can answer "where did my car
-- go" and give admins something to work with when one ends up in a lake.
--
-- The whole vehicle list is walked, which on a long-running server is the
-- second most expensive export the mod does, so it runs on the slow hook
-- alongside progression.
--

local Codec = require("KR_Codec")
local Bridge = require("KR_Bridge")
local Roster = require("KR_Roster")
local Stash = require("KR_Stash")

KR_Garage = {}

local LOG = "[KnoxRelay] "
local FILE = "vehicles.json"

--- Key ids below this are not real keys. The engine uses -1 for "unset", and
--- treating a shared default of 0 as a match would make every keyless object
--- in the world look like it opened every keyless vehicle.
local FIRST_REAL_KEY_ID = 1

--- Where a vehicle is, preferring its own coordinates and falling back to the
--- square it sits on. A vehicle mid-teleport can briefly have neither.
local function position(vehicle)
    if vehicle.getX and vehicle.getY then
        local ok, x, y = pcall(function() return vehicle:getX(), vehicle:getY() end)
        if ok and x and y then
            return math.floor(x), math.floor(y)
        end
    end

    if vehicle.getSquare then
        local ok, square = pcall(function() return vehicle:getSquare() end)
        if ok and square then
            return square:getX(), square:getY()
        end
    end

    return nil, nil
end

--- "Base.CarNormal" -> "CarNormal", which is what the dashboard shows.
local function model(vehicle)
    local ok, name = pcall(function() return vehicle:getScriptName() end)
    if not ok or not name then
        return "unknown"
    end

    return (string.match(tostring(name), "([^%.]+)$")) or tostring(name)
end

--- Which online players are carrying which vehicle keys.
---
--- Built once per export as key id -> list of usernames, rather than asking
--- every player about every vehicle: that would be players × vehicles lookups
--- on a hook that already walks the whole fleet.
---
--- Only online players can be searched — an inventory that is not loaded
--- cannot be read — so a car whose owner logged off reports no holder here.
--- Remembering that is the panel's job, not the mod's.
local function keyHolders()
    local holders = {}
    local players = Roster.online()

    if not players then
        return holders
    end

    for _, player in ipairs(players) do
        local username = player:getUsername()

        if username then
            local seen = {}

            for _, container in ipairs(Stash.containers(player)) do
                local contents = container:getItems()

                if contents then
                    for index = 0, contents:size() - 1 do
                        local item = contents:get(index)

                        if item and item.getKeyId then
                            local ok, keyId = pcall(function() return item:getKeyId() end)

                            if ok and keyId and keyId >= FIRST_REAL_KEY_ID and not seen[keyId] then
                                seen[keyId] = true
                                holders[keyId] = holders[keyId] or {}
                                holders[keyId][#holders[keyId] + 1] = username
                            end
                        end
                    end
                end
            end
        end
    end

    return holders
end

local function describe(vehicle, holders)
    local x, y = position(vehicle)

    local entry = {
        id = tonumber(vehicle:getId()) or 0,
        model = model(vehicle),
        x = x,
        y = y,
    }

    if vehicle.getRemainingFuelPercentage then
        local ok, fuel = pcall(function() return vehicle:getRemainingFuelPercentage() end)
        if ok and fuel then
            entry.fuel_percent = math.floor(fuel + 0.5)
        end
    end

    if vehicle.getEngineQuality then
        local ok, quality = pcall(function() return vehicle:getEngineQuality() end)
        if ok and quality then
            entry.engine_quality = quality
        end
    end

    if vehicle.isEngineRunning then
        local ok, running = pcall(function() return vehicle:isEngineRunning() end)
        entry.engine_running = ok and running or false
    end

    if vehicle.getKeySpawned then
        local ok, keyed = pcall(function() return vehicle:getKeySpawned() end)
        entry.key_spawned = ok and keyed or false
    end

    --- Ownership by possession: whoever is carrying this vehicle's key.
    --- getKeyId comes from IsoObject, which BaseVehicle inherits — the same
    --- pairing vanilla uses to decide whether a character can hotwire a car.
    if vehicle.getKeyId then
        local ok, keyId = pcall(function() return vehicle:getKeyId() end)

        if ok and keyId and keyId >= FIRST_REAL_KEY_ID then
            entry.key_id = keyId
            entry.key_holders = holders[keyId] or {}
        end
    end

    return entry
end

--- Write the current fleet. Returns how many vehicles were described.
function KR_Garage.export()
    if not VehicleManager or not VehicleManager.instance then
        return 0
    end

    local ok, fleet = pcall(function() return VehicleManager.instance:getVehicles() end)
    if not ok or not fleet then
        return 0
    end

    local rows = {}
    local holders = keyHolders()

    for index = 0, fleet:size() - 1 do
        local vehicle = fleet:get(index)
        if vehicle then
            local described, entry = pcall(describe, vehicle, holders)
            if described and entry then
                rows[#rows + 1] = entry
            end
        end
    end

    local encoded, body = pcall(Codec.encode, {
        timestamp = Bridge.worldStamp(false),
        vehicle_count = #rows,
        vehicles = rows,
    })

    if not encoded then
        print(LOG .. "ERROR encoding vehicles: " .. tostring(body))

        return 0
    end

    if not Bridge.writeText(FILE, body) then
        print(LOG .. "ERROR: cannot write vehicle list")

        return 0
    end

    return #rows
end

return KR_Garage
