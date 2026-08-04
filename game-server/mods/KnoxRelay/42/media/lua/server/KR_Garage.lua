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

KR_Garage = {}

local LOG = "[KnoxRelay] "
local FILE = "vehicles.json"

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

local function describe(vehicle)
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

    for index = 0, fleet:size() - 1 do
        local vehicle = fleet:get(index)
        if vehicle then
            local described, entry = pcall(describe, vehicle)
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
