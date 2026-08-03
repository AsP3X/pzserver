--
-- ZM_PlayerTracker.lua — Writes online player positions to players_live.json
--

local JSON = require("ZM_JSON")
require("ZM_Utils")

ZM_PlayerTracker = {}

local POSITIONS_FILE = "players_live.json"

--- Get ISO 8601 timestamp
local function getTimestamp()
    if getGameTime then
        local gt = getGameTime()
        return string.format("%04d-%02d-%02dT%02d:%02d:%02d",
            gt:getYear(), gt:getMonth() + 1, gt:getDay(),
            gt:getHour(), gt:getMinutes(), 0)
    end
    local cal = Calendar.getInstance()
    return string.format("%04d-%02d-%02dT%02d:%02d:%02d",
        cal:get(Calendar.YEAR), cal:get(Calendar.MONTH) + 1, cal:get(Calendar.DAY_OF_MONTH),
        cal:get(Calendar.HOUR_OF_DAY), cal:get(Calendar.MINUTE), cal:get(Calendar.SECOND))
end

--- Export positions of all online players
function ZM_PlayerTracker.exportPositions()
    local onlinePlayers = getOnlinePlayers()
    if not onlinePlayers then
        return false
    end

    local players = {}
    for i = 0, onlinePlayers:size() - 1 do
        local player = onlinePlayers:get(i)
        if player then
            local entry = {
                username = player:getUsername() or "unknown",
                x = math.floor((player:getX() or 0) * 10) / 10,
                y = math.floor((player:getY() or 0) * 10) / 10,
                z = math.floor(player:getZ() or 0),
                is_dead = player:isDead() or false,
                is_ghost = player:isGhostMode() and player:isGhostMode() or false,
            }
            table.insert(players, entry)
        end
    end

    local data = {
        timestamp = getTimestamp(),
        players = players,
    }

    local ok, jsonStr = pcall(JSON.encode, data)
    if not ok then
        print("[KnoxRelay] ERROR encoding player positions: " .. tostring(jsonStr))
        return false
    end

    if not ZM_Utils.writeRawFile(POSITIONS_FILE, jsonStr) then
        print("[KnoxRelay] ERROR: cannot write player positions")
        return false
    end

    return true
end

return ZM_PlayerTracker
