--
-- SP_Boot.lua — wires PZServerPulse into the server's event loop.
--
-- EveryOneMinute fires roughly every 2.5 real seconds (one in-game minute
-- at default speed). We export heartbeats every 4 ticks (~10 real seconds)
-- so the web dashboard stays fresh without hammering the disk.
--

local Bridge    = require("SP_Bridge")
local Collector = require("SP_Collector")

local LOG = "[PZServerPulse] "

print(LOG .. "Initializing server-side character dashboard v" .. Bridge.VERSION .. "...")

local EXPORT_TICKS = 4   -- ~10 real seconds at default speed
local sinceExport = 0

--------------------------------------------------------------------------
-- Recipe tracking
--------------------------------------------------------------------------

--- When a player learns a recipe, stash it in modData so the next heartbeat
--- picks it up. The list is a rolling window, not a queue: the collector reads
--- it without draining it, so the panel keeps showing the last 20 recipes
--- rather than only the ones learned since the previous export.
local function onRecipeLearned(recipeName, player)
    if not player or not player.getModData then return end

    local modData = player:getModData()
    if not modData then return end

    if not modData["SP_LearnedRecipes"] then
        modData["SP_LearnedRecipes"] = {}
    end

    local list = modData["SP_LearnedRecipes"]
    list[#list + 1] = {
        name       = recipeName or "unknown",
        learned_at = os.date and os.date("!%Y-%m-%dT%H:%M:%S") or nil,
    }

    -- Keep only the last 20 recipes
    while #list > 20 do
        table.remove(list, 1)
    end
end

--------------------------------------------------------------------------
-- Event hooks
--------------------------------------------------------------------------

local function onEveryOneMinute()
    sinceExport = sinceExport + 1
    if sinceExport >= EXPORT_TICKS then
        sinceExport = 0
        local count = Collector.exportAll()
        if count > 0 then
            print(LOG .. "Exported heartbeats for " .. count .. " players")
        end
    end
end

local function onServerStarted()
    Bridge.probe()
    print(LOG .. "Server started — heartbeat export active")
end

-- Wire up events
Events.EveryOneMinute.Add(onEveryOneMinute)
Events.OnServerStarted.Add(onServerStarted)

-- Recipe tracking (if the event exists in this build)
if Events.OnRecipeLearned then
    Events.OnRecipeLearned.Add(onRecipeLearned)
end

print(LOG .. "Event hooks registered: EveryOneMinute, OnServerStarted"
    .. (Events.OnRecipeLearned and ", OnRecipeLearned" or ""))
