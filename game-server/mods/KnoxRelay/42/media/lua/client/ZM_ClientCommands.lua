--
-- ZM_ClientCommands.lua — Client-side handler for KnoxRelay server commands.
-- Mirrors server-side inventory changes on the client for instant UI updates.
-- PZ doesn't sync server-side container changes to clients, so we do it manually.
--

print("[ZM_ClientCommands] Lua file loaded — client-side handler is active")

--- "Base.WaterBottle" → "WaterBottle"
local function shortTypeName(itemType)
    if not itemType then
        return itemType
    end
    return string.match(itemType, "([^%.]+)$") or itemType
end

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

--- Find item by full type or short type (getFirstTypeRecurse only matches short types)
local function findItem(inv, itemType)
    if not inv then
        return nil
    end

    if inv.getItemsFromFullType then
        local items = inv:getItemsFromFullType(itemType)
        if items and items:size() > 0 then
            return items:get(0)
        end
    end

    local short = shortTypeName(itemType)
    if inv.getFirstTypeRecurse then
        local item = inv:getFirstTypeRecurse(short)
        if item then
            return item
        end
        item = inv:getFirstTypeRecurse(itemType)
        if item then
            return item
        end
    end

    -- Manual scan of top-level + one level of bags
    local items = inv:getItems()
    if items then
        for i = 0, items:size() - 1 do
            local item = items:get(i)
            if itemMatchesType(item, itemType) then
                return item
            end
            if item and item.getItemContainer then
                local bag = item:getItemContainer()
                if bag then
                    local bagItems = bag:getItems()
                    if bagItems then
                        for j = 0, bagItems:size() - 1 do
                            local nested = bagItems:get(j)
                            if itemMatchesType(nested, itemType) then
                                return nested
                            end
                        end
                    end
                end
            end
        end
    end

    return nil
end

local function onServerCommand(module, command, args)
    if module ~= "KnoxRelay" then
        return
    end

    print("[ZM_ClientCommands] Received command: module=" .. tostring(module) .. " command=" .. tostring(command) .. " args=" .. tostring(args))

    local playerObj = getSpecificPlayer(0)
    if not playerObj then
        print("[ZM_ClientCommands] No player object found, skipping")
        return
    end
    local inv = playerObj:getInventory()
    if not inv then
        print("[ZM_ClientCommands] No inventory found, skipping")
        return
    end

    if command == "removeItem" then
        local itemType = args.item_type
        local count = tonumber(args.count) or 1
        print("[ZM_ClientCommands] removeItem: type=" .. tostring(itemType) .. " count=" .. tostring(count))
        for i = 1, count do
            local item = findItem(inv, itemType)
            if item then
                local container = item:getContainer() or inv
                if container.Remove then
                    container:Remove(item)
                elseif container.DoRemoveItem then
                    container:DoRemoveItem(item)
                end
                print("[ZM_ClientCommands] removeItem: removed instance " .. tostring(i) .. " of " .. tostring(itemType))
            else
                print("[ZM_ClientCommands] removeItem: item NOT found for instance " .. tostring(i) .. " of " .. tostring(itemType))
            end
        end

    elseif command == "addItem" then
        local itemType = args.item_type
        local count = tonumber(args.count) or 1
        print("[ZM_ClientCommands] addItem: type=" .. tostring(itemType) .. " count=" .. tostring(count))
        for i = 1, count do
            inv:AddItem(itemType)
            print("[ZM_ClientCommands] addItem: added instance " .. tostring(i) .. " of " .. tostring(itemType))
        end
    end
end

Events.OnServerCommand.Add(onServerCommand)
print("[ZM_ClientCommands] OnServerCommand event handler registered")
