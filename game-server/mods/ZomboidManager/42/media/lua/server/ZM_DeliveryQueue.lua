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

--- Count items of a specific type across inventory + backpack
local function countItemType(player, itemType)
    local total = 0
    local inventory = player:getInventory()
    if inventory then
        local items = inventory:getItemsFromFullType(itemType)
        if items then
            total = total + items:size()
        end
    end

    local backpack = player:getClothingItem_Back()
    if backpack and backpack:getItemContainer() then
        local items = backpack:getItemContainer():getItemsFromFullType(itemType)
        if items then
            total = total + items:size()
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
        sendServerCommand(player, "ZomboidManager", "addItem", {
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
                    local toRemove = inventory:getFirstTypeRecurse(itemType)
                    if toRemove then
                        local container = toRemove:getContainer()
                        if container then
                            container:DoRemoveItem(toRemove)
                        else
                            inventory:DoRemoveItem(toRemove)
                        end
                    end
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
        print("[ZomboidManager] WARNING: give_verified failed verification for " .. itemType ..
              " — expected >=" .. (countBefore + count) .. " but got " .. countAfter)
        -- Remove what was added
        for j = 1, actuallyAdded do
            local toRemove = inventory:getFirstTypeRecurse(itemType)
            if toRemove then
                local container = toRemove:getContainer()
                if container then
                    container:DoRemoveItem(toRemove)
                else
                    inventory:DoRemoveItem(toRemove)
                end
            end
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
local function removeOneItem(player, inventory, itemType)
    local item = inventory:getFirstTypeRecurse(itemType)
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
    if container then
        container:DoRemoveItem(item)
    else
        inventory:DoRemoveItem(item)
    end

    return true
end

--- Remove item from player
local function removeItem(player, itemType, count)
    local inventory = player:getInventory()
    if not inventory then
        return false, "player has no inventory"
    end

    local removed = 0
    for i = 1, count do
        if removeOneItem(player, inventory, itemType) then
            removed = removed + 1
        end
    end

    if removed < count then
        return false, "only removed " .. removed .. "/" .. count .. " items"
    end

    -- Tell the client to mirror the removal for instant UI update.
    if isServer() and removed > 0 then
        sendServerCommand(player, "ZomboidManager", "removeItem", {
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
                else
                    errMsg = "unknown action: " .. tostring(entry.action)
                end

                if success then
                    result.status = "delivered"
                    print("[ZomboidManager] Delivered: " .. entry.action .. " " .. (entry.count or 1) .. "x " .. entry.item_type .. " for " .. entry.username)
                    -- Include verification data if present
                    if verificationData then
                        result.verified = true
                        result.count_before = verificationData.count_before
                        result.count_after = verificationData.count_after
                    end
                    -- Re-export inventory so the web reflects the change immediately
                    ZM_InventoryExporter.exportPlayer(player)
                else
                    result.message = errMsg
                    print("[ZomboidManager] Failed delivery: " .. tostring(errMsg))
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
