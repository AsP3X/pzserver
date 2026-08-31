--
-- KR_Friends.lua — friend requests between linked characters.
--
-- The graph lives on the website. We write actions to friends_outbox.json,
-- paint a speech line on the requester, and push friends_inbox.json slices
-- back with sendServerCommand. The username on every action comes from the
-- server's own player object, so a doctored client can only act as itself.
--

local Bridge = require("KR_Bridge")
local Roster = require("KR_Roster")

KR_Friends = {}

local LOG = "[KnoxRelay] "
local OUTBOX = "friends_outbox.json"
local INBOX = "friends_inbox.json"
local RESULTS = "friends_results.json"

local lastSeen = {}
local waiting = {}
local ANSWER_TICKS = 12
local REQUEST_LIMIT = 100
local FLAIR_RANGE = 20
local runs = 0

local function mintId(username)
    runs = runs + 1
    return string.format("%s-%s-%d", username, Bridge.wallStamp(), runs)
end

local function occupied(table_)
    for _ in pairs(table_) do
        return true
    end
    return false
end

local function loadOutbox()
    local file = Bridge.readJson(OUTBOX)
    if type(file) ~= "table" or type(file.requests) ~= "table" then
        return { version = 1, updated_at = "", requests = {} }
    end
    return file
end

local function saveOutbox(file)
    file.version = 1
    file.updated_at = Bridge.wallStamp()
    while #file.requests > REQUEST_LIMIT do
        table.remove(file.requests, 1)
    end
    return Bridge.writeJson(OUTBOX, file)
end

local function tell(player, command, args)
    if not player or not isServer() then
        return false
    end
    local sent = pcall(function()
        sendServerCommand(player, "KnoxRelay", command, args)
    end)
    return sent
end

local function distance2(left, right)
    local ok, value = pcall(function()
        local dx = (left:getX() or 0) - (right:getX() or 0)
        local dy = (left:getY() or 0) - (right:getY() or 0)
        local dz = (left:getZ() or 0) - (right:getZ() or 0)
        return dx * dx + dy * dy + dz * dz * 16
    end)
    if ok and type(value) == "number" then
        return value
    end
    return 999999
end

--- Everyone close enough to see the requester ask.
local function audience(origin, extra)
    local seen = {}
    local players = {}

    local function include(player)
        if not player then
            return
        end
        local name = player:getUsername()
        if type(name) ~= "string" or seen[name] then
            return
        end
        seen[name] = true
        players[#players + 1] = player
    end

    include(extra)

    local roster = Roster.online()
    if roster then
        local reach = FLAIR_RANGE * FLAIR_RANGE
        local fromName = origin:getUsername()
        for _, player in ipairs(roster) do
            if player ~= origin
                and not Roster.sameName(player:getUsername(), fromName)
                and distance2(origin, player) <= reach
            then
                include(player)
            end
        end
    end

    return players
end

--- The requester asks out loud. Nearby clients paint the line on that body.
function KR_Friends.flair(fromPlayer, toName)
    if not fromPlayer then
        return
    end

    local fromName = fromPlayer:getUsername()
    if not fromName or fromName == "" then
        return
    end

    toName = tostring(toName or "")
    local target = Roster.find(toName)
    local payload = { from = fromName, to = toName }

    for _, player in ipairs(audience(fromPlayer, target)) do
        tell(player, "friendFlair", payload)
    end
end

function KR_Friends.enqueue(player, action, fields)
    if not player then
        return nil
    end

    local username = player:getUsername()
    if not username or username == "" then
        print(LOG .. "Friends: refusing an action from a player with no username")
        return nil
    end

    action = tostring(action or "")
    fields = type(fields) == "table" and fields or {}

    local id = mintId(username)
    local file = loadOutbox()
    local share = fields.share_position
    if share ~= true and share ~= false then
        share = nil
    end

    file.requests[#file.requests + 1] = {
        id = id,
        username = username,
        action = action,
        target = tostring(fields.target or ""),
        friendship_id = tostring(fields.friendship_id or ""),
        share_position = share,
        requested_at = Bridge.wallStamp(),
    }

    if not saveOutbox(file) then
        print(LOG .. "Friends: could not write " .. OUTBOX)
        return nil
    end

    if action == "request" then
        waiting[id] = { username = username, ticks = 0 }
        KR_Friends.flair(player, fields.target)
        print(LOG .. "Friends: " .. username .. " requested " .. tostring(fields.target or "")
            .. " (" .. id .. ")")
    end

    return id
end

function KR_Friends.push(player)
    if not player or not isServer() then
        return
    end

    local username = player:getUsername()
    if not username then
        return
    end

    local inbox = Bridge.readJson(INBOX)
    if type(inbox) ~= "table" or type(inbox.players) ~= "table" then
        tell(player, "friendsState", {
            unread = 0,
            updated_at = "",
            incoming = {},
            outgoing = {},
            friends = {},
            blocked = {},
        })
        return
    end

    local slice = inbox.players[username]
    if type(slice) ~= "table" then
        for name, entry in pairs(inbox.players) do
            if type(name) == "string" and Roster.sameName(name, username) then
                slice = entry
                break
            end
        end
    end

    if type(slice) ~= "table" then
        slice = {
            unread = 0,
            updated_at = "",
            incoming = {},
            outgoing = {},
            friends = {},
            blocked = {},
        }
    end

    lastSeen[username] = slice.updated_at
    tell(player, "friendsState", {
        unread = slice.unread or 0,
        updated_at = slice.updated_at or "",
        incoming = slice.incoming or {},
        outgoing = slice.outgoing or {},
        friends = slice.friends or {},
        blocked = slice.blocked or {},
    })
end

function KR_Friends.poll()
    local pushed = 0
    local inbox = Bridge.readJson(INBOX)
    if type(inbox) == "table" and type(inbox.players) == "table" then
        for name, slice in pairs(inbox.players) do
            if type(slice) == "table" and slice.updated_at and lastSeen[name] ~= slice.updated_at then
                local player = Roster.find(name)
                if player then
                    KR_Friends.push(player)
                    pushed = pushed + 1
                else
                    lastSeen[name] = slice.updated_at
                end
            end
        end
    end

    if occupied(waiting) then
        local ledger = Bridge.readJson(RESULTS)

        if type(ledger) == "table" and type(ledger.results) == "table" then
            for _, result in ipairs(ledger.results) do
                local entry = type(result) == "table" and result.id and waiting[result.id]
                if entry then
                    local player = Roster.find(entry.username)
                    if player then
                        tell(player, "friendReply", { status = result.status })
                    end
                    waiting[result.id] = nil
                end
            end
        end

        for id, entry in pairs(waiting) do
            entry.ticks = (entry.ticks or 0) + 1
            if entry.ticks >= ANSWER_TICKS then
                local player = Roster.find(entry.username)
                if player then
                    tell(player, "friendReply", { status = "no_answer" })
                end
                waiting[id] = nil
            end
        end
    end

    return pushed
end

function KR_Friends.onClientCommand(module, command, player, args)
    if module ~= "KnoxRelay" then
        return
    end

    if command == "deskOpen" then
        KR_Friends.push(player)
        return
    end

    if command == "friendRequest" then
        local target = ""
        if type(args) == "table" then
            target = tostring(args.target or "")
        end
        if target == "" then
            tell(player, "friendReply", { status = "missing" })
            return
        end
        if not KR_Friends.enqueue(player, "request", { target = target }) then
            tell(player, "friendReply", { status = "error" })
        end
        return
    end

    if command ~= "friendAction" or type(args) ~= "table" then
        return
    end

    local action = tostring(args.action or "")
    if action == "" then
        return
    end

    if not KR_Friends.enqueue(player, action, {
        target = args.target,
        friendship_id = args.friendship_id,
        share_position = args.share_position,
    }) then
        tell(player, "friendReply", { status = "error" })
    end
end

function KR_Friends.seed()
    if not Bridge.readJson(OUTBOX) then
        Bridge.writeJson(OUTBOX, { version = 1, updated_at = Bridge.wallStamp(), requests = {} })
    end
    if not Bridge.readJson(INBOX) then
        Bridge.writeJson(INBOX, { version = 1, updated_at = Bridge.wallStamp(), players = {} })
    end
    if not Bridge.readJson(RESULTS) then
        Bridge.writeJson(RESULTS, { version = 1, updated_at = Bridge.wallStamp(), results = {} })
    end
end

function KR_Friends.forget(player)
    if not player then
        return
    end
    local username = player:getUsername()
    if not username then
        return
    end
    for id, entry in pairs(waiting) do
        if entry.username == username then
            waiting[id] = nil
        end
    end
end

return KR_Friends
