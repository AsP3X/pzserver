--
-- Tests for KR_FriendMap, the in-game friend pins.
--
--   luajit game-server/tests/kr-friend-map.test.lua
--

local HERE = (arg and arg[0] or ""):match("^(.*)/[^/]*$") or "."
local CLIENT = HERE .. "/../mods/KnoxRelay/42/media/lua/client/"

local pass, fail = 0, 0
local function ok(desc) pass = pass + 1; print("PASS: " .. desc) end
local function ng(desc, why) fail = fail + 1; print("FAIL: " .. desc .. " — " .. tostring(why)) end
local function check(desc, cond, why) if cond then ok(desc) else ng(desc, why or "assertion failed") end end

Events = { OnServerCommand = { Add = function() end }, OnGameStart = { Add = function() end } }
UIFont = { Small = "small" }

local Map = assert(loadfile(CLIENT .. "KR_FriendMap.lua"))()

Map.apply({
    { username = "pike", their_share_position = true, x = 1000, y = 2000, z = 0, online = true },
    { username = "rook", their_share_position = false, x = 10, y = 10, z = 0, online = true },
    { username = "ghost", their_share_position = true, online = true },
})

local pins = Map.pins()
check("shared pins are kept", #pins == 1, #pins)
check("the sharing friend is pike", pins[1] and pins[1].username == "pike")
check("hidden friends are dropped", pins[1] and pins[1].username ~= "rook")

local drawn = {}
local mapUI = {
    mapAPI = {
        worldToUIX = function(_, x, _y) return x / 10 end,
        worldToUIY = function(_, _x, y) return y / 10 end,
    },
    getWidth = function() return 400 end,
    getHeight = function() return 300 end,
    drawRect = function(_, x, y, w, h)
        drawn[#drawn + 1] = { x = x, y = y, w = w, h = h }
    end,
    drawTextCentre = function(_, text)
        drawn[#drawn + 1] = { text = text }
    end,
}

local count = Map.paint(mapUI, true)
check("a visible pin is painted", count == 1, count)
check("the pin is named", drawn[2] and drawn[2].text == "pike", drawn[2] and drawn[2].text)

Map.apply(nil)
check("a missing list clears pins", #Map.pins() == 0)

ISWorldMap = {
    render = function(self)
        self.worldRan = true
    end,
}
Map.hook()
local worldUI = {
    worldRan = false,
    mapAPI = {
        worldToUIX = function() return 20 end,
        worldToUIY = function() return 20 end,
    },
    getWidth = function() return 400 end,
    getHeight = function() return 300 end,
    drawRect = function() end,
    drawTextCentre = function() end,
}
Map.apply({
    { username = "pike", their_share_position = true, x = 1000, y = 2000, z = 0, online = true },
})
ISWorldMap.render(worldUI)
check("vanilla world render still runs", worldUI.worldRan == true)
local wrappedWorld = ISWorldMap.render
Map.hook()
check("world is not wrapped twice", ISWorldMap.render == wrappedWorld)

ISMiniMapInner = {
    render = function(self)
        self.miniRan = true
    end,
}
Map.hook()
local miniUI = {
    miniRan = false,
    mapAPI = {
        worldToUIX = function() return 20 end,
        worldToUIY = function() return 20 end,
    },
    getWidth = function() return 400 end,
    getHeight = function() return 300 end,
    drawRect = function() end,
    drawTextCentre = function() end,
}
ISMiniMapInner.render(miniUI)
check("mini-map hooks on a later try", miniUI.miniRan == true)

print("")
print("Passed: " .. pass .. ", Failed: " .. fail)
if fail > 0 then os.exit(1) end
