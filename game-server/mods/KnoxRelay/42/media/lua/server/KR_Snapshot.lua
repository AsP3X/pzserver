--
-- KR_Snapshot.lua — per-player inventory snapshots.
--
-- Writes Lua/inventory/<username>.json so the dashboard can show what someone
-- is carrying. Some hosts refuse to create the nested folder from Lua, so a
-- flat inventory_<username>.json is used as a fallback.
--
-- Alongside the flat item list the snapshot carries a `containers` tree. A bag
-- is addressed by the id of the item holding it rather than by its name, since
-- a player carrying two Wallets would otherwise have both sets of contents
-- reported as one container.
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
local ROOT = "inventory"

--- Flatten one item. `held`/`offhand` are the player's equipped items, passed
--- in already resolved so equipment can be detected by reference rather than
--- by an instanceof call per item.
---
--- `container` is the node the item sits in: its name is carried for display,
--- its id so two bags called the same thing stay apart.
local function describe(item, id, container, held, offhand)
    return {
        id = id,
        full_type = item:getFullType(),
        name = item:getName(),
        category = tostring(item:getDisplayCategory() or "General"),
        count = 1,
        condition = Stash.wear(item),
        equipped = (held ~= nil and item == held) or (offhand ~= nil and item == offhand),
        container = container.name,
        container_id = container.id,
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
    local containers = {}
    local weight = 0
    local visited = {}
    local taken = {}
    local ordinal = 0

    --- A unique handle for one item. PZ gives every item an id that survives a
    --- save, which is what keeps two bags of the same name apart; anything the
    --- engine will not name gets a per-snapshot ordinal instead.
    local function identify(item)
        ordinal = ordinal + 1

        local id = nil
        if item.getID then
            local value = item:getID()
            if value then
                id = "i" .. tostring(value)
            end
        end

        if id == nil or taken[id] then
            id = "n" .. ordinal
        end
        taken[id] = true

        return id
    end

    --- Round to two decimals, matching how the snapshot reports total weight.
    local function rounded(value)
        return math.floor((value or 0) * 100) / 100
    end

    --- One node of the container tree. `parent` is the container the bag itself
    --- sits in, so the dashboard nests bags without guessing from their names.
    local function describeContainer(container, item, id, parentId)
        local entry = {
            id = "bag:" .. id,
            parent = parentId,
            name = item:getName() or "Container",
            full_type = item:getFullType(),
            item_id = id,
            worn = item.isEquipped ~= nil and item:isEquipped() == true,
        }

        if container.getCapacity then
            entry.capacity = container:getCapacity()
        end
        if container.getContentsWeight then
            entry.weight = rounded(container:getContentsWeight())
        end

        return entry
    end

    --- Depth first, and deliberately interleaved: a bag's contents are listed
    --- straight after the bag itself so the dashboard can render nesting from
    --- the flat list alone.
    local function walk(container, node)
        if not container then
            return false
        end

        local address = tostring(container)
        if visited[address] then
            return false
        end
        visited[address] = true

        containers[#containers + 1] = node

        local contents = container:getItems()
        if not contents then
            return true
        end

        for index = 0, contents:size() - 1 do
            local item = contents:get(index)
            if item then
                local id = identify(item)
                local entry = describe(item, id, node, held, offhand)
                items[#items + 1] = entry
                weight = weight + (item:getWeight() or 0)

                if item.getItemContainer then
                    local nested = item:getItemContainer()
                    if nested and walk(nested, describeContainer(nested, item, id, node.id)) then
                        entry.contains = "bag:" .. id
                    end
                end
            end
        end

        return true
    end

    local pockets = { id = ROOT, name = ROOT }
    if inventory.getCapacity then
        pockets.capacity = inventory:getCapacity()
    end
    if inventory.getContentsWeight then
        pockets.weight = rounded(inventory:getContentsWeight())
    end

    walk(inventory, pockets)

    --- Worn bags are part of the main inventory listing on most builds, so this
    --- pass is usually a no-op. Where it is not, the bag is listed as an item of
    --- the player's own pockets as well, rather than its contents appearing
    --- under a container nothing visibly holds.
    local function walkWorn(item)
        if not item or not item.getItemContainer then
            return
        end

        local nested = item:getItemContainer()
        if not nested or visited[tostring(nested)] then
            return
        end

        local id = identify(item)
        local entry = describe(item, id, pockets, held, offhand)
        items[#items + 1] = entry
        weight = weight + (item:getWeight() or 0)

        if walk(nested, describeContainer(nested, item, id, pockets.id)) then
            entry.contains = "bag:" .. id
        end
    end

    if player.getWornItems then
        local worn = player:getWornItems()
        if worn then
            for index = 0, worn:size() - 1 do
                local entry = worn:get(index)
                local item = entry
                if entry and entry.getItem then
                    item = entry:getItem()
                end
                walkWorn(item)
            end
        end
    end

    walkWorn(player:getClothingItem_Back())

    local encoded, body = pcall(Codec.encode, {
        username = username,
        timestamp = Bridge.wallStamp(),
        items = items,
        containers = containers,
        weight = rounded(weight),
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
