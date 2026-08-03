--
-- ZM_DeliveryQueue.lua — Reads delivery_queue.json, processes give/remove actions,
-- writes results to delivery_results.json
--

require("ZM_Utils")
require("ZM_InventoryExporter")

ZM_DeliveryQueue = {}

local QUEUE_FILE = "delivery_queue.json"
local RESULTS_FILE = "delivery_results.json"
local MAX_RESULTS = 200

--- Read existing results file
local function readResults()
    local data = ZM_Utils.readJsonFile(RESULTS_FILE)
    if data then
        return data
    end
    return {version = 1, updated_at = "", results = {}}
end

--- Write results to file, trimming oldest entries if over cap
local function writeResults(results)
    results.updated_at = ZM_Utils.getTimestamp()

    -- Cap results list to prevent unbounded growth
    while results.results and #results.results > MAX_RESULTS do
        table.remove(results.results, 1)
    end

    ZM_Utils.writeJsonFile(RESULTS_FILE, results)
end

--- Find online player by username
local function findPlayer(username)
    local players = getOnlinePlayers()
    if not players then
        return nil
    end
    for i = 0, players:size() - 1 do
        local p = players:get(i)
        if p and p:getUsername() == username then
            return p
        end
    end
    return nil
end

--- "Base.WaterBottle" → "WaterBottle" (getFirstType* matches getType(), not full type)
local function shortTypeName(itemType)
    if not itemType then
        return itemType
    end
    local short = string.match(itemType, "([^%.]+)$")
    return short or itemType
end

--- All item containers on the player (main inv + nested bags + worn containers)
local function collectContainers(player)
    local containers = {}
    local seen = {}

    local function addContainer(container)
        if not container then
            return
        end
        local key = tostring(container)
        if seen[key] then
            return
        end
        seen[key] = true
        table.insert(containers, container)

        local items = container:getItems()
        if not items then
            return
        end
        for i = 0, items:size() - 1 do
            local item = items:get(i)
            if item and item.getItemContainer then
                local nested = item:getItemContainer()
                if nested then
                    addContainer(nested)
                end
            end
        end
    end

    addContainer(player:getInventory())

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
                        addContainer(c)
                    end
                end
            end
        end
    end

    local backpack = player:getClothingItem_Back()
    if backpack and backpack:getItemContainer() then
        addContainer(backpack:getItemContainer())
    end

    return containers
end

--- Does this inventory item match the requested type (full or short)?
local function itemMatchesType(item, itemType)
    if not item or not itemType then
        return false
    end
    if item.getFullType and item:getFullType() == itemType then
        return true
    end
    if item.getType and item:getType() == itemType then
        return true
    end
    local short = shortTypeName(itemType)
    if short and item.getType and item:getType() == short then
        return true
    end
    return false
end

--- Find first matching item in a container (full-type aware)
local function findItemInContainer(container, itemType)
    if not container then
        return nil
    end

    -- Preferred: full-type API
    if container.getItemsFromFullType then
        local items = container:getItemsFromFullType(itemType)
        if items and items:size() > 0 then
            return items:get(0)
        end
    end

    -- getFirstType / getFirstTypeRecurse expect SHORT type (WaterBottle), not Base.WaterBottle
    local short = shortTypeName(itemType)
    if container.getFirstType then
        local item = container:getFirstType(short)
        if item then
            return item
        end
        -- also try as-is in case caller already passed short type
        if short ~= itemType then
            item = container:getFirstType(itemType)
            if item then
                return item
            end
        end
    end

    -- Manual scan
    local items = container:getItems()
    if not items then
        return nil
    end
    for i = 0, items:size() - 1 do
        local item = items:get(i)
        if itemMatchesType(item, itemType) then
            return item
        end
    end
    return nil
end

--- Count items of a specific type across all player containers
local function countItemType(player, itemType)
    local total = 0
    for _, container in ipairs(collectContainers(player)) do
        if container.getItemsFromFullType then
            local items = container:getItemsFromFullType(itemType)
            if items then
                total = total + items:size()
            end
        else
            local items = container:getItems()
            if items then
                for i = 0, items:size() - 1 do
                    if itemMatchesType(items:get(i), itemType) then
                        total = total + 1
                    end
                end
            end
        end
    end
    return total
end

--- Sync inventory to client after server-side item addition
local function syncAddToClient(player, itemType, count)
    local inventory = player:getInventory()
    if inventory then
        inventory:setDirty(true)
        inventory:setDrawDirty(true)
    end
    -- Tell the client to add the item locally for instant UI update
    if isServer() then
        sendServerCommand(player, "KnoxRelay", "addItem", {
            item_type = itemType,
            count = tostring(count),
        })
    end
end

--- Sync inventory to client after server-side item removal
local function syncRemoveToClient(player)
    local inventory = player:getInventory()
    if inventory then
        inventory:setDirty(true)
        inventory:setDrawDirty(true)
    end
end

-- Forward declaration (give_verified rollback calls removeOneItem)
local removeOneItem

--- Give item to player (fallback when RCON is unavailable)
local function giveItem(player, itemType, count)
    local inventory = player:getInventory()
    if not inventory then
        return false, "player has no inventory"
    end

    for i = 1, count do
        local item = inventory:AddItem(itemType)
        if not item then
            return false, "failed to add item " .. itemType .. " (attempt " .. i .. "/" .. count .. ")"
        end
    end

    syncAddToClient(player, itemType, count)

    return true, nil
end

--- Give item to player with verification (count before/after)
local function giveItemVerified(player, itemType, count)
    local inventory = player:getInventory()
    if not inventory then
        return false, "player has no inventory", nil
    end

    -- Step 1: Count items BEFORE giving
    local countBefore = countItemType(player, itemType)

    -- Step 2: Add items
    for i = 1, count do
        local item = inventory:AddItem(itemType)
        if not item then
            -- Partial add — count what we actually added and report
            local countAfterPartial = countItemType(player, itemType)
            local actuallyAdded = countAfterPartial - countBefore
            if actuallyAdded > 0 then
                -- Remove partially added items to keep things clean
                for j = 1, actuallyAdded do
                    removeOneItem(player, itemType)
                end
            end
            return false, "failed to add item " .. itemType .. " (attempt " .. i .. "/" .. count .. ")", nil
        end
    end

    -- Step 3: Count items AFTER giving
    local countAfter = countItemType(player, itemType)

    -- Step 4: Verify count
    local verified = countAfter >= countBefore + count
    if not verified then
        -- Verification failed — try to rollback
        local actuallyAdded = countAfter - countBefore
        print("[KnoxRelay] WARNING: give_verified failed verification for " .. itemType ..
              " — expected >=" .. (countBefore + count) .. " but got " .. countAfter)
        for j = 1, actuallyAdded do
            removeOneItem(player, itemType)
        end
        return false, "verification failed: expected >=" .. (countBefore + count) .. " items but found " .. countAfter, nil
    end

    syncAddToClient(player, itemType, count)

    local verificationData = {
        count_before = countBefore,
        count_after = countAfter,
        verified = true,
    }

    return true, nil, verificationData
end

--- Remove a single item from the player, handling equipped/worn items.
--- Uses full-type matching + nested bag scan (getFirstTypeRecurse only matches short types).
removeOneItem = function(player, itemType)
    local inventory = player:getInventory()
    if not inventory then
        return false
    end

    local item = nil
    for _, container in ipairs(collectContainers(player)) do
        item = findItemInContainer(container, itemType)
        if item then
            break
        end
    end

    -- Last resort: recurse from main inventory with short type name
    if not item and inventory.getFirstTypeRecurse then
        item = inventory:getFirstTypeRecurse(shortTypeName(itemType))
        if not item then
            item = inventory:getFirstTypeRecurse(itemType)
        end
    end

    if not item then
        return false
    end

    -- Unequip if the item is worn or held — otherwise the client
    -- keeps showing it in the equipment slot even after container removal.
    if player:isEquipped(item) then
        player:removeWornItem(item)
    end
    if player:getPrimaryHandItem() == item then
        player:setPrimaryHandItem(nil)
    end
    if player:getSecondaryHandItem() == item then
        player:setSecondaryHandItem(nil)
    end

    local container = item:getContainer()
    if container and container.DoRemoveItem then
        container:DoRemoveItem(item)
    elseif container and container.Remove then
        container:Remove(item)
    elseif inventory.DoRemoveItem then
        inventory:DoRemoveItem(item)
    else
        inventory:Remove(item)
    end

    return true
end

--- Remove one matching item and return its identity, or nil if none found.
local function removeOneItemDetailed(player, itemType)
    local inventory = player:getInventory()
    if not inventory then
        return nil
    end

    local item = nil
    for _, container in ipairs(collectContainers(player)) do
        item = findItemInContainer(container, itemType)
        if item then
            break
        end
    end

    if not item and inventory.getFirstTypeRecurse then
        item = inventory:getFirstTypeRecurse(shortTypeName(itemType))
        if not item then
            item = inventory:getFirstTypeRecurse(itemType)
        end
    end

    if not item then
        return nil
    end

    -- Capture identity BEFORE removal; the object is unusable afterwards.
    local detail = {
        full_type = item:getFullType(),
        name = item:getName(),
        category = tostring(item:getDisplayCategory() or "General"),
        condition = 1.0,
    }
    if item.getCondition and item.getMaxCondition then
        local maxCond = item:getMaxCondition()
        if maxCond > 0 then
            detail.condition = math.floor((item:getCondition() / maxCond) * 100) / 100
        end
    end

    if player:isEquipped(item) then
        player:removeWornItem(item)
    end
    if player:getPrimaryHandItem() == item then
        player:setPrimaryHandItem(nil)
    end
    if player:getSecondaryHandItem() == item then
        player:setSecondaryHandItem(nil)
    end

    local container = item:getContainer()
    if container and container.DoRemoveItem then
        container:DoRemoveItem(item)
    elseif container and container.Remove then
        container:Remove(item)
    elseif inventory.DoRemoveItem then
        inventory:DoRemoveItem(item)
    else
        inventory:Remove(item)
    end

    return detail
end

--- Remove up to `count` items, reporting exactly what came out.
--- Always succeeds; the caller decides what a partial removal means.
local function removeItemVerified(player, itemType, count)
    count = count or 1
    local removed = {}

    for _ = 1, count do
        local detail = removeOneItemDetailed(player, itemType)
        if not detail then
            break
        end
        table.insert(removed, detail)
    end

    if isServer() and #removed > 0 then
        sendServerCommand(player, "KnoxRelay", "removeItem", {
            item_type = itemType,
            count = tostring(#removed),
        })
        syncRemoveToClient(player)
    end

    return true, nil, {removed = removed, removed_count = #removed}
end

--- Give items and restore a specific condition fraction (0..1) on each.
local function giveItemWithCondition(player, itemType, count, condition)
    local inventory = player:getInventory()
    if not inventory then
        return false, "player has no inventory", nil
    end

    condition = tonumber(condition) or 1.0
    if condition < 0 then condition = 0 end
    if condition > 1 then condition = 1 end

    local countBefore = countItemType(player, itemType)
    local addedCount = 0

    for i = 1, count do
        local item = inventory:AddItem(itemType)
        if not item then
            -- Roll back whatever landed so the caller can retry cleanly.
            for _ = 1, addedCount do
                removeOneItem(player, itemType)
            end
            return false, "failed to add item " .. itemType .. " (attempt " .. i .. "/" .. count .. ")", nil
        end
        if item.setCondition and item.getMaxCondition then
            local maxCond = item:getMaxCondition()
            if maxCond and maxCond > 0 then
                item:setCondition(math.max(1, math.floor(condition * maxCond)))
            end
        end
        addedCount = addedCount + 1
    end

    local countAfter = countItemType(player, itemType)
    if countAfter < countBefore + count then
        for _ = 1, (countAfter - countBefore) do
            removeOneItem(player, itemType)
        end
        return false, "verification failed: expected >=" .. (countBefore + count) .. " but found " .. countAfter, nil
    end

    syncAddToClient(player, itemType, count)

    return true, nil, {count_before = countBefore, count_after = countAfter, verified = true}
end

--- Remove item from player
local function removeItem(player, itemType, count)
    local inventory = player:getInventory()
    if not inventory then
        return false, "player has no inventory"
    end

    count = count or 1
    local available = countItemType(player, itemType)
    if available < 1 then
        return false, "item not found: " .. tostring(itemType)
            .. " (have 0; check full type e.g. Base.WaterBottleFull vs Base.WaterBottle)"
    end

    local removed = 0
    for _ = 1, count do
        if removeOneItem(player, itemType) then
            removed = removed + 1
        else
            break
        end
    end

    if removed < count then
        return false, "only removed " .. removed .. "/" .. count .. " items (found "
            .. available .. " matching " .. tostring(itemType) .. " before remove)"
    end

    -- Tell the client to mirror the removal for instant UI update.
    if isServer() and removed > 0 then
        sendServerCommand(player, "KnoxRelay", "removeItem", {
            item_type = itemType,
            count = tostring(removed),
        })
        syncRemoveToClient(player)
    end

    return true, nil
end

--- Process all pending entries in the delivery queue
function ZM_DeliveryQueue.process()
    local queue = ZM_Utils.readJsonFile(QUEUE_FILE)
    if not queue or not queue.entries then
        return 0
    end

    -- Early exit: check if any entries are pending before reading results
    local hasPending = false
    for _, entry in ipairs(queue.entries) do
        if entry.status == "pending" then
            hasPending = true
            break
        end
    end
    if not hasPending then
        return 0
    end

    local results = readResults()
    local processed = 0

    -- Build set of already-processed IDs
    local processedIds = {}
    if results.results then
        for _, r in ipairs(results.results) do
            processedIds[r.id] = true
        end
    end

    for _, entry in ipairs(queue.entries) do
        if entry.status == "pending" and not processedIds[entry.id] then
            local player = findPlayer(entry.username)
            local result = {
                id = entry.id,
                status = "failed",
                processed_at = ZM_Utils.getTimestamp(),
                message = nil,
            }

            if not player then
                result.message = "player '" .. entry.username .. "' not online"
            else
                local success, errMsg, verificationData
                if entry.action == "give" then
                    success, errMsg = giveItem(player, entry.item_type, entry.count or 1)
                elseif entry.action == "give_verified" then
                    success, errMsg, verificationData = giveItemVerified(player, entry.item_type, entry.count or 1)
                elseif entry.action == "remove" then
                    success, errMsg = removeItem(player, entry.item_type, entry.count or 1)
                elseif entry.action == "remove_verified" then
                    success, errMsg, verificationData = removeItemVerified(player, entry.item_type, entry.count or 1)
                elseif entry.action == "give_with_condition" then
                    success, errMsg, verificationData = giveItemWithCondition(player, entry.item_type, entry.count or 1, entry.condition or 1.0)
                else
                    errMsg = "unknown action: " .. tostring(entry.action)
                end

                if success then
                    result.status = "delivered"
                    print("[KnoxRelay] Delivered: " .. entry.action .. " " .. (entry.count or 1) .. "x " .. entry.item_type .. " for " .. entry.username)
                    -- Include verification data if present
                    if verificationData then
                        result.verified = true
                        result.count_before = verificationData.count_before
                        result.count_after = verificationData.count_after
                        result.removed = verificationData.removed
                        result.removed_count = verificationData.removed_count
                    end
                    -- Re-export inventory so the web reflects the change immediately
                    ZM_InventoryExporter.exportPlayer(player)
                else
                    result.message = errMsg
                    print("[KnoxRelay] Failed delivery: " .. tostring(errMsg))
                end
            end

            table.insert(results.results, result)
            processed = processed + 1
        end
    end

    if processed > 0 then
        writeResults(results)
    end

    return processed
end

return ZM_DeliveryQueue
