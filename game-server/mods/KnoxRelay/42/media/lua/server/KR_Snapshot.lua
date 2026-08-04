--
-- KR_Snapshot.lua — per-player inventory snapshots.
--
-- Writes Lua/inventory/<username>.json so the dashboard can show what someone
-- is carrying. Some hosts refuse to create the nested folder from Lua, so a
-- flat inventory_<username>.json is used as a fallback.
--
-- Laravel can also ask for a snapshot out of band by dropping usernames into
-- export_requests.json; that file is checked on every tick and cleared once
-- the requested players have been written.
--

local Codec = require("KR_Codec")
local Bridge = require("KR_Bridge")
local Roster = require("KR_Roster")
local Stash = require("KR_Stash")

KR_Snapshot = {}

local LOG = "[KnoxRelay] "
local FOLDER = "inventory"
local REQUESTS = "export_requests.json"

--- Flatten one item. `held`/`offhand` are the player's equipped items, passed
--- in already resolved so equipment can be detected by reference rather than
--- by an instanceof call per item.
local function describe(item, holder, held, offhand)
    return {
        full_type = item:getFullType(),
        name = item:getName(),
        category = tostring(item:getDisplayCategory() or "General"),
        count = 1,
        condition = Stash.wear(item),
        equipped = (held ~= nil and item == held) or (offhand ~= nil and item == offhand),
        container = holder or "inventory",
    }
end

--- Snapshot one player to disk. Returns true when a file was written.
function KR_Snapshot.capture(player)
    if not player or not instanceof(player, "IsoPlayer") then
        return false
    end

    local username = player:getUsername()
    if not username or username == "" then
        return false
    end

    local inventory = player:getInventory()
    if not inventory then
        return false
    end

    local held = player:getPrimaryHandItem()
    local offhand = player:getSecondaryHandItem()

    local items = {}
    local weight = 0
    local visited = {}

    --- Depth first, and deliberately interleaved: a bag's contents are listed
    --- straight after the bag itself so the dashboard can render nesting from
    --- the flat list alone.
    local function walk(container, holder)
        if not container then
            return
        end

        local address = tostring(container)
        if visited[address] then
            return
        end
        visited[address] = true

        local contents = container:getItems()
        if not contents then
            return
        end

        for index = 0, contents:size() - 1 do
            local item = contents:get(index)
            if item then
                items[#items + 1] = describe(item, holder, held, offhand)
                weight = weight + (item:getWeight() or 0)

                if item.getItemContainer then
                    local nested = item:getItemContainer()
                    if nested then
                        walk(nested, item:getName() or holder)
                    end
                end
            end
        end
    end

    walk(inventory, "inventory")

    if player.getWornItems then
        local worn = player:getWornItems()
        if worn then
            for index = 0, worn:size() - 1 do
                local entry = worn:get(index)
                local item = entry
                if entry and entry.getItem then
                    item = entry:getItem()
                end
                if item and item.getItemContainer then
                    local container = item:getItemContainer()
                    if container then
                        walk(container, item:getName() or "worn")
                    end
                end
            end
        end
    end

    local backpack = player:getClothingItem_Back()
    if backpack and backpack:getItemContainer() then
        walk(backpack:getItemContainer(), backpack:getName() or "backpack")
    end

    local encoded, body = pcall(Codec.encode, {
        username = username,
        timestamp = Bridge.wallStamp(),
        items = items,
        weight = math.floor(weight * 100) / 100,
        max_weight = player:getMaxWeight() or 15.0,
    })

    if not encoded then
        print(LOG .. "ERROR encoding inventory for " .. username .. ": " .. tostring(body))

        return false
    end

    if Bridge.writeText(FOLDER .. "/" .. username .. ".json", body) then
        return true
    end

    local flat = "inventory_" .. username .. ".json"
    if Bridge.writeText(flat, body) then
        print(LOG .. "Wrote inventory via flat path: " .. flat)

        return true
    end

    print(LOG .. "ERROR: cannot open file writer for " .. username)

    return false
end

--- Serve any snapshot requests Laravel queued, then empty the request file.
--- Runs every tick, so the common no-op path stays a single file read.
function KR_Snapshot.serveRequests()
    local request = Bridge.readJson(REQUESTS)
    if not request or not request.usernames or #request.usernames == 0 then
        return 0
    end

    local online = Roster.byUsername()
    if not online then
        return 0
    end

    local written = 0
    for _, username in ipairs(request.usernames) do
        local player = online[username]
        if player and KR_Snapshot.capture(player) then
            written = written + 1
        end
    end

    Bridge.writeJson(REQUESTS, { usernames = {}, updated_at = Bridge.wallStamp() })

    if written > 0 then
        print(LOG .. "On-demand inventory export: " .. written .. " player(s)")
    end

    return written
end

--- Snapshot everyone currently connected.
function KR_Snapshot.captureAll()
    local players = Roster.online()
    if not players then
        return 0
    end

    local written = 0
    for _, player in ipairs(players) do
        if KR_Snapshot.capture(player) then
            written = written + 1
        end
    end

    return written
end

return KR_Snapshot
