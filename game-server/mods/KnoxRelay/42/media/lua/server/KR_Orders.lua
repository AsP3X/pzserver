--
-- KR_Orders.lua — the item delivery queue.
--
-- Laravel writes delivery_queue.json; this module carries out each pending
-- entry and reports back through delivery_results.json. Entries are keyed by
-- id and every id that has a result is skipped, so a queue file that is read
-- twice never delivers twice.
--
-- Supported actions:
--   give                 add items, no proof required
--   give_verified        count before and after, roll back if the count is short
--   remove               take items away, fail loudly if not all of them went
--   remove_verified      take what is there and report exactly what came out
--   give_with_condition  add items and restore a given wear fraction on each
--
-- The verified variants exist because the shop debits a wallet only after the
-- goods are confirmed delivered. A silent partial add would charge a player
-- for items they never received.
--

local Bridge = require("KR_Bridge")
local Roster = require("KR_Roster")
local Stash = require("KR_Stash")
local Snapshot = require("KR_Snapshot")

KR_Orders = {}

local LOG = "[KnoxRelay] "
local QUEUE = "delivery_queue.json"
local RESULTS = "delivery_results.json"
local RESULT_LIMIT = 200

--------------------------------------------------------------------------
-- Result ledger
--------------------------------------------------------------------------

local function loadLedger()
    return Bridge.readJson(RESULTS) or { version = 1, updated_at = "", results = {} }
end

local function saveLedger(ledger)
    ledger.updated_at = Bridge.wallStamp()

    while ledger.results and #ledger.results > RESULT_LIMIT do
        table.remove(ledger.results, 1)
    end

    Bridge.writeJson(RESULTS, ledger)
end

--------------------------------------------------------------------------
-- Client mirroring
--
-- Server-side container edits are not replicated to clients by the engine.
-- Marking the inventory dirty refreshes the local UI, and the paired command
-- tells the client to make the same edit so the change shows up immediately.
--------------------------------------------------------------------------

local function markDirty(player)
    local inventory = player:getInventory()
    if inventory then
        inventory:setDirty(true)
        inventory:setDrawDirty(true)
    end
end

local function mirrorAdd(player, itemType, count)
    markDirty(player)

    if isServer() then
        sendServerCommand(player, "KnoxRelay", "addItem", {
            item_type = itemType,
            count = tostring(count),
        })
    end
end

--------------------------------------------------------------------------
-- Item primitives
--------------------------------------------------------------------------

--- Take one item of `itemType` off the player. Returns true if one went.
local function takeOne(player, itemType)
    local inventory = player:getInventory()
    if not inventory then
        return false
    end

    local item = Stash.locate(player, itemType)
    if not item then
        return false
    end

    Stash.unequip(player, item)
    Stash.detach(player, item)

    return true
end

--- Take one item and describe what it was. The item object is unusable once
--- detached, so its identity is captured first.
local function takeOneDescribed(player, itemType)
    local inventory = player:getInventory()
    if not inventory then
        return nil
    end

    local item = Stash.locate(player, itemType)
    if not item then
        return nil
    end

    local record = {
        full_type = item:getFullType(),
        name = item:getName(),
        category = tostring(item:getDisplayCategory() or "General"),
        condition = Stash.wear(item),
    }

    Stash.unequip(player, item)
    Stash.detach(player, item)

    return record
end

--------------------------------------------------------------------------
-- Actions
--------------------------------------------------------------------------

local function actionGive(player, itemType, count)
    local inventory = player:getInventory()
    if not inventory then
        return false, "player has no inventory"
    end

    for attempt = 1, count do
        if not inventory:AddItem(itemType) then
            return false, "failed to add item " .. itemType .. " (attempt " .. attempt .. "/" .. count .. ")"
        end
    end

    mirrorAdd(player, itemType, count)

    return true, nil
end

local function actionGiveVerified(player, itemType, count)
    local inventory = player:getInventory()
    if not inventory then
        return false, "player has no inventory", nil
    end

    local before = Stash.count(player, itemType)

    for attempt = 1, count do
        if not inventory:AddItem(itemType) then
            -- Undo whatever did land so the caller sees a clean failure.
            local landed = Stash.count(player, itemType) - before
            for _ = 1, landed do
                takeOne(player, itemType)
            end

            return false, "failed to add item " .. itemType .. " (attempt " .. attempt .. "/" .. count .. ")", nil
        end
    end

    local after = Stash.count(player, itemType)

    if after < before + count then
        print(LOG .. "WARNING: give_verified failed verification for " .. itemType
            .. " — expected >=" .. (before + count) .. " but got " .. after)
        for _ = 1, (after - before) do
            takeOne(player, itemType)
        end

        return false, "verification failed: expected >=" .. (before + count) .. " items but found " .. after, nil
    end

    mirrorAdd(player, itemType, count)

    return true, nil, { count_before = before, count_after = after, verified = true }
end

--- Add items and restore a wear fraction (0..1) on each one.
local function actionGiveWithCondition(player, itemType, count, fraction)
    local inventory = player:getInventory()
    if not inventory then
        return false, "player has no inventory", nil
    end

    fraction = tonumber(fraction) or 1.0
    if fraction < 0 then
        fraction = 0
    end
    if fraction > 1 then
        fraction = 1
    end

    local before = Stash.count(player, itemType)
    local landed = 0

    for attempt = 1, count do
        local item = inventory:AddItem(itemType)
        if not item then
            for _ = 1, landed do
                takeOne(player, itemType)
            end

            return false, "failed to add item " .. itemType .. " (attempt " .. attempt .. "/" .. count .. ")", nil
        end

        if item.setCondition and item.getMaxCondition then
            local ceiling = item:getMaxCondition()
            if ceiling and ceiling > 0 then
                item:setCondition(math.max(1, math.floor(fraction * ceiling)))
            end
        end

        landed = landed + 1
    end

    local after = Stash.count(player, itemType)

    if after < before + count then
        for _ = 1, (after - before) do
            takeOne(player, itemType)
        end

        return false, "verification failed: expected >=" .. (before + count) .. " but found " .. after, nil
    end

    mirrorAdd(player, itemType, count)

    return true, nil, { count_before = before, count_after = after, verified = true }
end

local function actionRemove(player, itemType, count)
    local inventory = player:getInventory()
    if not inventory then
        return false, "player has no inventory"
    end

    count = count or 1
    local available = Stash.count(player, itemType)

    if available < 1 then
        return false, "item not found: " .. tostring(itemType)
            .. " (have 0; check full type e.g. Base.WaterBottleFull vs Base.WaterBottle)"
    end

    local taken = 0
    for _ = 1, count do
        if not takeOne(player, itemType) then
            break
        end
        taken = taken + 1
    end

    if taken < count then
        return false, "only removed " .. taken .. "/" .. count .. " items (found "
            .. available .. " matching " .. tostring(itemType) .. " before remove)"
    end

    if isServer() and taken > 0 then
        sendServerCommand(player, "KnoxRelay", "removeItem", {
            item_type = itemType,
            count = tostring(taken),
        })
        markDirty(player)
    end

    return true, nil
end

--- Take up to `count` items and report exactly what came out. Never fails:
--- a partial removal is a valid answer that the caller interprets.
local function actionRemoveVerified(player, itemType, count)
    count = count or 1
    local taken = {}

    for _ = 1, count do
        local record = takeOneDescribed(player, itemType)
        if not record then
            break
        end
        taken[#taken + 1] = record
    end

    if isServer() and #taken > 0 then
        sendServerCommand(player, "KnoxRelay", "removeItem", {
            item_type = itemType,
            count = tostring(#taken),
        })
        markDirty(player)
    end

    return true, nil, { removed = taken, removed_count = #taken }
end

local function perform(entry, player)
    local count = entry.count or 1

    if entry.action == "give" then
        return actionGive(player, entry.item_type, count)
    end
    if entry.action == "give_verified" then
        return actionGiveVerified(player, entry.item_type, count)
    end
    if entry.action == "remove" then
        return actionRemove(player, entry.item_type, count)
    end
    if entry.action == "remove_verified" then
        return actionRemoveVerified(player, entry.item_type, count)
    end
    if entry.action == "give_with_condition" then
        return actionGiveWithCondition(player, entry.item_type, count, entry.condition or 1.0)
    end

    return false, "unknown action: " .. tostring(entry.action)
end

--------------------------------------------------------------------------
-- Queue drain
--------------------------------------------------------------------------

--- Work through every pending entry. Returns how many produced a result.
function KR_Orders.drain()
    local queue = Bridge.readJson(QUEUE)
    if not queue or not queue.entries then
        return 0
    end

    local waiting = false
    for _, entry in ipairs(queue.entries) do
        if entry.status == "pending" then
            waiting = true
            break
        end
    end
    if not waiting then
        return 0
    end

    local ledger = loadLedger()
    local done = {}
    if ledger.results then
        for _, result in ipairs(ledger.results) do
            done[result.id] = true
        end
    end

    local handled = 0

    for _, entry in ipairs(queue.entries) do
        if entry.status == "pending" and not done[entry.id] then
            local player = Roster.find(entry.username)
            local result = {
                id = entry.id,
                status = "failed",
                processed_at = Bridge.wallStamp(),
                message = nil,
            }

            if not player then
                result.message = "player '" .. entry.username .. "' not online"
            else
                local ok, failure, proof = perform(entry, player)

                if ok then
                    result.status = "delivered"
                    print(LOG .. "Delivered: " .. entry.action .. " " .. (entry.count or 1)
                        .. "x " .. entry.item_type .. " for " .. entry.username)

                    if proof then
                        result.verified = true
                        result.count_before = proof.count_before
                        result.count_after = proof.count_after
                        result.removed = proof.removed
                        result.removed_count = proof.removed_count
                    end

                    -- Refresh the snapshot so the dashboard reflects the change.
                    Snapshot.capture(player)
                else
                    result.message = failure
                    print(LOG .. "Failed delivery: " .. tostring(failure))
                end
            end

            ledger.results[#ledger.results + 1] = result
            handled = handled + 1
        end
    end

    if handled > 0 then
        saveLedger(ledger)
    end

    return handled
end

return KR_Orders
