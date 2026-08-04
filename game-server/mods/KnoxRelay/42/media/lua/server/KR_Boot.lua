--
-- KR_Boot.lua — wiring Knox Relay into the server's event loop.
--
-- One thing to know before reading the intervals below: EveryOneMinute means
-- one *in-game* minute, which is roughly 2.5 real seconds at default speed. It
-- is the mod's heartbeat, not a once-a-minute hook. Every interval here is
-- counted in those ticks.
--
--   every tick   inventory export requests
--   6 ticks      deliveries and money deposits    (~15 real seconds)
--   12 ticks     player positions                 (~30 real seconds)
--   24 ticks     world state                      (~1 real minute)
--
-- Respawn cooldown, safe zones and PvP tracking run every tick; they do their
-- own internal rate limiting for anything expensive.
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

local LOG = "[KnoxRelay] "

print(LOG .. "Initializing server-side bridge mod v" .. Bridge.VERSION .. "...")

local DELIVERY_TICKS = 6
local DEPOSIT_TICKS = 6
local POSITION_TICKS = 12
local WORLD_TICKS = 24

local sinceDelivery = 0
local sinceDeposit = 0
local sincePosition = 0
local sinceWorld = 0

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

    sinceDelivery = sinceDelivery + 1
    if sinceDelivery >= DELIVERY_TICKS then
        sinceDelivery = 0
        local delivered = Orders.drain()
        if delivered > 0 then
            print(LOG .. "Processed " .. delivered .. " delivery entries")
        end
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

    sinceWorld = sinceWorld + 1
    if sinceWorld >= WORLD_TICKS then
        sinceWorld = 0
        World.export()
    end

    Cooldown.tick()
    Sanctuary.tick()

    --- Feud's scan is what spots the corpses, so obituaries flush after it.
    Feud.tick()
    Obituary.flush()
end

--- Progression is the heaviest export, so it gets the slow hook.
local function onEveryTenMinutes()
    local exported = Progress.export()
    if exported > 0 then
        print(LOG .. "Exported stats for " .. exported .. " players")
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

print(LOG .. "Event hooks registered: OnCreatePlayer, OnWeaponHitCharacter(2), EveryTenMinutes, EveryOneMinute, OnServerStarted, MoneyDeposit")
