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
--   give_kit             add a bag and put its recorded cargo back inside it
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
local function describeHeld(item)
    if not item then
        return nil
    end

    local record = {
        full_type = item:getFullType(),
        name = item:getName(),
        category = tostring(item:getDisplayCategory() or "General"),
        condition = Stash.wear(item),
        count = 1,
    }

    if item.getItemContainer then
        local box = item:getItemContainer()
        local contents = box and box.getItems and box:getItems()
        if contents and contents:size() > 0 then
            local cargo = {}
            for index = 0, contents:size() - 1 do
                local nested = describeHeld(contents:get(index))
                if nested then
                    cargo[#cargo + 1] = nested
                end
            end
            if #cargo > 0 then
                record.cargo = cargo
            end
        end
    end

    return record
end

local function takeOneDescribed(player, itemType)
    local inventory = player:getInventory()
    if not inventory then
        return nil
    end

    local item = Stash.locate(player, itemType)
    if not item then
        return nil
    end

    local record = describeHeld(item)

    Stash.unequip(player, item)
    Stash.detach(player, item)

    return record
end

local function spawnOne(container, itemType)
    if not container or not itemType then
        return nil
    end

    local item = container:AddItem(itemType)
    if item then
        Stash.primeSpawned(item)
    end

    return item
end

local function wearOn(item, fraction)
    if not item or not item.setCondition or not item.getConditionMax then
        return
    end

    fraction = tonumber(fraction) or 1.0
    if fraction < 0 then
        fraction = 0
    end
    if fraction > 1 then
        fraction = 1
    end

    local ceiling = item:getConditionMax()
    if ceiling and ceiling > 0 then
        item:setCondition(math.max(1, math.floor(fraction * ceiling)))
    end
end

local function fillContainer(container, cargo)
    if not container or not cargo then
        return true
    end

    for _, piece in ipairs(cargo) do
        local itemType = piece.item_type or piece.full_type
        local count = tonumber(piece.quantity or piece.count) or 1
        if itemType then
            for _ = 1, count do
                local item = spawnOne(container, itemType)
                if not item then
                    return false
                end
                local condition = piece.condition
                if piece.condition_bp ~= nil then
                    condition = (tonumber(piece.condition_bp) or 100) / 100
                end
                wearOn(item, condition)
                if piece.cargo and item.getItemContainer then
                    if not fillContainer(item:getItemContainer(), piece.cargo) then
                        return false
                    end
                end
            end
        end
    end

    return true
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
        if not spawnOne(inventory, itemType) then
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
        if not spawnOne(inventory, itemType) then
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
        local item = spawnOne(inventory, itemType)
        if not item then
            for _ = 1, landed do
                takeOne(player, itemType)
            end

            return false, "failed to add item " .. itemType .. " (attempt " .. attempt .. "/" .. count .. ")", nil
        end

        if item.setCondition and item.getConditionMax then
            local ceiling = item:getConditionMax()
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

local function flattenCargo(cargo, into)
    if not cargo then
        return
    end

    for _, piece in ipairs(cargo) do
        local itemType = piece.item_type or piece.full_type
        local count = tonumber(piece.quantity or piece.count) or 1
        if itemType then
            into[itemType] = (into[itemType] or 0) + count
        end
        if piece.cargo then
            flattenCargo(piece.cargo, into)
        end
    end
end

local function actionGiveKit(player, itemType, fraction, cargo)
    local inventory = player:getInventory()
    if not inventory then
        return false, "player has no inventory", nil
    end

    -- Dump the bag and its cargo into the main pack so every client (including
    -- a Steam copy without fillBag) can see the items. The vault still stored
    -- the packed bag as one slot.
    local bag = spawnOne(inventory, itemType)
    if not bag then
        return false, "failed to add container " .. tostring(itemType), nil
    end

    wearOn(bag, fraction)

    local counts = {}
    flattenCargo(cargo, counts)
    for nestedType, nestedCount in pairs(counts) do
        for _ = 1, nestedCount do
            if not spawnOne(inventory, nestedType) then
                return false, "failed to restore " .. tostring(nestedType), nil
            end
        end
    end

    markDirty(player)
    mirrorAdd(player, itemType, 1)
    for nestedType, nestedCount in pairs(counts) do
        mirrorAdd(player, nestedType, nestedCount)
    end

    return true, nil, { verified = true }
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
    if entry.action == "give_kit" then
        return actionGiveKit(player, entry.item_type, entry.condition or 1.0, entry.cargo)
    end

    return false, "unknown action: " .. tostring(entry.action)
end

--------------------------------------------------------------------------
-- Join settle
--
-- Offline listings only reserve against a snapshot. The item is still in
-- the pack until this runs. If the player can drop it first, the take fails
-- or they keep a copy on the ground. Lock the reserved types, tell the
-- client to refuse drop/transfer, then drain before they get a chance.
--------------------------------------------------------------------------

local function pendingFor(username)
    local queue = Bridge.readJson(QUEUE)
    if not queue or not queue.entries then
        return {}
    end

    local ledger = loadLedger()
    local done = {}
    if ledger.results then
        for _, result in ipairs(ledger.results) do
            done[result.id] = true
        end
    end

    local pending = {}
    for _, entry in ipairs(queue.entries) do
        if entry.status == "pending" and not done[entry.id]
            and Roster.sameName(entry.username, username) then
            pending[#pending + 1] = entry
        end
    end

    return pending
end

function KR_Orders.hasPending(username)
    return #pendingFor(username) > 0
end

local function tell(player, command, args)
    if isServer() then
        sendServerCommand(player, "KnoxRelay", command, args or {})
    end
end

--- Favorite / pin reserved copies so they cannot be dropped, and tell the
--- client to refuse any move of those types until drain finishes.
function KR_Orders.lockReserved(player)
    local username = player:getUsername()
    if not username then
        return {}
    end

    local types = {}
    local seen = {}

    for _, entry in ipairs(pendingFor(username)) do
        local action = entry.action or ""
        if action == "remove" or action == "remove_verified" then
            local itemType = entry.item_type
            local need = tonumber(entry.count) or 1
            if itemType and not seen[itemType] then
                seen[itemType] = true
                types[#types + 1] = itemType
            end

            for _ = 1, need do
                local item = Stash.locateMatching(player, itemType, false)
                if not item then
                    break
                end
                Stash.markHeld(item, true)
            end
        end
    end

    if #types > 0 then
        tell(player, "holdItems", { types = types })
    end

    return types
end

--- Pin reserved copies on everyone who has a pending take, drain the
--- whole queue, then release leftover pins. Drain is global, so every
--- online player with a take must be locked before it runs.
function KR_Orders.settleOnline()
    local players = Roster.online()
    if not players then
        return 0
    end

    local any = false
    for _, player in ipairs(players) do
        local username = player.getUsername and player:getUsername()
        if username and KR_Orders.hasPending(username) then
            KR_Orders.lockReserved(player)
            any = true
        end
    end

    if not any then
        return 0
    end

    local handled = KR_Orders.drain()

    for _, player in ipairs(players) do
        Stash.unlockHeld(player)
        tell(player, "clearHolds", {})
    end

    return handled
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
