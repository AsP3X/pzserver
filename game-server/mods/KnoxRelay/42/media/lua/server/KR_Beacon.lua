--
-- KR_Beacon.lua — live player positions for the web map.
--
-- Writes Lua/players_live.json roughly every thirty real seconds. Coordinates
-- are trimmed to one decimal because the map cannot render finer than that and
-- full precision only makes the file bigger.
--

local Codec = require("KR_Codec")
local Bridge = require("KR_Bridge")
local Roster = require("KR_Roster")
local Look = require("KR_Look")

KR_Beacon = {}

local LOG = "[KnoxRelay] "
local FILE = "players_live.json"

local function markOf(player)
    local username = player:getUsername()
    if type(username) ~= "string" or username == "" then
        username = "unknown"
    end

    local x, y, z = 0, 0, 0
    local okx, vx = pcall(function() return player:getX() end)
    local oky, vy = pcall(function() return player:getY() end)
    local okz, vz = pcall(function() return player:getZ() end)
    if okx and type(vx) == "number" then
        x = math.floor(vx * 10) / 10
    end
    if oky and type(vy) == "number" then
        y = math.floor(vy * 10) / 10
    end
    if okz and type(vz) == "number" then
        z = math.floor(vz)
    end

    local appearance = nil
    local oka, look = pcall(Look.of, player)
    if oka then
        appearance = look
    end

    local dead = false
    local ghost = false
    pcall(function() dead = player:isDead() or false end)
    pcall(function() ghost = player:isGhostMode() or false end)

    return {
        username = username,
        x = x,
        y = y,
        z = z,
        is_dead = dead,
        is_ghost = ghost,
        appearance = appearance,
    }
end

--- Write the current position of everyone online.
function KR_Beacon.export()
    local players = Roster.online()
    if not players then
        return false
    end

    local marks = {}
    for _, player in ipairs(players) do
        local ok, mark = pcall(markOf, player)
        if ok and type(mark) == "table" then
            marks[#marks + 1] = mark
        end
    end

    local encoded, body = pcall(Codec.encode, {
        timestamp = Bridge.worldStamp(false),
        players = marks,
    })

    if not encoded then
        print(LOG .. "ERROR encoding player positions: " .. tostring(body))

        return false
    end

    if not Bridge.writeText(FILE, body) then
        print(LOG .. "ERROR: cannot write player positions")

        return false
    end

    return true
end

return KR_Beacon
