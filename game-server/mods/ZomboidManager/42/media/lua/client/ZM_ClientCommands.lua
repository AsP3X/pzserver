--
-- ZM_ClientCommands.lua — Client-side handler for ZomboidManager server commands.
-- Mirrors server-side inventory changes on the client for instant UI updates.
-- PZ doesn't sync server-side container changes to clients, so we do it manually.
--

print("[ZM_ClientCommands] Lua file loaded — client-side handler is active")

local function onServerCommand(module, command, args)
    if module ~= "ZomboidManager" then
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
        -- Server already removed the item — mirror the removal on the client
        -- so the inventory UI updates instantly without relog.
        local itemType = args.item_type
        local count = tonumber(args.count) or 1
        print("[ZM_ClientCommands] removeItem: type=" .. tostring(itemType) .. " count=" .. tostring(count))
        for i = 1, count do
            local item = inv:getFirstTypeRecurse(itemType)
            if item then
                local container = item:getContainer() or inv
                container:Remove(item)
                print("[ZM_ClientCommands] removeItem: removed instance " .. tostring(i) .. " of " .. tostring(itemType))
            else
                print("[ZM_ClientCommands] removeItem: item NOT found for instance " .. tostring(i) .. " of " .. tostring(itemType))
            end
        end

    elseif command == "addItem" then
        -- Server already added the item — mirror the addition on the client
        -- so the inventory UI updates instantly without relog.
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
