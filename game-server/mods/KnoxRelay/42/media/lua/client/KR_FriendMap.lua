--
-- KR_FriendMap.lua — friend pins on the in-game world map and mini-map.
--
-- Positions come from the website friends graph, not from vanilla RemotePlayers.
-- A pin is only drawn when the friend is sharing, the viewer is allowed to see
-- it, and the server has friend maps switched on. Admins still see everyone
-- on the website staff map; that path never reads this file.
--

KR_FriendMap = {}

local LOG = "[KnoxRelay] "
local pins = {}
local hooked = false

local function number(value)
    if type(value) == "number" then
        return value
    end
    return nil
end

function KR_FriendMap.apply(friends)
    local nextPins = {}
    if type(friends) == "table" then
        for _, entry in ipairs(friends) do
            if type(entry) == "table" and entry.their_share_position ~= false then
                local x = number(entry.x)
                local y = number(entry.y)
                local name = entry.username
                if x and y and type(name) == "string" and name ~= "" then
                    nextPins[#nextPins + 1] = {
                        username = name,
                        x = x,
                        y = y,
                        z = number(entry.z) or 0,
                        online = entry.online == true,
                    }
                end
            end
        end
    end
    pins = nextPins
end

function KR_FriendMap.pins()
    return pins
end

local function colour(online)
    if online then
        return 0.55, 0.69, 0.29
    end
    return 0.42, 0.43, 0.38
end

--- Draw friend dots on a UIWorldMap-backed panel.
--
-- `named` writes the survivor's name under the pin. The mini-map is too small
-- for that, so the world map is the only place names appear.
function KR_FriendMap.paint(mapUI, named)
    if not mapUI then
        return 0
    end
    local apiType = type(mapUI.mapAPI)
    if apiType ~= "table" and apiType ~= "userdata" then
        return 0
    end

    local api = mapUI.mapAPI
    local width = mapUI:getWidth() or 0
    local height = mapUI:getHeight() or 0
    if width < 8 or height < 8 then
        return 0
    end

    local drawn = 0
    for i = 1, #pins do
        local pin = pins[i]
        local ok, sx, sy = pcall(function()
            return api:worldToUIX(pin.x, pin.y), api:worldToUIY(pin.x, pin.y)
        end)
        if ok and type(sx) == "number" and type(sy) == "number"
            and sx > -12 and sy > -12 and sx < width + 12 and sy < height + 12
        then
            local r, g, b = colour(pin.online)
            pcall(function()
                mapUI:drawRect(sx - 4, sy - 4, 8, 8, 0.95, r, g, b)
            end)
            if named then
                pcall(function()
                    mapUI:drawTextCentre(pin.username, sx, sy + 6, r, g, b, 1, UIFont.Small)
                end)
            end
            drawn = drawn + 1
        end
    end

    return drawn
end

local function hookRender(classTable, named)
    if type(classTable) ~= "table" or type(classTable.render) ~= "function" then
        if type(classTable) == "table" then
            classTable.render = function(self)
                KR_FriendMap.paint(self, named)
            end
            return true
        end
        return false
    end

    local previous = classTable.render
    classTable.render = function(self)
        previous(self)
        KR_FriendMap.paint(self, named)
    end
    return true
end

function KR_FriendMap.hook()
    if hooked then
        return
    end

    local world = hookRender(ISWorldMap, true)
    local mini = hookRender(ISMiniMapInner, false)
    if world or mini then
        hooked = true
        print(LOG .. "Friend map: hooked world=" .. tostring(world) .. " mini=" .. tostring(mini))
    end
end

local function onFriendsState(module, command, args)
    if module ~= "KnoxRelay" or command ~= "friendsState" then
        return
    end
    if type(args) ~= "table" then
        return
    end
    KR_FriendMap.apply(args.friends)
end

pcall(function()
    Events.OnServerCommand.Add(onFriendsState)
    Events.OnGameStart.Add(KR_FriendMap.hook)
end)
KR_FriendMap.hook()

return KR_FriendMap
