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
---
--- Held (queued take) copies are preferred so a drain removes the reserved
--- ones rather than a spare the player meant to keep.
function KR_Stash.locate(player, itemType)
    local held = KR_Stash.locateMatching(player, itemType, true)
    if held then
        return held
    end

    local free = KR_Stash.locateMatching(player, itemType, false)
    if free then
        return free
    end

    local inventory = player:getInventory()
    if inventory and inventory.getFirstTypeRecurse then
        return inventory:getFirstTypeRecurse(KR_Stash.shortType(itemType))
            or inventory:getFirstTypeRecurse(itemType)
    end

    return nil
end

--- First match of `itemType` whose hold flag equals `wantHeld`.
function KR_Stash.locateMatching(player, itemType, wantHeld)
    for _, container in ipairs(KR_Stash.containers(player)) do
        local contents = container.getItems and container:getItems()
        if contents then
            for index = 0, contents:size() - 1 do
                local item = contents:get(index)
                if KR_Stash.matches(item, itemType) and KR_Stash.isHeld(item) == wantHeld then
                    return item
                end
            end
        end
    end

    return nil
end

function KR_Stash.isHeld(item)
    if not item or not item.getModData then
        return false
    end

    return item:getModData().knox_hold == true
end

--- Pin an item so the client cannot drop it, or release that pin.
---
--- Favorite is the engine's own "cannot drop this" flag. We remember whether
--- the player had already favorited it so a failed take does not clear their
--- own star.
function KR_Stash.markHeld(item, held)
    if not item or not item.getModData then
        return
    end

    local data = item:getModData()

    if held then
        if data.knox_hold then
            return
        end
        data.knox_hold = true
        if item.isFavorite and item.setFavorite then
            data.knox_hold_fav = item:isFavorite() == true
            item:setFavorite(true)
        end
        return
    end

    if not data.knox_hold then
        return
    end

    data.knox_hold = nil
    if item.setFavorite then
        item:setFavorite(data.knox_hold_fav == true)
    end
    data.knox_hold_fav = nil
end

--- Release every hold we placed on this player. Used after a drain so a
--- leftover pin cannot trap an item that was not taken.
function KR_Stash.unlockHeld(player)
    for _, container in ipairs(KR_Stash.containers(player)) do
        local contents = container.getItems and container:getItems()
        if contents then
            for index = 0, contents:size() - 1 do
                local item = contents:get(index)
                if KR_Stash.isHeld(item) then
                    KR_Stash.markHeld(item, false)
                end
            end
        end
    end
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

--- The classes the game itself draws a condition bar for. Every other item
--- keeps the InventoryItem default of 10/10 for life, so reporting a fraction
--- for them would pin a meaningless 100% next to every can of beans.
local WEARS_OUT = { "HandWeapon", "Clothing", "InventoryContainer" }

--- Does this item track durability?
local function tracksCondition(item)
    for _, class in ipairs(WEARS_OUT) do
        if instanceof(item, class) then
            return true
        end
    end

    return false
end

--- Wear as a 0..1 fraction rounded to two decimals, or nil when the item has
--- no durability worth reporting.
---
--- The ceiling is getConditionMax(); InventoryItem has no getMaxCondition(),
--- and asking for one used to fail the guard on every single item, which made
--- the dashboard report the whole world as pristine.
function KR_Stash.wear(item)
    if not item or not item.getCondition or not item.getConditionMax then
        return nil
    end

    local ceiling = item:getConditionMax()
    if not ceiling or ceiling <= 0 then
        return nil
    end

    local current = item:getCondition() or 0

    --- Anything already damaged is reported whatever its class, so a worn item
    --- never hides behind an unfamiliar type.
    if current >= ceiling and not tracksCondition(item) then
        return nil
    end

    return math.floor((current / ceiling) * 100) / 100
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

--- Make a just-spawned item actually usable.
---
--- B42 water bottles list Water and CarbonatedWater with PickRandomFluid.
--- inventory:AddItem() can load both as a mixture. The game will pour a
--- mixture but will not drink it (isWaterSource is false, and Water is not
--- a Beverage). Empty the container and fill it with one fluid instead.
function KR_Stash.primeSpawned(item)
    if not item then
        return
    end

    if item.setUsedDelta then
        pcall(function()
            item:setUsedDelta(1)
        end)
    end

    if not item.getFluidContainer then
        return
    end

    local container = item:getFluidContainer()
    if not container then
        return
    end

    local water = nil
    if Fluid and Fluid.Water then
        water = Fluid.Water
    elseif FluidType and FluidType.Water then
        water = FluidType.Water
    end

    local function allows(fluid)
        if not fluid or not container.canAddFluid then
            return fluid ~= nil
        end
        local ok, allowed = pcall(function()
            return container:canAddFluid(fluid)
        end)
        if not ok then
            return true
        end
        return allowed == true
    end

    local empty = container.isEmpty and container:isEmpty()
    local mixed = container.isMixture and container:isMixture()
    local hasWater = water and container.contains and container:contains(water)
    local pureWater = water and container.isPureFluid and container:isPureFluid(water)

    local fillWith = nil
    if allows(water) and (empty or mixed or (hasWater and not pureWater)) then
        fillWith = water
    elseif empty and container.getPrimaryFluid then
        fillWith = container:getPrimaryFluid()
    end

    if not fillWith or not allows(fillWith) then
        return
    end

    if container.Empty then
        container:Empty()
    end
    if container.addFluid and container.getCapacity then
        container:addFluid(fillWith, container:getCapacity())
    end
end

return KR_Stash
