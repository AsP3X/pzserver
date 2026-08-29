--
-- KR_Tickets.lua — Desk ticket channel.
--
-- The client cannot read the dedicated server's Lua folder. We write the
-- player's actions to tickets_outbox.json and push tickets_inbox.json slices
-- back with sendServerCommand.
--

local Bridge = require("KR_Bridge")
local Roster = require("KR_Roster")

KR_Tickets = {}

local LOG = "[KnoxRelay] "
local OUTBOX = "tickets_outbox.json"
local INBOX = "tickets_inbox.json"
local lastSeen = {}
local runs = 0

local function mintId(username)
    runs = runs + 1
    return string.format("%s-%s-%d", username, Bridge.wallStamp(), runs)
end

local function loadOutbox()
    local file = Bridge.readJson(OUTBOX)
    if type(file) ~= "table" or type(file.requests) ~= "table" then
        return { version = 1, requests = {} }
    end
    return file
end

local function saveOutbox(file)
    file.version = 1
    file.updated_at = Bridge.wallStamp()
    return Bridge.writeJson(OUTBOX, file)
end

function KR_Tickets.seed()
    if not Bridge.readJson(OUTBOX) then
        Bridge.writeJson(OUTBOX, { version = 1, updated_at = Bridge.wallStamp(), requests = {} })
    end
    if not Bridge.readJson(INBOX) then
        Bridge.writeJson(INBOX, { version = 1, updated_at = Bridge.wallStamp(), players = {} })
    end
end

function KR_Tickets.push(player)
    if not player or not isServer() then
        return
    end

    local username = player:getUsername()
    if not username then
        return
    end

    local inbox = Bridge.readJson(INBOX)
    if type(inbox) ~= "table" or type(inbox.players) ~= "table" then
        return
    end

    local slice = inbox.players[username]
    if type(slice) ~= "table" then
        -- usernames are stored as written; try a case walk
        for name, entry in pairs(inbox.players) do
            if type(name) == "string" and string.lower(name) == string.lower(username) then
                slice = entry
                break
            end
        end
    end

    if type(slice) ~= "table" then
        slice = { unread = 0, updated_at = "", reports = {}, notices = {} }
    end

    lastSeen[username] = slice.updated_at

    pcall(function()
        sendServerCommand(player, "KnoxRelay", "deskInbox", {
            unread = slice.unread or 0,
            updated_at = slice.updated_at or "",
            reports = slice.reports or {},
            notices = slice.notices or {},
        })
    end)
end

function KR_Tickets.poll()
    local inbox = Bridge.readJson(INBOX)
    if type(inbox) ~= "table" or type(inbox.players) ~= "table" then
        return 0
    end

    local pushed = 0
    for name, slice in pairs(inbox.players) do
        if type(slice) == "table" and slice.updated_at and lastSeen[name] ~= slice.updated_at then
            local player = Roster.find(name)
            if player then
                KR_Tickets.push(player)
                pushed = pushed + 1
            else
                lastSeen[name] = slice.updated_at
            end
        end
    end

    return pushed
end

function KR_Tickets.onClientCommand(module, command, player, args)
    if module ~= "KnoxRelay" then
        return
    end

    if command == "deskOpen" then
        KR_Tickets.push(player)
        return
    end

    if command ~= "deskAction" or type(args) ~= "table" then
        return
    end

    if not player then
        return
    end

    local username = player:getUsername()
    if not username or username == "" then
        return
    end

    local file = loadOutbox()
    file.requests[#file.requests + 1] = {
        id = mintId(username),
        username = username,
        action = tostring(args.action or ""),
        report_id = tonumber(args.report_id),
        body = tostring(args.body or ""),
        kind = tostring(args.kind or ""),
        subject = tostring(args.subject or ""),
        accused = tostring(args.accused or ""),
        requested_at = Bridge.wallStamp(),
    }

    if not saveOutbox(file) then
        print(LOG .. "Tickets: could not write " .. OUTBOX)
    end
end

return KR_Tickets
