--
-- KR_Holdings.lua — claimed safehouses and the factions that hold them.
--
-- Written to Lua/holdings.json so the dashboard can draw claims on the map
-- and tell who is entitled to be inside one. The same file feeds raid
-- detection, which needs the member list to know who counts as an intruder.
--
-- Both lists come from static Java collections that only exist once the world
-- has loaded, so every reach into them is guarded.
--

local Codec = require("KR_Codec")
local Bridge = require("KR_Bridge")

KR_Holdings = {}

local LOG = "[KnoxRelay] "
local FILE = "holdings.json"

--- Copy a Java ArrayList of strings into a Lua list.
local function names(list)
    local copied = {}

    if not list then
        return copied
    end

    local ok, size = pcall(function() return list:size() end)
    if not ok or not size then
        return copied
    end

    for index = 0, size - 1 do
        local entry = list:get(index)
        if entry then
            copied[#copied + 1] = tostring(entry)
        end
    end

    return copied
end

--- Every claimed safehouse as a rectangle plus its membership.
local function safehouses()
    local claims = {}

    if not SafeHouse or not SafeHouse.getSafehouseList then
        return claims
    end

    local ok, list = pcall(SafeHouse.getSafehouseList)
    if not ok or not list then
        return claims
    end

    for index = 0, list:size() - 1 do
        local house = list:get(index)
        if house then
            local built = pcall(function()
                local x, y = house:getX(), house:getY()

                claims[#claims + 1] = {
                    title = house:getTitle() or "Safehouse",
                    owner = house:getOwner() or nil,
                    members = names(house:getPlayers()),
                    x = x,
                    y = y,
                    -- x2/y2 are exclusive, which matches how the dashboard
                    -- already draws safe zones.
                    x2 = house:getX2(),
                    y2 = house:getY2(),
                    w = house:getW(),
                    h = house:getH(),
                }
            end)

            if not built then
                print(LOG .. "WARNING: skipped an unreadable safehouse at index " .. index)
            end
        end
    end

    return claims
end

--- Factions and their rosters.
local function factions()
    local groups = {}

    if not Faction or not Faction.getFactions then
        return groups
    end

    local ok, list = pcall(Faction.getFactions)
    if not ok or not list then
        return groups
    end

    for index = 0, list:size() - 1 do
        local faction = list:get(index)
        if faction then
            pcall(function()
                groups[#groups + 1] = {
                    name = faction:getName() or "unnamed",
                    tag = faction:getTag() or nil,
                    owner = faction:getOwner() or nil,
                    members = names(faction:getPlayers()),
                }
            end)
        end
    end

    return groups
end

--- Write the current claims. Returns true when the file was written.
function KR_Holdings.export()
    local encoded, body = pcall(Codec.encode, {
        timestamp = Bridge.worldStamp(false),
        safehouses = safehouses(),
        factions = factions(),
    })

    if not encoded then
        print(LOG .. "ERROR encoding holdings: " .. tostring(body))

        return false
    end

    return Bridge.writeText(FILE, body)
end

return KR_Holdings
