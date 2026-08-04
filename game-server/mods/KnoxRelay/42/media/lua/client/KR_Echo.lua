--
-- KR_Echo.lua — client-side mirror of server inventory edits.
--
-- Project Zomboid does not replicate container changes made on the server down
-- to the client that owns them. Without this file, a shop purchase only shows
-- up after the player relogs or the container is re-opened.
--
-- So the server performs the real edit and sends a matching command here; this
-- file repeats the edit locally purely so the UI agrees with the server. It is
-- cosmetic catch-up, never the authoritative change.
--
-- The logging is verbose on purpose: this runs on player machines and a
-- mismatch between what the server did and what the client shows is otherwise
-- close to impossible to diagnose from a bug report.
--

local LOG = "[KnoxRelay] "

print(LOG .. "Lua file loaded — client-side handler is active")

local CHANNEL = "KnoxRelay"

--- "Base.WaterBottle" -> "WaterBottle"
local function shortType(itemType)
    if not itemType then
        return itemType
    end

    return string.match(itemType, "([^%.]+)$") or itemType
end

--- Match on either the full type or the short type, since callers are not
--- consistent about which one they send.
local function matches(item, itemType)
    if not item or not itemType then
        return false
    end

    if item.getFullType and item:getFullType() == itemType then
        return true
    end
    if item.getType and item:getType() == itemType then
        return true
    end

    local short = shortType(itemType)

    return short ~= nil and item.getType ~= nil and item:getType() == short
end

--- Hunt for one instance of `itemType`, widening the search as it goes:
--- full-type lookup, then the engine's recursive search under both spellings,
--- then a manual pass over the inventory and one level of bags inside it.
local function findItem(inventory, itemType)
    if not inventory then
        return nil
    end

    if inventory.getItemsFromFullType then
        local found = inventory:getItemsFromFullType(itemType)
        if found and found:size() > 0 then
            return found:get(0)
        end
    end

    if inventory.getFirstTypeRecurse then
        local item = inventory:getFirstTypeRecurse(shortType(itemType))
            or inventory:getFirstTypeRecurse(itemType)
        if item then
            return item
        end
    end

    local contents = inventory:getItems()
    if not contents then
        return nil
    end

    for index = 0, contents:size() - 1 do
        local item = contents:get(index)
        if matches(item, itemType) then
            return item
        end

        if item and item.getItemContainer then
            local bag = item:getItemContainer()
            local inside = bag and bag:getItems()
            if inside then
                for nestedIndex = 0, inside:size() - 1 do
                    local nested = inside:get(nestedIndex)
                    if matches(nested, itemType) then
                        return nested
                    end
                end
            end
        end
    end

    return nil
end

local function mirrorRemoval(inventory, itemType, count)
    print(LOG .. "removeItem: type=" .. tostring(itemType) .. " count=" .. tostring(count))

    for attempt = 1, count do
        local item = findItem(inventory, itemType)
        if item then
            local container = item:getContainer() or inventory
            if container.Remove then
                container:Remove(item)
            elseif container.DoRemoveItem then
                container:DoRemoveItem(item)
            end
            print(LOG .. "removeItem: removed instance " .. tostring(attempt) .. " of " .. tostring(itemType))
        else
            print(LOG .. "removeItem: item NOT found for instance " .. tostring(attempt) .. " of " .. tostring(itemType))
        end
    end
end

local function mirrorAddition(inventory, itemType, count)
    print(LOG .. "addItem: type=" .. tostring(itemType) .. " count=" .. tostring(count))

    for attempt = 1, count do
        inventory:AddItem(itemType)
        print(LOG .. "addItem: added instance " .. tostring(attempt) .. " of " .. tostring(itemType))
    end
end

local function onServerCommand(module, command, args)
    if module ~= CHANNEL then
        return
    end

    print(LOG .. "Received command: module=" .. tostring(module)
        .. " command=" .. tostring(command) .. " args=" .. tostring(args))

    local player = getSpecificPlayer(0)
    if not player then
        print(LOG .. "No player object found, skipping")

        return
    end

    local inventory = player:getInventory()
    if not inventory then
        print(LOG .. "No inventory found, skipping")

        return
    end

    if command == "removeItem" then
        mirrorRemoval(inventory, args.item_type, tonumber(args.count) or 1)
    elseif command == "addItem" then
        mirrorAddition(inventory, args.item_type, tonumber(args.count) or 1)
    end
end

Events.OnServerCommand.Add(onServerCommand)
print(LOG .. "OnServerCommand event handler registered")
