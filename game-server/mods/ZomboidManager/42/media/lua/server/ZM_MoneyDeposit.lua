--
-- ZM_MoneyDeposit.lua — Reads deposit_requests.json, removes Base.Money/MoneyBundle
-- from player inventories, writes deposit_results.json
--
-- Safety: money is only considered deposited if deposit_results.json was written.
-- If the result write fails after removal, items are restored so the player is not
-- charged without a wallet credit (PHP polls results for up to ~120s).
--

require("ZM_Utils")
require("ZM_InventoryExporter")

ZM_MoneyDeposit = {}

local REQUESTS_FILE = "deposit_requests.json"
local RESULTS_FILE = "deposit_results.json"
local MAX_RESULTS = 200

--- Read existing results file
local function readResults()
    local data = ZM_Utils.readJsonFile(RESULTS_FILE)
    if data then
        return data
    end
    return {version = 1, updated_at = "", results = {}}
end

--- Write results to file, trimming oldest entries if over cap.
--- @return boolean
local function writeResults(results)
    results.updated_at = ZM_Utils.getTimestamp()

    while results.results and #results.results > MAX_RESULTS do
        table.remove(results.results, 1)
    end

    return ZM_Utils.writeJsonFile(RESULTS_FILE, results)
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

--- Count money items in a container (without removing)
local function countMoneyInContainer(container)
    local money = 0
    local bundles = 0
    if not container then
        return money, bundles
    end
    local allItems = container:getItems()
    if not allItems then
        return money, bundles
    end
    for i = 0, allItems:size() - 1 do
        local item = allItems:get(i)
        if item then
            local fullType = item:getFullType()
            if fullType == "Base.Money" then
                money = money + 1
            elseif fullType == "Base.MoneyBundle" then
                bundles = bundles + 1
            end
        end
    end
    return money, bundles
end

--- Count total money items across all player containers
local function countAllMoney(player)
    local totalMoney = 0
    local totalBundles = 0

    local inventory = player:getInventory()
    local m, b = countMoneyInContainer(inventory)
    totalMoney = totalMoney + m
    totalBundles = totalBundles + b

    local backpack = player:getClothingItem_Back()
    if backpack and backpack:getItemContainer() then
        m, b = countMoneyInContainer(backpack:getItemContainer())
        totalMoney = totalMoney + m
        totalBundles = totalBundles + b
    end

    return totalMoney, totalBundles
end

--- Remove all items of a given type from a container using getFirstType loop.
--- Returns number actually removed.
local function removeAllOfType(container, fullType)
    if not container then
        return 0
    end
    local removed = 0
    while true do
        local item = container:getFirstType(fullType)
        if not item then
            break
        end
        if container.DoRemoveItem then
            container:DoRemoveItem(item)
        else
            container:Remove(item)
        end
        removed = removed + 1
        if removed > 10000 then
            print("[ZomboidManager] WARNING: hit safety limit removing " .. fullType)
            break
        end
    end
    return removed
end

--- Remove all Money and MoneyBundle items from a player.
--- Returns money_removed, bundles_removed
local function removeMoney(player)
    local moneyRemoved = 0
    local bundlesRemoved = 0

    local inventory = player:getInventory()
    moneyRemoved = moneyRemoved + removeAllOfType(inventory, "Base.Money")
    bundlesRemoved = bundlesRemoved + removeAllOfType(inventory, "Base.MoneyBundle")

    local backpack = player:getClothingItem_Back()
    if backpack and backpack:getItemContainer() then
        local bagContainer = backpack:getItemContainer()
        moneyRemoved = moneyRemoved + removeAllOfType(bagContainer, "Base.Money")
        bundlesRemoved = bundlesRemoved + removeAllOfType(bagContainer, "Base.MoneyBundle")
    end

    if isServer() then
        if moneyRemoved > 0 then
            sendServerCommand(player, "ZomboidManager", "removeItem", {
                item_type = "Base.Money",
                count = tostring(moneyRemoved),
            })
        end
        if bundlesRemoved > 0 then
            sendServerCommand(player, "ZomboidManager", "removeItem", {
                item_type = "Base.MoneyBundle",
                count = tostring(bundlesRemoved),
            })
        end
    end

    return moneyRemoved, bundlesRemoved
end

--- Restore money items to player inventory (used when result write fails after removal).
local function restoreMoney(player, moneyCount, bundleCount)
    if not player then
        return
    end
    local inventory = player:getInventory()
    if not inventory then
        return
    end

    moneyCount = moneyCount or 0
    bundleCount = bundleCount or 0

    for _ = 1, moneyCount do
        inventory:AddItem("Base.Money")
    end
    for _ = 1, bundleCount do
        inventory:AddItem("Base.MoneyBundle")
    end

    if isServer() then
        if moneyCount > 0 then
            sendServerCommand(player, "ZomboidManager", "addItem", {
                item_type = "Base.Money",
                count = tostring(moneyCount),
            })
        end
        if bundleCount > 0 then
            sendServerCommand(player, "ZomboidManager", "addItem", {
                item_type = "Base.MoneyBundle",
                count = tostring(bundleCount),
            })
        end
    end

    print("[ZomboidManager] Restored " .. moneyCount .. " Money + " .. bundleCount
        .. " MoneyBundle to " .. (player:getUsername() or "?")
        .. " after failed deposit_results write")
end

--- Append one result and flush to disk. Returns true if persisted.
local function appendAndWriteResult(results, result)
    table.insert(results.results, result)
    if writeResults(results) then
        return true
    end
    -- Roll back in-memory append so a later successful write does not re-credit a failed persist
    table.remove(results.results, #results.results)
    return false
end

--- Process all pending deposit requests
function ZM_MoneyDeposit.process()
    local requests = ZM_Utils.readJsonFile(REQUESTS_FILE)
    if not requests or not requests.requests then
        return 0
    end

    local hasPending = false
    for _, req in ipairs(requests.requests) do
        if req.status == "pending" then
            hasPending = true
            break
        end
    end
    if not hasPending then
        return 0
    end

    local results = readResults()
    local processed = 0

    local processedIds = {}
    if results.results then
        for _, r in ipairs(results.results) do
            processedIds[r.id] = true
        end
    end

    for _, req in ipairs(requests.requests) do
        if req.status == "pending" and not processedIds[req.id] then
            local result = {
                id = req.id,
                username = req.username,
                status = "failed",
                money_count = 0,
                stack_count = 0,
                bundle_count = 0,
                total_coins = 0,
                message = nil,
                processed_at = ZM_Utils.getTimestamp(),
            }

            local player = findPlayer(req.username)
            local moneyRemoved = 0
            local bundlesRemoved = 0
            local didRemove = false

            if not player then
                result.message = "player not online"
            else
                local moneyBefore, bundlesBefore = countAllMoney(player)

                if moneyBefore == 0 and bundlesBefore == 0 then
                    result.message = "no money items found"
                else
                    moneyRemoved, bundlesRemoved = removeMoney(player)
                    didRemove = (moneyRemoved > 0 or bundlesRemoved > 0)

                    local moneyAfter, bundlesAfter = countAllMoney(player)

                    if moneyAfter > 0 or bundlesAfter > 0 then
                        result.message = "removal failed: " .. moneyAfter .. " Money, " .. bundlesAfter
                            .. " MoneyBundle still in inventory"
                        print("[ZomboidManager] WARNING: Money deposit removal incomplete for "
                            .. req.username .. " — " .. moneyAfter .. " Money + " .. bundlesAfter
                            .. " MoneyBundle remaining")
                        -- Leave remaining items; do not credit partial removals
                        if didRemove then
                            -- Put back what we already took so inventory is consistent
                            restoreMoney(player, moneyRemoved, bundlesRemoved)
                            didRemove = false
                            moneyRemoved = 0
                            bundlesRemoved = 0
                        end
                    else
                        local moneyValue = 1
                        local bundleValue = 100
                        local totalCoins = (moneyRemoved * moneyValue) + (bundlesRemoved * bundleValue)

                        result.status = "success"
                        result.money_count = moneyRemoved
                        result.bundle_count = bundlesRemoved
                        result.total_coins = totalCoins

                        print("[ZomboidManager] Money deposit: " .. req.username .. " deposited "
                            .. moneyRemoved .. " Money + " .. bundlesRemoved
                            .. " MoneyBundle = " .. totalCoins .. " coins")
                    end
                end
            end

            local written = appendAndWriteResult(results, result)
            if not written then
                print("[ZomboidManager] CRITICAL: deposit result not written for "
                    .. tostring(req.username) .. " id=" .. tostring(req.id)
                    .. " — will retry next cycle; restoring items if any were removed")
                if didRemove and player then
                    restoreMoney(player, moneyRemoved, bundlesRemoved)
                    -- Re-export so web inventory matches after restore
                    ZM_InventoryExporter.exportPlayer(player)
                end
                -- Do not mark processed; leave request pending for retry
            else
                processed = processed + 1
                processedIds[req.id] = true
                if player then
                    ZM_InventoryExporter.exportPlayer(player)
                end
            end
        end
    end

    return processed
end

--- Initialize the money deposit system
function ZM_MoneyDeposit.init()
    print("[ZomboidManager] Money deposit system initialized")
end

return ZM_MoneyDeposit
