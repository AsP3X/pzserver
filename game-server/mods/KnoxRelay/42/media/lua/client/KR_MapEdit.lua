--
-- KR_MapEdit.lua — notice world edits the isometric map cares about.
--
-- Closing a blind, a door, or hanging a sheet is a timed action that does not
-- always rewrite a chunk file until later. The dedicated server only sees the
-- save. This file watches the actions on the client, tells the server, and
-- (when staff have debug on) draws the pending count above the character.
--

local LOG = "[KnoxRelay] "
local CHANNEL = "KnoxRelay"

local ACTIONS = {
    { name = "ISOpenCloseCurtain", kind = "curtain" },
    { name = "ISOpenCloseDoor", kind = "door" },
    { name = "ISOpenCloseWindow", kind = "window" },
    { name = "ISAddSheetAction", kind = "sheet" },
    { name = "ISRemoveSheetAction", kind = "sheet" },
    { name = "ISBarricadeAction", kind = "barricade" },
    { name = "ISUnbarricadeAction", kind = "barricade" },
    { name = "ISLockDoor", kind = "lock" },
    { name = "ISSmashWindow", kind = "smash" },
}

local wrapped = {}

local function coords(item)
    if not item then
        return nil, nil
    end

    if item.getSquare then
        local square = item:getSquare()
        if square and square.getX and square.getY then
            return square:getX(), square:getY()
        end
    end

    if item.getX and item.getY then
        return item:getX(), item:getY()
    end

    return nil, nil
end

local function report(self, kind)
    local player = self and self.character
    if not player then
        return
    end

    local x, y = coords(self.item)
    if not x or not y then
        return
    end

    pcall(function()
        sendClientCommand(player, CHANNEL, "worldEdit", {
            x = math.floor(x),
            y = math.floor(y),
            kind = kind,
        })
    end)
end

local function wrapOne(name, kind)
    if wrapped[name] then
        return true
    end

    local cls = _G[name]
    if not cls or type(cls.complete) ~= "function" then
        return false
    end

    local original = cls.complete
    cls.complete = function(self)
        local ok = original(self)
        if ok ~= false then
            report(self, kind)
        end

        return ok
    end
    wrapped[name] = true

    return true
end

local function wrapAll()
    local missing = 0
    for index = 1, #ACTIONS do
        local action = ACTIONS[index]
        if not wrapOne(action.name, action.kind) then
            missing = missing + 1
        end
    end

    return missing
end

local tries = 0

local function ensureWrapped()
    tries = tries + 1
    local missing = wrapAll()
    if missing == 0 or tries > 40 then
        Events.OnTick.Remove(ensureWrapped)
        print(LOG .. "Map edit watchers ready")
    end
end

local function halo(text, red, green, blue)
    local player = getSpecificPlayer(0)
    if not player then
        return
    end

    pcall(function()
        player:setHaloNote(text, red, green, blue, 400)
    end)
    pcall(function()
        player:addLineChatElement(text, red / 255, green / 255, blue / 255)
    end)
end

local function onServerCommand(module, command, args)
    if module ~= CHANNEL or command ~= "mapEditPulse" then
        return
    end

    args = args or {}
    if args.fired then
        halo("PAINT", 139, 176, 74)
        return
    end

    local count = tonumber(args.count)
    if count then
        halo(tostring(count), 242, 162, 12)
    end
end

Events.OnServerCommand.Add(onServerCommand)
Events.OnGameStart.Add(function()
    Events.OnTick.Add(ensureWrapped)
end)

print(LOG .. "Map edit client loaded")
