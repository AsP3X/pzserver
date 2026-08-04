--
-- KR_Stash.lua — reaching every item a player is carrying.
--
-- "Inventory" in Project Zomboid is not one container. It is the main
-- inventory, plus a bag on the back, plus any worn item that happens to have
-- a container (fanny packs, holsters), plus bags nested inside those bags.
-- Item lookups that only check the main inventory quietly miss things, which
-- for a shop means charging a player for goods that never arrived.
--
-- Type names are equally slippery: getItemsFromFullType wants "Base.Axe"
-- while getFirstType and getFirstTypeRecurse want "Axe". Both spellings are
-- tried everywhere rather than assuming which one a caller passed in.
--

KR_Stash = {}

--- "Base.WaterBottle" -> "WaterBottle". Already-short names pass through.
function KR_Stash.shortType(itemType)
    if not itemType then
        return itemType
    end

    return string.match(itemType, "([^%.]+)$") or itemType
end

--- Does this item answer to `itemType` under either spelling?
function KR_Stash.matches(item, itemType)
    if not item or not itemType then
        return false
    end

    if item.getFullType and item:getFullType() == itemType then
        return true
    end
    if item.getType and item:getType() == itemType then
        return true
    end

    local short = KR_Stash.shortType(itemType)

    return short ~= nil and item.getType ~= nil and item:getType() == short
end

--- Every container reachable from the player, breadth of the whole rig.
--- Containers are identified by their tostring() address so a bag reachable
--- by two routes is only visited once.
function KR_Stash.containers(player)
    local found = {}
    local visited = {}

    local function descend(container)
        if not container then
            return
        end

        local address = tostring(container)
        if visited[address] then
            return
        end
        visited[address] = true
        found[#found + 1] = container

        local contents = container:getItems()
        if not contents then
            return
        end

        for index = 0, contents:size() - 1 do
            local item = contents:get(index)
            if item and item.getItemContainer then
                descend(item:getItemContainer())
            end
        end
    end

    descend(player:getInventory())

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
                    descend(item:getItemContainer())
                end
            end
        end
    end

    local backpack = player:getClothingItem_Back()
    if backpack and backpack:getItemContainer() then
        descend(backpack:getItemContainer())
    end

    return found
end

--- First item of `itemType` directly inside `container`, or nil.
function KR_Stash.firstIn(container, itemType)
    if not container then
        return nil
    end

    if container.getItemsFromFullType then
        local matches = container:getItemsFromFullType(itemType)
        if matches and matches:size() > 0 then
            return matches:get(0)
        end
    end

    local short = KR_Stash.shortType(itemType)
    if container.getFirstType then
        local item = container:getFirstType(short)
        if item then
            return item
        end
        if short ~= itemType then
            item = container:getFirstType(itemType)
            if item then
                return item
            end
        end
    end

    local contents = container:getItems()
    if not contents then
        return nil
    end

    for index = 0, contents:size() - 1 do
        local item = contents:get(index)
        if KR_Stash.matches(item, itemType) then
            return item
        end
    end

    return nil
end

--- First item of `itemType` anywhere on the player, or nil. Falls back to the
--- engine's recursive search when the manual walk comes up empty.
function KR_Stash.locate(player, itemType)
    for _, container in ipairs(KR_Stash.containers(player)) do
        local item = KR_Stash.firstIn(container, itemType)
        if item then
            return item
        end
    end

    local inventory = player:getInventory()
    if inventory and inventory.getFirstTypeRecurse then
        return inventory:getFirstTypeRecurse(KR_Stash.shortType(itemType))
            or inventory:getFirstTypeRecurse(itemType)
    end

    return nil
end

--- How many of `itemType` the player is carrying, across every container.
function KR_Stash.count(player, itemType)
    local total = 0

    for _, container in ipairs(KR_Stash.containers(player)) do
        if container.getItemsFromFullType then
            local matches = container:getItemsFromFullType(itemType)
            if matches then
                total = total + matches:size()
            end
        else
            local contents = container:getItems()
            if contents then
                for index = 0, contents:size() - 1 do
                    if KR_Stash.matches(contents:get(index), itemType) then
                        total = total + 1
                    end
                end
            end
        end
    end

    return total
end

--- Wear/condition as a 0..1 fraction rounded to two decimals. Items with no
--- condition concept report 1.0.
function KR_Stash.wear(item)
    if item.getCondition and item.getMaxCondition then
        local ceiling = item:getMaxCondition()
        if ceiling > 0 then
            return math.floor((item:getCondition() / ceiling) * 100) / 100
        end
    end

    return 1.0
end

--- Drop an item out of the player's hands or clothing slots before it is
--- taken away, otherwise the client keeps rendering it as equipped.
function KR_Stash.unequip(player, item)
    if player:isEquipped(item) then
        player:removeWornItem(item)
    end
    if player:getPrimaryHandItem() == item then
        player:setPrimaryHandItem(nil)
    end
    if player:getSecondaryHandItem() == item then
        player:setSecondaryHandItem(nil)
    end
end

--- Take an item out of whichever container currently holds it, trying each
--- removal API the container might expose.
function KR_Stash.detach(player, item)
    local inventory = player:getInventory()
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
end

return KR_Stash
