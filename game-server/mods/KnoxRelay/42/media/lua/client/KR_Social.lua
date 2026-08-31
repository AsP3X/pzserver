--
-- KR_Social.lua — right-click friend requests and the overhead ask.
--
-- The Desk owns accept/decline. This file only notices another survivor under
-- the cursor, sends a request, and paints "Want to be friends?" over the
-- requester so the other player sees the ask happen.
--

local LOG = "[KnoxRelay] "
local CHANNEL = "KnoxRelay"

local roster = {
    incoming = {},
    outgoing = {},
    friends = {},
    blocked = {},
}

local function sameName(left, right)
    if type(left) ~= "string" or type(right) ~= "string" then
        return false
    end
    return string.lower(left) == string.lower(right)
end

local function me()
    return getSpecificPlayer(0)
end

local function myName()
    local player = me()
    if not player then
        return nil
    end
    return player:getUsername()
end

local function findNamed(username)
    if type(username) ~= "string" or username == "" then
        return nil
    end

    local online = nil
    pcall(function()
        online = getOnlinePlayers()
    end)
    if not online then
        return nil
    end

    local ok, size = pcall(function() return online:size() end)
    if not ok or not size then
        return nil
    end

    for index = 0, size - 1 do
        local player = online:get(index)
        if player and sameName(player:getUsername(), username) then
            return player
        end
    end

    return nil
end

local function inList(list, username)
    if type(list) ~= "table" then
        return nil
    end
    for _, entry in ipairs(list) do
        if type(entry) == "table" and sameName(entry.username, username) then
            return entry
        end
    end
    return nil
end

local function relation(username)
    local friend = inList(roster.friends, username)
    if friend then
        return "friends", friend
    end
    local incoming = inList(roster.incoming, username)
    if incoming then
        return "incoming", incoming
    end
    local outgoing = inList(roster.outgoing, username)
    if outgoing then
        return "outgoing", outgoing
    end
    local blocked = inList(roster.blocked, username)
    if blocked then
        return "blocked", blocked
    end
    return "none", nil
end

local function send(command, args)
    local player = me()
    if not player then
        return
    end
    pcall(function()
        sendClientCommand(player, CHANNEL, command, args or {})
    end)
end

local function sayAsk(speaker, toName)
    if not speaker then
        return
    end
    local line = "Want to be friends?"
    if type(toName) == "string" and toName ~= "" then
        line = "Want to be friends, " .. toName .. "?"
    end
    pcall(function()
        speaker:addLineChatElement(line, 0.95, 0.64, 0.05)
    end)
end

local function halo(text, r, g, b)
    local player = me()
    if not player then
        return
    end
    pcall(function()
        player:setHaloNote(text, r or 242, g or 162, b or 12, 400)
    end)
end

local function isOtherPlayer(object, self)
    if not object or object == self then
        return false
    end
    local ok, human = pcall(function() return instanceof(object, "IsoPlayer") end)
    return ok and human == true
end

local function fromList(list, self)
    if not list then
        return nil
    end
    local ok, size = pcall(function() return list:size() end)
    if ok and type(size) == "number" then
        for index = 0, size - 1 do
            local object = list:get(index)
            if isOtherPlayer(object, self) then
                return object
            end
        end
        return nil
    end
    if type(list) == "table" then
        for _, object in ipairs(list) do
            if isOtherPlayer(object, self) then
                return object
            end
        end
    end
    return nil
end

local function otherFromWorld(playerNum, worldobjects)
    local self = getSpecificPlayer(playerNum)
    if not self then
        return nil
    end

    local clicked = nil
    pcall(function()
        clicked = clickedPlayer
    end)
    if not clicked then
        pcall(function()
            clicked = ISWorldObjectContextMenu.clickedPlayer
        end)
    end
    if isOtherPlayer(clicked, self) then
        return clicked
    end

    local found = fromList(worldobjects, self)
    if found then
        return found
    end

    local square = nil
    pcall(function()
        square = clickedSquare
    end)
    if square and square.getMovingObjects then
        found = fromList(square:getMovingObjects(), self)
        if found then
            return found
        end
    end

    return nil
end

local function onSend(other)
    if not other then
        return
    end
    local name = other:getUsername()
    if not name or name == "" then
        return
    end
    sayAsk(me(), name)
    halo("Asking " .. name .. "...", 242, 162, 12)
    send("friendRequest", { target = name })
end

local function onAccept(entry)
    if not entry or not entry.id then
        return
    end
    send("friendAction", { action = "accept", friendship_id = tostring(entry.id) })
end

local function onDecline(entry)
    if not entry or not entry.id then
        return
    end
    send("friendAction", { action = "decline", friendship_id = tostring(entry.id) })
end

local function addOption(context, label, target, handler)
    local option = nil
    pcall(function()
        option = context:addOption(label, target, handler)
    end)
    return option
end

local function onFillWorldObjectContextMenu(playerNum, context, worldobjects, test)
    local other = otherFromWorld(playerNum, worldobjects)
    if not other then
        return
    end

    local name = other:getUsername()
    if not name or sameName(name, myName()) then
        return
    end

    if test then
        return true
    end

    local status, entry = relation(name)
    if status == "blocked" then
        return
    end

    if status == "friends" then
        local option = addOption(context, "Already friends", other, nil)
        if option then
            option.notAvailable = true
        end
        return
    end

    if status == "outgoing" then
        local option = addOption(context, "Friend request sent", other, nil)
        if option then
            option.notAvailable = true
        end
        return
    end

    if status == "incoming" then
        addOption(context, "Accept friend request", entry, onAccept)
        addOption(context, "Decline friend request", entry, onDecline)
        return
    end

    addOption(context, "Send friend request", other, onSend)
end

local REPLIES = {
    sent = { "Friend request sent.", 242, 162, 12 },
    accepted = { "You are friends now.", 139, 176, 74 },
    already_friends = { "You are already friends.", 200, 200, 200 },
    already_pending = { "You already asked them.", 200, 200, 200 },
    not_registered = { "They need a website account first (/account register).", 192, 57, 43 },
    blocked = { "You cannot send that request.", 192, 57, 43 },
    self = { "You cannot add yourself.", 192, 57, 43 },
    missing = { "That survivor is not on the friends list.", 192, 57, 43 },
    unregistered = { "You need a website account first (/account register).", 192, 57, 43 },
    error = { "The website did not take that request.", 192, 57, 43 },
    no_answer = { "The website did not answer.", 192, 57, 43 },
    ok = { "Friends list updated.", 139, 176, 74 },
}

local function onServerCommand(module, command, args)
    if module ~= CHANNEL or type(args) ~= "table" then
        return
    end

    if command == "friendsState" then
        roster.incoming = args.incoming or {}
        roster.outgoing = args.outgoing or {}
        roster.friends = args.friends or {}
        roster.blocked = args.blocked or {}
        if KR_Desk and KR_Desk.refreshRail then
            KR_Desk.refreshRail()
        end
        return
    end

    if command == "friendFlair" then
        local speaker = findNamed(args.from) or (sameName(args.from, myName()) and me() or nil)
        sayAsk(speaker, args.to)
        if sameName(args.to, myName()) then
            local who = tostring(args.from or "Someone")
            halo(who .. " wants to be friends — open the Knox Desk.", 242, 162, 12)
        end
        return
    end

    if command == "friendReply" then
        local status = tostring(args.status or "error")
        local reply = REPLIES[status] or REPLIES.error
        halo(reply[1], reply[2], reply[3], reply[4])
    end
end

Events.OnFillWorldObjectContextMenu.Add(onFillWorldObjectContextMenu)
Events.OnServerCommand.Add(onServerCommand)

print(LOG .. "Social: right-click friend requests are active")
