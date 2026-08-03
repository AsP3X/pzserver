--
-- ZM_InventoryExporter.lua — Exports per-player inventory snapshots to JSON
-- Writes to: Lua/inventory/<username>.json
--

local JSON = require("ZM_JSON")
require("ZM_Utils")

ZM_InventoryExporter = {}

local INVENTORY_DIR = "inventory"

--- Serialize a single inventory item.
--- primaryItem/secondaryItem are pre-cached equipped item references (avoids instanceof).
local function serializeItem(item, containerName, primaryItem, secondaryItem)
    local data = {
        full_type = item:getFullType(),
        name = item:getName(),
        category = tostring(item:getDisplayCategory() or "General"),
        count = 1,
        condition = 1.0,
        equipped = false,
        container = containerName or "inventory",
    }

    -- Condition (for drainables like water bottles, or weapons/clothing)
    if item.getCondition and item.getMaxCondition then
        local maxCond = item:getMaxCondition()
        if maxCond > 0 then
            data.condition = math.floor((item:getCondition() / maxCond) * 100) / 100
        end
    end

    -- Check if item is equipped via reference equality (no instanceof needed)
    if primaryItem and item == primaryItem then
        data.equipped = true
    elseif secondaryItem and item == secondaryItem then
        data.equipped = true
    end

    return data
end

--- Export a single player's inventory to JSON
function ZM_InventoryExporter.exportPlayer(player)
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

    -- Cache equipped items once per player (avoids instanceof per-item)
    local primaryItem = player:getPrimaryHandItem()
    local secondaryItem = player:getSecondaryHandItem()

    local items = {}
    local totalWeight = 0
    local seenContainers = {}

    --- Walk a container and every nested container inside it.
    local function collect(container, containerName)
        if not container then
            return
        end
        local key = tostring(container)
        if seenContainers[key] then
            return
        end
        seenContainers[key] = true

        local containerItems = container:getItems()
        if not containerItems then
            return
        end

        for i = 0, containerItems:size() - 1 do
            local item = containerItems:get(i)
            if item then
                table.insert(items, serializeItem(item, containerName, primaryItem, secondaryItem))
                totalWeight = totalWeight + (item:getWeight() or 0)

                if item.getItemContainer then
                    local nested = item:getItemContainer()
                    if nested then
                        collect(nested, item:getName() or containerName)
                    end
                end
            end
        end
    end

    collect(inventory, "inventory")

    if player.getWornItems then
        local worn = player:getWornItems()
        if worn then
            for i = 0, worn:size() - 1 do
                local wornItem = worn:get(i)
                local item = wornItem
                if wornItem and wornItem.getItem then
                    item = wornItem:getItem()
                end
                if item and item.getItemContainer then
                    local c = item:getItemContainer()
                    if c then
                        collect(c, item:getName() or "worn")
                    end
                end
            end
        end
    end

    local backpack = player:getClothingItem_Back()
    if backpack and backpack:getItemContainer() then
        collect(backpack:getItemContainer(), backpack:getName() or "backpack")
    end

    local data = {
        username = username,
        timestamp = ZM_Utils.getTimestamp(),
        items = items,
        weight = math.floor(totalWeight * 100) / 100,
        max_weight = player:getMaxWeight() or 15.0,
    }

    local ok, jsonStr = pcall(JSON.encode, data)
    if not ok then
        print("[ZomboidManager] ERROR encoding inventory for " .. username .. ": " .. tostring(jsonStr))
        return false
    end

    -- Prefer nested inventory/<user>.json; fall back to flat inventory_<user>.json
    -- if getFileWriter rejects subdirectories on this host.
    local relPath = INVENTORY_DIR .. "/" .. username .. ".json"
    if ZM_Utils.writeRawFile(relPath, jsonStr) then
        return true
    end

    local flatPath = "inventory_" .. username .. ".json"
    if ZM_Utils.writeRawFile(flatPath, jsonStr) then
        print("[ZomboidManager] Wrote inventory via flat path: " .. flatPath)
        return true
    end

    print("[ZomboidManager] ERROR: cannot open file writer for " .. username)
    return false
end

local EXPORT_REQUESTS_FILE = "export_requests.json"

--- Process on-demand export requests written by PHP.
--- Reads export_requests.json, exports requested players, then clears the file.
function ZM_InventoryExporter.processExportRequests()
    local data = ZM_Utils.readJsonFile(EXPORT_REQUESTS_FILE)
    if not data or not data.usernames or #data.usernames == 0 then
        return 0
    end

    local players = getOnlinePlayers()
    if not players then
        return 0
    end

    -- Build lookup of online players by username
    local onlineByName = {}
    for i = 0, players:size() - 1 do
        local p = players:get(i)
        if p then
            onlineByName[p:getUsername()] = p
        end
    end

    local count = 0
    for _, username in ipairs(data.usernames) do
        local player = onlineByName[username]
        if player and ZM_InventoryExporter.exportPlayer(player) then
            count = count + 1
        end
    end

    -- Clear the request file
    ZM_Utils.writeJsonFile(EXPORT_REQUESTS_FILE, {usernames = {}, updated_at = ZM_Utils.getTimestamp()})

    if count > 0 then
        print("[ZomboidManager] On-demand inventory export: " .. count .. " player(s)")
    end

    return count
end

--- Export all online players' inventories
function ZM_InventoryExporter.exportAll()
    local players = getOnlinePlayers()
    if not players then
        return 0
    end

    local count = 0
    for i = 0, players:size() - 1 do
        local player = players:get(i)
        if player and ZM_InventoryExporter.exportPlayer(player) then
            count = count + 1
        end
    end

    return count
end

return ZM_InventoryExporter
