--
-- KR_Boot.lua — wiring Knox Relay into the server's event loop.
--
-- One thing to know before reading the intervals below: EveryOneMinute means
-- one *in-game* minute, which is roughly 2.5 real seconds at default speed. It
-- is the mod's heartbeat, not a once-a-minute hook. Every interval here is
-- counted in those ticks.
--
--   every tick   inventory export requests
--   4 ticks      character vitals heartbeats      (~10 real seconds)
--   6 ticks      deliveries and money deposits    (~15 real seconds)
--   12 ticks     player positions                 (~30 real seconds)
--   48 ticks     safehouse and faction claims      (~2 real minutes)
--
-- Respawn cooldown, safe zones and PvP tracking run every tick; they do their
-- own internal rate limiting for anything expensive.
--
-- World state is the exception: it hangs off OnTickEvenPaused, a real-time
-- hook, not the in-game clock. GameTime fires every EveryX event, so a server
-- with PauseEmpty=true and nobody connected stops firing them altogether and
-- the panel's clock, weather and temperature freeze with no way to tell that
-- apart from a dead bridge. IngameState.updateInternal triggers
-- OnTickEvenPaused before it reaches the pause gate, so it keeps running.
--

local Bridge = require("KR_Bridge")
local Snapshot = require("KR_Snapshot")
local Orders = require("KR_Orders")
local Vault = require("KR_Vault")
local Beacon = require("KR_Beacon")
local World = require("KR_World")
local Progress = require("KR_Progress")
local Catalog = require("KR_Catalog")
local Cooldown = require("KR_Cooldown")
local Sanctuary = require("KR_Sanctuary")
local Feud = require("KR_Feud")
local Obituary = require("KR_Obituary")
local Holdings = require("KR_Holdings")
local Conductor = require("KR_Conductor")
local Garage = require("KR_Garage")
local Vitals = require("KR_Vitals")
local Enrol = require("KR_Enrol")

local LOG = "[KnoxRelay] "

print(LOG .. "Initializing server-side bridge mod v" .. Bridge.VERSION .. "...")

local DELIVERY_TICKS = 6
local DEPOSIT_TICKS = 6
local POSITION_TICKS = 12
local VITALS_TICKS = 4
local HOLDINGS_TICKS = 48

--- Real seconds between world exports. OnTickEvenPaused fires every frame, so
--- this is what keeps it to a file write rather than a busy loop.
local WORLD_SECONDS = 10

--- How many recently learned recipes to keep per character. The list rides in
--- the player's modData and ships in every heartbeat, so it stays short.
local RECIPE_HISTORY = 20

local sinceDelivery = 0
local sinceDeposit = 0
local sincePosition = 0
local sinceVitals = 0
local sinceHoldings = 0
local lastWorldExport = 0
local framesSinceWorld = 0

--- Roughly WORLD_SECONDS of frames, for when os.time is unavailable. Erring
--- long is fine; erring short would write the file on every frame.
local WORLD_FRAMES = 600

--- Export world state at most once per WORLD_SECONDS of wall time.
---
--- Called from both the real-time hook and the in-game one: if a build ever
--- fails to deliver OnTickEvenPaused, the minute hook still exports whenever
--- the clock is running, which is the case that matters most.
local function exportWorld()
    local gotTime, now = pcall(os.time)

    if gotTime and type(now) == "number" then
        if (now - lastWorldExport) < WORLD_SECONDS then
            return
        end
        lastWorldExport = now
    else
        -- No clock to throttle against, and this runs once per frame, so
        -- count frames instead of writing the file sixty times a second.
        framesSinceWorld = framesSinceWorld + 1
        if framesSinceWorld < WORLD_FRAMES then
            return
        end
        framesSinceWorld = 0
    end

    World.export()
end

--- A player joined or spawned.
--- Unreliable on dedicated servers, so nothing critical hangs off it; death
--- and respawn handling lives on the tick instead.
local function onCreatePlayer(playerIndex, player)
    if not player then
        return
    end

    print(LOG .. "Player connected: " .. (player:getUsername() or "unknown"))

    Snapshot.capture(player)
    Orders.drain()
end

--- The heartbeat.
local function onEveryOneMinute()
    Snapshot.serveRequests()

    -- Every tick, not on a divisor: a player is standing in game waiting to be
    -- shown a code, and the panel aims to answer inside five seconds.
    Enrol.poll()

    sinceDelivery = sinceDelivery + 1
    if sinceDelivery >= DELIVERY_TICKS then
        sinceDelivery = 0
        local delivered = Orders.drain()
        if delivered > 0 then
            print(LOG .. "Processed " .. delivered .. " delivery entries")
        end

        Conductor.drain()
    end

    sinceDeposit = sinceDeposit + 1
    if sinceDeposit >= DEPOSIT_TICKS then
        sinceDeposit = 0
        local deposited = Vault.process()
        if deposited > 0 then
            print(LOG .. "Processed " .. deposited .. " money deposit(s)")
        end
    end

    sincePosition = sincePosition + 1
    if sincePosition >= POSITION_TICKS then
        sincePosition = 0
        Beacon.export()
    end

    sinceVitals = sinceVitals + 1
    if sinceVitals >= VITALS_TICKS then
        sinceVitals = 0
        Vitals.export()
    end

    exportWorld()

    sinceHoldings = sinceHoldings + 1
    if sinceHoldings >= HOLDINGS_TICKS then
        sinceHoldings = 0
        Holdings.export()
    end

    Cooldown.tick()
    Sanctuary.tick()

    --- Feud's scan is what spots the corpses, so obituaries flush after it.
    Feud.tick()
    Obituary.flush()
end

--- The real-time heartbeat. Fires every frame whether or not the world is
--- paused, so it is the only hook that keeps running on an empty server with
--- PauseEmpty=true. exportWorld() throttles it to a write every WORLD_SECONDS.
local function onTickEvenPaused()
    exportWorld()
end

--- Remember a recipe the moment it is learned.
---
--- The game offers no way to ask a character what it has recently learned, so
--- the list has to be accumulated on the player as the events arrive. It is a
--- rolling window rather than a queue: KR_Vitals reads it without draining it,
--- so the page keeps showing the last few rather than only what was learned
--- since the previous heartbeat.
local function onRecipeLearned(recipeName, player)
    if not player then
        return
    end

    local modData = player:getModData()
    if not modData then
        return
    end

    local learned = modData[Vitals.RECIPE_KEY]
    if type(learned) ~= "table" then
        learned = {}
        modData[Vitals.RECIPE_KEY] = learned
    end

    learned[#learned + 1] = {
        name = recipeName or "unknown",
        learned_at = Bridge.wallStamp(),
    }

    while #learned > RECIPE_HISTORY do
        table.remove(learned, 1)
    end
end

--- Progression and the vehicle fleet are the heaviest exports, so they share
--- the slow hook.
local function onEveryTenMinutes()
    local exported = Progress.export()
    if exported > 0 then
        print(LOG .. "Exported stats for " .. exported .. " players")
    end

    local vehicles = Garage.export()
    if vehicles > 0 then
        print(LOG .. "Exported " .. vehicles .. " vehicles")
    end
end

--- Server is up: prime the stateful subsystems and write the exports that
--- must exist even if nobody ever connects.
local function onServerStarted()
    Cooldown.init()
    Sanctuary.init()
    Feud.init()
    Obituary.init()
    Vault.init()

    -- Prove writes reach the bind mount before anything depends on them.
    Bridge.probe()

    if World.export() then
        print(LOG .. "Exported initial game state")
    end

    Holdings.export()

    local ok, count = pcall(Catalog.export)
    if ok and count and count > 0 then
        print(LOG .. "Exported item catalog: " .. count .. " items")
    else
        print(LOG .. "WARNING: item catalog export failed or returned 0 items")
    end
end

Events.OnCreatePlayer.Add(onCreatePlayer)
Events.OnWeaponHitCharacter.Add(Sanctuary.onWeaponHit)
Events.OnWeaponHitCharacter.Add(Feud.onWeaponHit)
Events.EveryTenMinutes.Add(onEveryTenMinutes)
Events.EveryOneMinute.Add(onEveryOneMinute)
Events.OnServerStarted.Add(onServerStarted)
Events.OnClientCommand.Add(Enrol.onClientCommand)

-- Optional: without it a player who disconnects mid-registration leaves an
-- entry that poll() drops on the answer timeout anyway.
local disconnectHooked = pcall(function() Events.OnPlayerDisconnect.Add(Enrol.forget) end)

-- No vanilla Lua subscribes to OnTickEvenPaused, so treat it as optional: an
-- indexing error here would take the whole mod down with it, and everything
-- else still works without the real-time cadence.
local tickHooked = pcall(function() Events.OnTickEvenPaused.Add(onTickEvenPaused) end)

-- Optional for the same reason. Without it the heartbeat still carries
-- everything else; only the recently-learned-recipes panel stays empty.
local recipeHooked = pcall(function() Events.OnRecipeLearned.Add(onRecipeLearned) end)

print(LOG .. "Event hooks registered: OnCreatePlayer, OnWeaponHitCharacter(2), EveryTenMinutes, EveryOneMinute, OnServerStarted, OnClientCommand, MoneyDeposit"
    .. (tickHooked and ", OnTickEvenPaused" or "")
    .. (recipeHooked and ", OnRecipeLearned" or "")
    .. (disconnectHooked and ", OnPlayerDisconnect" or ""))

if not tickHooked then
    print(LOG .. "WARNING: OnTickEvenPaused unavailable — world state will not refresh while the server is paused and empty")
end

if not recipeHooked then
    print(LOG .. "WARNING: OnRecipeLearned unavailable — the recent recipes panel will stay empty")
end
