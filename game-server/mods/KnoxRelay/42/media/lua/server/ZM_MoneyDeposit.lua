--
-- ZM_MoneyDeposit.lua — Reads deposit_requests.json, removes Base.Money/MoneyBundle
-- from player inventories, writes deposit_results.json
--
-- Safety: money is only considered deposited if deposit_results.json was written.
-- If the result write fails after removal, items are restored so the player is not
-- charged without a wallet credit (PHP polls results for up to ~120s).
--
-- Counts/removes recursively in nested bags (not just main inv + backpack).
-- Coin rates from money_deposit_config.json when present (Admin → Lua Bridge).
--

require("ZM_Utils")
require("ZM_InventoryExporter")

ZM_MoneyDeposit = {}

local REQUESTS_FILE = "deposit_requests.json"
local RESULTS_FILE = "deposit_results.json"
local RATES_FILE = "money_deposit_config.json"
local MAX_RESULTS = 200

local function loadRates()
    local moneyValue = 1
    local bundleValue = 100
    local data = ZM_Utils.readJsonFile(RATES_FILE)
    if data then
        if data.money_value ~= nil then
            moneyValue = tonumber(data.money_value) or moneyValue
        end
        if data.bundle_value ~= nil then
            bundleValue = tonumber(data.bundle_value) or bundleValue
        elseif data.stack_value ~= nil then
            bundleValue = tonumber(data.stack_value) or bundleValue
        end
    end
    return moneyValue, bundleValue
end

local function readResults()
    local data = ZM_Utils.readJsonFile(RESULTS_FILE)
    if data then
        return data
    end
    return {version = 1, updated_at = "", results = {}}
end

local function writeResults(results)
    results.updated_at = ZM_Utils.getTimestamp()
    while results.results and #results.results > MAX_RESULTS do
        table.remove(results.results, 1)
    end
    return ZM_Utils.writeJsonFile(RESULTS_FILE, results)
end

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

--- Walk all item containers reachable from the player (inventory + nested bags).
local function collectContainers(player)
    local containers = {}
    local seen = {}

    local function addContainer(container)
        if not container then
            return
        end
        -- identity via tostring of userdata
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

    -- Worn clothing bags / fanny packs etc.
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

local function countAllMoney(player)
    local totalMoney = 0
    local totalBundles = 0
    local containers = collectContainers(player)
    for _, container in ipairs(containers) do
        local m, b = countMoneyInContainer(container)
        totalMoney = totalMoney + m
        totalBundles = totalBundles + b
    end
    return totalMoney, totalBundles
end

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
            print("[KnoxRelay] WARNING: hit safety limit removing " .. fullType)
            break
        end
    end
    return removed
end

local function removeMoney(player)
    local moneyRemoved = 0
    local bundlesRemoved = 0
    local containers = collectContainers(player)
    for _, container in ipairs(containers) do
        moneyRemoved = moneyRemoved + removeAllOfType(container, "Base.Money")
        bundlesRemoved = bundlesRemoved + removeAllOfType(container, "Base.MoneyBundle")
    end

    if isServer() then
        if moneyRemoved > 0 then
            sendServerCommand(player, "KnoxRelay", "removeItem", {
                item_type = "Base.Money",
                count = tostring(moneyRemoved),
            })
        end
        if bundlesRemoved > 0 then
            sendServerCommand(player, "KnoxRelay", "removeItem", {
                item_type = "Base.MoneyBundle",
                count = tostring(bundlesRemoved),
            })
        end
    end

    return moneyRemoved, bundlesRemoved
end

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
            sendServerCommand(player, "KnoxRelay", "addItem", {
                item_type = "Base.Money",
                count = tostring(moneyCount),
            })
        end
        if bundleCount > 0 then
            sendServerCommand(player, "KnoxRelay", "addItem", {
                item_type = "Base.MoneyBundle",
                count = tostring(bundleCount),
            })
        end
    end

    print("[KnoxRelay] Restored " .. moneyCount .. " Money + " .. bundleCount
        .. " MoneyBundle to " .. (player:getUsername() or "?")
        .. " after failed deposit_results write")
end

local function appendAndWriteResult(results, result)
    table.insert(results.results, result)
    if writeResults(results) then
        return true
    end
    table.remove(results.results, #results.results)
    return false
end

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

    local moneyValue, bundleValue = loadRates()
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
                        print("[KnoxRelay] WARNING: Money deposit removal incomplete for "
                            .. req.username .. " — " .. moneyAfter .. " Money + " .. bundlesAfter
                            .. " MoneyBundle remaining")
                        if didRemove then
                            restoreMoney(player, moneyRemoved, bundlesRemoved)
                            didRemove = false
                            moneyRemoved = 0
                            bundlesRemoved = 0
                        end
                    else
                        local totalCoins = (moneyRemoved * moneyValue) + (bundlesRemoved * bundleValue)
                        result.status = "success"
                        result.money_count = moneyRemoved
                        result.bundle_count = bundlesRemoved
                        result.stack_count = bundlesRemoved
                        result.total_coins = totalCoins

                        print("[KnoxRelay] Money deposit: " .. req.username .. " deposited "
                            .. moneyRemoved .. " Money + " .. bundlesRemoved
                            .. " MoneyBundle = " .. totalCoins .. " coins (rates "
                            .. moneyValue .. "/" .. bundleValue .. ")")
                    end
                end
            end

            local written = appendAndWriteResult(results, result)
            if not written then
                print("[KnoxRelay] CRITICAL: deposit result not written for "
                    .. tostring(req.username) .. " id=" .. tostring(req.id)
                    .. " — will retry next cycle; restoring items if any were removed")
                if didRemove and player then
                    restoreMoney(player, moneyRemoved, bundlesRemoved)
                    ZM_InventoryExporter.exportPlayer(player)
                end
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

function ZM_MoneyDeposit.init()
    local mv, bv = loadRates()
    print("[KnoxRelay] Money deposit system initialized (money=" .. mv .. " bundle=" .. bv .. ")")
end

return ZM_MoneyDeposit
