--
-- KR_MapEdit.lua — world-edit notices from players, for the isometric map.
--
-- The panel paints from save files, which often lag the action by a chunk
-- write. Each client reports a door, curtain or sheet as it happens. This
-- file appends those to Lua/world_edits.json. When staff have debug on, it
-- also puts the pending count above the player who did it, and "PAINT" when
-- the panel actually starts a job.
--

local Bridge = require("KR_Bridge")
local Roster = require("KR_Roster")

KR_MapEdit = {}

local LOG = "[KnoxRelay] "
local EDITS = "world_edits.json"
local STATUS = "map_tile_status.json"
local LIMIT = 200
local seq = 0
local lastFireId = ""

local function loadEdits()
    local file = Bridge.readJson(EDITS)
    if not file or type(file.edits) ~= "table" then
        return { edits = {} }
    end

    return file
end

local function saveEdits(file)
    while #file.edits > LIMIT do
        table.remove(file.edits, 1)
    end
    file.updated_at = Bridge.wallStamp()
    Bridge.writeJson(EDITS, file)
end

local function debugOn()
    local status = Bridge.readJson(STATUS)
    return status and status.debug == true
end

local function pulse(player, count, fired)
    if not player or not isServer() then
        return
    end

    pcall(function()
        sendServerCommand(player, "KnoxRelay", "mapEditPulse", {
            count = count,
            fired = fired and true or false,
        })
    end)
end

function KR_MapEdit.record(player, x, y, kind)
    if type(x) ~= "number" or type(y) ~= "number" then
        return
    end

    seq = seq + 1
    local username = "unknown"
    if player and player.getUsername then
        username = player:getUsername() or username
    end

    local file = loadEdits()
    file.edits[#file.edits + 1] = {
        id = username .. "-" .. Bridge.wallStamp() .. "-" .. tostring(seq),
        username = username,
        x = math.floor(x),
        y = math.floor(y),
        kind = tostring(kind or "edit"),
    }
    saveEdits(file)

    if debugOn() then
        pulse(player, seq, false)
    end
end

function KR_MapEdit.onClientCommand(module, command, player, args)
    if module ~= "KnoxRelay" or command ~= "worldEdit" then
        return
    end

    args = args or {}
    KR_MapEdit.record(player, tonumber(args.x), tonumber(args.y), args.kind)
end

--- The panel writes a new fire_id when a job starts. Tell those players.
function KR_MapEdit.poll()
    local status = Bridge.readJson(STATUS)
    if not status or not status.debug then
        return
    end

    local fireId = tostring(status.fire_id or "")
    if fireId == "" or fireId == lastFireId then
        return
    end
    lastFireId = fireId

    local names = {}
    if type(status.fire_usernames) == "table" then
        for index = 1, #status.fire_usernames do
            local name = status.fire_usernames[index]
            if type(name) == "string" then
                names[name] = true
            end
        end
    end

    local players = Roster.online()
    if not players then
        return
    end

    for index = 1, #players do
        local player = players[index]
        local username = player.getUsername and player:getUsername()
        if username and names[username] then
            pulse(player, 0, true)
        end
    end
end

return KR_MapEdit
