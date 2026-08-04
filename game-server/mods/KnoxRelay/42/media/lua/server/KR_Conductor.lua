--
-- KR_Conductor.lua — world-scoped actions from the dashboard.
--
-- Reads Lua/world_actions.json and writes Lua/world_results.json. Deliberately
-- a separate queue from KR_Orders: that one is money-critical and every entry
-- there is addressed to a player who must be online. These act on the world,
-- so a queue that refuses to run without a named player online cannot carry
-- them.
--
-- Every action is idempotent by id: a result already in the ledger is never
-- performed twice, however often the file is re-read.
--

local Codec = require("KR_Codec")
local Bridge = require("KR_Bridge")

KR_Conductor = {}

local LOG = "[KnoxRelay] "
local QUEUE = "world_actions.json"
local RESULTS = "world_results.json"

--- Cap so a typo cannot leave the map under permanent thunder.
local MAX_STORM_HOURS = 24

--- Start a storm for `hours` in-game hours.
local function actionStorm(entry)
    local climate = getClimateManager()
    if not climate or not climate.transmitServerTriggerStorm then
        return false, "climate manager unavailable"
    end

    local hours = tonumber(entry.duration_hours) or 3
    if hours < 1 then
        hours = 1
    end
    if hours > MAX_STORM_HOURS then
        hours = MAX_STORM_HOURS
    end

    local ok, failure = pcall(function() climate:transmitServerTriggerStorm(hours) end)
    if not ok then
        return false, "storm failed: " .. tostring(failure)
    end

    return true, nil, { duration_hours = hours }
end

--- Stop whatever the sky is currently doing.
local function actionClearWeather()
    local climate = getClimateManager()
    if not climate or not climate.transmitServerStopWeather then
        return false, "climate manager unavailable"
    end

    local ok, failure = pcall(function() climate:transmitServerStopWeather() end)
    if not ok then
        return false, "clear failed: " .. tostring(failure)
    end

    return true, nil, {}
end

local function perform(entry)
    if entry.action == "storm" then
        return actionStorm(entry)
    end
    if entry.action == "clear_weather" then
        return actionClearWeather()
    end

    return false, "unknown world action: " .. tostring(entry.action)
end

local function loadLedger()
    local ledger = Bridge.readJson(RESULTS)
    if not ledger or not ledger.results then
        return { results = {} }
    end

    return ledger
end

--- Work through every pending entry. Returns how many produced a result.
function KR_Conductor.drain()
    local queue = Bridge.readJson(QUEUE)
    if not queue or not queue.entries then
        return 0
    end

    local ledger = loadLedger()
    local done = {}
    for _, result in ipairs(ledger.results) do
        done[result.id] = true
    end

    local handled = 0

    for _, entry in ipairs(queue.entries) do
        if entry.status == "pending" and not done[entry.id] then
            local ok, failure, proof = perform(entry)

            local result = {
                id = entry.id,
                status = ok and "done" or "failed",
                processed_at = Bridge.wallStamp(),
                message = failure,
            }

            if proof then
                for key, value in pairs(proof) do
                    result[key] = value
                end
            end

            if ok then
                print(LOG .. "World action performed: " .. tostring(entry.action))
            else
                print(LOG .. "World action failed: " .. tostring(failure))
            end

            ledger.results[#ledger.results + 1] = result
            handled = handled + 1
        end
    end

    if handled > 0 then
        -- Keep the ledger from growing without bound; the dashboard only ever
        -- shows the tail of it.
        while #ledger.results > 100 do
            table.remove(ledger.results, 1)
        end

        local encoded, body = pcall(Codec.encode, ledger)
        if encoded then
            Bridge.writeText(RESULTS, body)
        else
            print(LOG .. "ERROR encoding world results: " .. tostring(body))
        end
    end

    return handled
end

return KR_Conductor
