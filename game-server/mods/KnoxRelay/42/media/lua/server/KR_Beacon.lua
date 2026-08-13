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

--- Write the current position of everyone online.
function KR_Beacon.export()
    local players = Roster.online()
    if not players then
        return false
    end

    local marks = {}
    for _, player in ipairs(players) do
        marks[#marks + 1] = {
            username = player:getUsername() or "unknown",
            x = math.floor((player:getX() or 0) * 10) / 10,
            y = math.floor((player:getY() or 0) * 10) / 10,
            z = math.floor(player:getZ() or 0),
            is_dead = player:isDead() or false,
            is_ghost = player:isGhostMode() or false,
            appearance = Look.of(player),
        }
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
