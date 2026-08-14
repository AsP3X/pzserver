--
-- KR_Hold.lua — refuse drop/transfer of items reserved for a queued take.
--
-- Server-side container edits do not reach the client, and the player can
-- still drop from their own UI. While a take is pending we pin those types
-- here so they cannot dump the item on the floor before KR_Orders runs.
--

local LOG = "[KnoxRelay] "

local CHANNEL = "KnoxRelay"
local heldTypes = {}

local function shortType(itemType)
    if not itemType then
        return itemType
    end

    return string.match(itemType, "([^%.]+)$") or itemType
end

local function typeHeld(itemType)
    if not itemType then
        return false
    end

    if heldTypes[itemType] then
        return true
    end

    return heldTypes[shortType(itemType)] == true
end

local function itemHeld(item)
    if not item then
        return false
    end

    if item.getModData then
        local data = item:getModData()
        if data and data.knox_hold then
            return true
        end
    end

    if item.getFullType and typeHeld(item:getFullType()) then
        return true
    end

    if item.getType and typeHeld(item:getType()) then
        return true
    end

    return false
end

local function onServerCommand(module, command, args)
    if module ~= CHANNEL then
        return
    end

    if command == "holdItems" then
        heldTypes = {}
        local types = args and args.types
        if type(types) == "table" then
            for _, itemType in ipairs(types) do
                heldTypes[itemType] = true
                heldTypes[shortType(itemType)] = true
            end
        end
        print(LOG .. "Holding reserved item types until the queue drains")
        return
    end

    if command == "clearHolds" then
        heldTypes = {}
    end
end

Events.OnServerCommand.Add(onServerCommand)

--- Block a vanilla action class if it exists on this build.
local function wrapValid(className)
    local ok, class = pcall(function()
        return _G[className]
    end)
    if not ok or type(class) ~= "table" or type(class.isValid) ~= "function" then
        return
    end

    local original = class.isValid
    class.isValid = function(self)
        local item = self.item or self.itemToThrow
        if not item and self.itemObj then
            item = self.itemObj
        end
        if itemHeld(item) then
            return false
        end

        if self.destContainer == nil and itemHeld(self.item) then
            return false
        end

        return original(self)
    end
end

wrapValid("ISInventoryTransferAction")
wrapValid("ISDropItemAction")
wrapValid("ISDropWorldItemAction")
wrapValid("ISEatFoodAction")
wrapValid("ISDrinkFromBottle")

print(LOG .. "Hold handler registered")
