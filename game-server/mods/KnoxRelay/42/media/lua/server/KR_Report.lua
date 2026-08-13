--
-- KR_Report.lua — the /report channel.
--
-- A player types /report Name what happened. The client only reads the chat
-- box; the username we file under comes from the server's own player object.
-- The panel answers in report_results.json, and we tell that one player
-- whether it landed — never through a chat channel, because the text of a
-- report should not be in the server log.
--
--   report_requests.json   we write     one entry per run of the command
--   report_results.json    we read      the panel's answer, keyed by id
--

local Bridge = require("KR_Bridge")
local Roster = require("KR_Roster")

KR_Report = {}

local LOG = "[KnoxRelay] "
local REQUESTS = "report_requests.json"
local RESULTS = "report_results.json"

local waiting = {}
local ANSWER_TICKS = 12
local REQUEST_LIMIT = 100
local runs = 0

local function mintId(username)
    runs = runs + 1

    local salt = 0
    local rolled, value = pcall(function()
        return ZombRand(1000000)
    end)
    if rolled and type(value) == "number" then
        salt = value
    end

    return string.format("%s-%s-%d-%d", username, Bridge.wallStamp(), runs, salt)
end

local function loadRequests()
    local file = Bridge.readJson(REQUESTS)
    if type(file) ~= "table" or type(file.requests) ~= "table" then
        return { version = 1, updated_at = "", requests = {} }
    end

    return file
end

local function saveRequests(file)
    file.version = 1
    file.updated_at = Bridge.wallStamp()

    while #file.requests > REQUEST_LIMIT do
        table.remove(file.requests, 1)
    end

    return Bridge.writeJson(REQUESTS, file)
end

local function tell(player, status)
    if not player or not isServer() then
        return false
    end

    local sent = pcall(function()
        sendServerCommand(player, "KnoxRelay", "reportReply", {
            status = status,
        })
    end)

    return sent
end

local function occupied(table_)
    for _ in pairs(table_) do
        return true
    end

    return false
end

--- File a report. Returns the id, or nil if the write failed.
function KR_Report.request(player, accused, body)
    if not player then
        return nil
    end

    local username = player:getUsername()
    if not username or username == "" then
        print(LOG .. "Report: refusing a request from a player with no username")

        return nil
    end

    accused = tostring(accused or "")
    body = tostring(body or "")

    for id, entry in pairs(waiting) do
        if entry.username == username then
            waiting[id] = nil
        end
    end

    local id = mintId(username)
    local file = loadRequests()

    for index = #file.requests, 1, -1 do
        local request = file.requests[index]
        if type(request) == "table" and request.username == username then
            table.remove(file.requests, index)
        end
    end

    file.requests[#file.requests + 1] = {
        id = id,
        username = username,
        accused = accused,
        body = body,
        requested_at = Bridge.wallStamp(),
    }

    if not saveRequests(file) then
        print(LOG .. "Report: could not write " .. REQUESTS .. " for " .. username)

        return nil
    end

    waiting[id] = { username = username, ticks = 0 }
    print(LOG .. "Report: " .. username .. " reported " .. accused .. " (" .. id .. ")")

    return id
end

function KR_Report.poll()
    if not occupied(waiting) then
        return 0
    end

    local ledger = Bridge.readJson(RESULTS)
    local answered = {}
    local delivered = 0

    if type(ledger) == "table" and type(ledger.results) == "table" then
        for _, result in ipairs(ledger.results) do
            local entry = type(result) == "table" and result.id and waiting[result.id]

            if entry then
                local player = Roster.find(entry.username)
                if player then
                    tell(player, result.status)
                    delivered = delivered + 1
                end

                waiting[result.id] = nil
                answered[result.id] = true
            end
        end
    end

    for id, entry in pairs(waiting) do
        entry.ticks = entry.ticks + 1

        if entry.ticks >= ANSWER_TICKS then
            local player = Roster.find(entry.username)
            if player then
                tell(player, "no_answer")
            end

            print(LOG .. "Report: no answer for " .. entry.username .. " after "
                .. ANSWER_TICKS .. " ticks (" .. id .. ")")

            waiting[id] = nil
            answered[id] = true
        end
    end

    if occupied(answered) then
        KR_Report.prune(answered)
    end

    return delivered
end

function KR_Report.prune(answered)
    local file = loadRequests()
    local removed = 0

    for index = #file.requests, 1, -1 do
        local request = file.requests[index]
        if type(request) == "table" and request.id and answered[request.id] then
            table.remove(file.requests, index)
            removed = removed + 1
        end
    end

    if removed > 0 then
        saveRequests(file)
    end

    return removed
end

function KR_Report.onClientCommand(module, command, player, args)
    if module ~= "KnoxRelay" or command ~= "playerReport" then
        return
    end

    local accused = ""
    local body = ""
    if type(args) == "table" then
        accused = tostring(args.accused or "")
        body = tostring(args.body or "")
    end

    if not KR_Report.request(player, accused, body) then
        tell(player, "error")
    end
end

function KR_Report.seed()
    if Bridge.readJson(REQUESTS) then
        return
    end

    Bridge.writeJson(REQUESTS, {
        version = 1,
        updated_at = Bridge.wallStamp(),
        requests = {},
    })
end

function KR_Report.forget(player)
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

return KR_Report
