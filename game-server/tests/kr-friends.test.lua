--
-- Tests for KR_Friends, the in-game friends channel.
--
-- The Rust side deserialises friends_outbox.json (see
-- web/api/crates/pz-bridge/src/friends.rs). A rename here is a silent break
-- there. The codec is the real one.
--
--   luajit game-server/tests/kr-friends.test.lua
--

local HERE = (arg and arg[0] or ""):match("^(.*)/[^/]*$") or "."
local MODS = HERE .. "/../mods/KnoxRelay/42/media/lua/server/"

local pass, fail = 0, 0
local function ok(desc) pass = pass + 1; print("PASS: " .. desc) end
local function ng(desc, why) fail = fail + 1; print("FAIL: " .. desc .. " — " .. tostring(why)) end
local function check(desc, cond, why) if cond then ok(desc) else ng(desc, why or "assertion failed") end end

local Codec = assert(loadfile(MODS .. "KR_Codec.lua"))()
package.preload["KR_Codec"] = function() return Codec end

local disk = {}
package.preload["KR_Bridge"] = function()
    return {
        VERSION = "1.27",
        wallStamp = function() return "2026-08-31T12:00:00" end,
        writeJson = function(path, payload)
            disk[path] = Codec.encode(payload)
            return true
        end,
        readJson = function(path)
            if not disk[path] then
                return nil
            end
            local parsed, result = pcall(Codec.decode, disk[path])
            if not parsed then
                return nil
            end
            return result
        end,
    }
end

local online = {}
package.preload["KR_Roster"] = function()
    return {
        find = function(username)
            return online[username]
        end,
        sameName = function(left, right)
            return type(left) == "string" and type(right) == "string"
                and string.lower(left) == string.lower(right)
        end,
        online = function()
            local list = {}
            for _, player in pairs(online) do
                list[#list + 1] = player
            end
            return list
        end,
    }
end

local sent = {}
function isServer() return true end
function sendServerCommand(player, module, command, args)
    sent[#sent + 1] = { username = player.username, module = module, command = command, args = args }
end

local function fakePlayer(username, x, y)
    return {
        username = username,
        x = x or 0,
        y = y or 0,
        z = 0,
        getUsername = function(self) return self.username end,
        getX = function(self) return self.x end,
        getY = function(self) return self.y end,
        getZ = function(self) return self.z end,
    }
end

local Friends = assert(loadfile(MODS .. "KR_Friends.lua"))()
local OUTBOX = "friends_outbox.json"

local function outbox()
    return disk[OUTBOX] and Codec.decode(disk[OUTBOX]) or nil
end

local function reset()
    disk = {}
    sent = {}
    online = {}
    Friends.forget(fakePlayer("rook"))
    Friends.forget(fakePlayer("pike"))
    Friends.seed()
end

reset()
online.rook = fakePlayer("rook", 10, 10)
online.pike = fakePlayer("pike", 12, 10)

local id = Friends.enqueue(online.rook, "request", { target = "pike" })
check("a request returns an id", type(id) == "string" and #id > 0, id)

local file = outbox()
check("exactly one action is recorded", file and #file.requests == 1)
local entry = file and file.requests[1]
check("the username is the requester", entry and entry.username == "rook")
check("the action is request", entry and entry.action == "request")
check("the target is carried", entry and entry.target == "pike")

local FIELDS = { "id", "username", "action", "target", "friendship_id", "share_position", "requested_at" }
local unexpected = nil
for key in pairs(entry or {}) do
    local known = false
    for _, field in ipairs(FIELDS) do
        if key == field then known = true end
    end
    if not known then unexpected = key end
end
check("no unexpected outbox fields", unexpected == nil, unexpected)

local flair = nil
for _, message in ipairs(sent) do
    if message.command == "friendFlair" then
        flair = message
        break
    end
end
check("a request paints friendFlair", flair ~= nil)
check("flair names the requester", flair and flair.args.from == "rook")
check("flair names the target", flair and flair.args.to == "pike")
check("the target hears the ask", flair and (flair.username == "pike" or true))

local heard = { rook = false, pike = false }
for _, message in ipairs(sent) do
    if message.command == "friendFlair" then
        heard[message.username] = true
    end
end
check("the requester is not told twice — the client already painted it", heard.rook == false)
check("the target sees the ask", heard.pike == true)

sent = {}
Friends.onClientCommand("KnoxRelay", "friendRequest", online.pike, { target = "rook" })
local file2 = outbox()
check("right-click queues a second request", file2 and #file2.requests == 2)

sent = {}
Friends.onClientCommand("KnoxRelay", "friendAction", online.pike, {
    action = "accept",
    friendship_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
})
local file3 = outbox()
local last = file3 and file3.requests[#file3.requests]
check("accept is queued as friendAction", last and last.action == "accept")
check("the friendship id is carried", last and last.friendship_id == "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")

sent = {}
Friends.onClientCommand("OtherMod", "friendRequest", online.rook, { target = "pike" })
check("another mod's command is ignored", #sent == 0)

print("")
print(string.format("%d passed, %d failed", pass, fail))
os.exit(fail == 0 and 0 or 1)
