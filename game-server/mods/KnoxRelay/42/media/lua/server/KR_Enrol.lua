--
-- KR_Enrol.lua — the /account register channel.
--
-- Every other bridge module answers the panel. This one asks it: a player runs
-- /account register in game, the mod records who, and the website answers with
-- a six-character code that finishes sign-up in a browser. The direction is
-- reversed but the idiom is the one KR_Orders already uses — entries keyed by
-- id, and an id that already has a result is never acted on twice.
--
--   account_links.json          we write     one entry per run of the command
--   account_link_results.json   we read      the panel's answer, keyed by id
--
-- A code rather than an email typed in game, because whatever goes through the
-- chat channel also lands in the server log where every log reader can see it.
-- The code comes back to exactly one player, through a server command to that
-- client alone, and never touches a chat channel anyone else can read.
--
-- Requests are pruned once answered. The panel only ever reads this file, so
-- if nothing prunes it, it grows for the life of the server.
--

local Bridge = require("KR_Bridge")
local Roster = require("KR_Roster")

KR_Enrol = {}

local LOG = "[KnoxRelay] "
local REQUESTS = "account_links.json"
local RESULTS = "account_link_results.json"

--- Runs of the command still waiting on the panel, keyed by request id.
local waiting = {}

--- Ticks a request waits before the player is told nobody answered. The
--- heartbeat is roughly 2.5 real seconds, so this is about half a minute —
--- the panel aims to answer within five.
local ANSWER_TICKS = 12

--- Ceiling on the request file, in case the panel stops answering entirely and
--- pruning therefore never happens. Old entries go first.
local REQUEST_LIMIT = 100

--- Bumps per run so two commands in the same second cannot collide.
local runs = 0

--------------------------------------------------------------------------
-- Identity
--------------------------------------------------------------------------

--- An id no other run will produce.
---
--- The stamp alone is not enough: two players registering inside the same
--- second would share one, and the second of them would be skipped forever as
--- an id that already has a result.
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

--------------------------------------------------------------------------
-- The request file
--------------------------------------------------------------------------

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

--------------------------------------------------------------------------
-- Talking to the one player
--------------------------------------------------------------------------

--- Send an answer to a single client. Never a chat channel: the code is worth
--- an account to whoever reads it.
local function tell(player, status, code, expiresAt)
    if not player then
        return false
    end

    if not isServer() then
        return false
    end

    local sent = pcall(function()
        sendServerCommand(player, "KnoxRelay", "accountReply", {
            status = status,
            code = code,
            expires_at = expiresAt,
        })
    end)

    return sent
end

--------------------------------------------------------------------------
-- Running the command
--------------------------------------------------------------------------

--- Record a run of /account register. Returns the id, or nil if the write
--- failed and the player should be told to try again.
function KR_Enrol.request(player)
    if not player then
        return nil
    end

    local username = player:getUsername()
    if not username or username == "" then
        print(LOG .. "Enrol: refusing a request from a player with no username")

        return nil
    end

    -- One live request per character. Asking twice replaces the first rather
    -- than leaving two ids outstanding for the same person.
    for id, entry in pairs(waiting) do
        if entry.username == username then
            waiting[id] = nil
        end
    end

    local steamId = nil
    local gotSteam, value = pcall(function()
        return player:getSteamID()
    end)
    if gotSteam and value and tostring(value) ~= "0" then
        steamId = tostring(value)
    end

    local id = mintId(username)
    local file = loadRequests()

    -- Drop any earlier unanswered run by this character, for the same reason.
    for index = #file.requests, 1, -1 do
        local request = file.requests[index]
        if type(request) == "table" and request.username == username then
            table.remove(file.requests, index)
        end
    end

    file.requests[#file.requests + 1] = {
        id = id,
        username = username,
        steam_id = steamId,
        requested_at = Bridge.wallStamp(),
    }

    if not saveRequests(file) then
        print(LOG .. "Enrol: could not write " .. REQUESTS .. " for " .. username)

        return nil
    end

    waiting[id] = { username = username, ticks = 0 }
    print(LOG .. "Enrol: registration requested by " .. username .. " (" .. id .. ")")

    return id
end

--------------------------------------------------------------------------
-- The panel's answer
--------------------------------------------------------------------------

--- Does this table hold anything at all?
---
--- Spelled out rather than using next(), which PZ's Lua runtime does not
--- provide — reaching for it took the whole vitals panel down in 1.8.
local function occupied(table_)
    for _ in pairs(table_) do
        return true
    end

    return false
end

--- Deliver whatever has been answered and prune the requests behind it.
---
--- Returns how many answers were handed to a player.
function KR_Enrol.poll()
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
                    tell(player, result.status, result.code, result.expires_at)
                    delivered = delivered + 1
                else
                    -- They left before the answer landed. The code is still
                    -- good on the website; there is just nobody to show it to.
                    print(LOG .. "Enrol: " .. entry.username .. " went offline before their answer arrived")
                end

                waiting[result.id] = nil
                answered[result.id] = true
            end
        end
    end

    -- Anything still waiting is one tick older, and eventually gives up.
    for id, entry in pairs(waiting) do
        entry.ticks = entry.ticks + 1

        if entry.ticks >= ANSWER_TICKS then
            local player = Roster.find(entry.username)
            if player then
                tell(player, "no_answer")
            end

            print(LOG .. "Enrol: no answer for " .. entry.username .. " after "
                .. ANSWER_TICKS .. " ticks (" .. id .. ")")

            waiting[id] = nil
            answered[id] = true
        end
    end

    if occupied(answered) then
        KR_Enrol.prune(answered)
    end

    return delivered
end

--- Take answered ids out of the request file. The panel never deletes from it.
function KR_Enrol.prune(answered)
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

--------------------------------------------------------------------------
-- Wiring
--------------------------------------------------------------------------

--- A client ran the command. The client half only reads the chat box; every
--- decision, and the username the request is recorded under, is taken here
--- from the server's own player object.
function KR_Enrol.onClientCommand(module, command, player, _args)
    if module ~= "KnoxRelay" or command ~= "accountRegister" then
        return
    end

    if not KR_Enrol.request(player) then
        tell(player, "error")
    end
end

--- Clear a character's outstanding request when they disconnect, so poll()
--- stops looking for somebody who is not there.
--- Write an empty request file if the panel has never seen one.
function KR_Enrol.seed()
    if Bridge.readJson(REQUESTS) then
        return
    end

    Bridge.writeJson(REQUESTS, {
        version = 1,
        updated_at = Bridge.wallStamp(),
        requests = {},
    })
end

function KR_Enrol.forget(player)
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

return KR_Enrol
