--
-- Tests for KR_Report, the /report channel.
--
-- The Rust side deserialises report_requests.json (see
-- web/api/crates/pz-bridge/src/tickets.rs). A rename here is a silent break
-- there. The codec is the real one.
--
--   luajit game-server/tests/kr-report.test.lua
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
        VERSION = "1.18",
        wallStamp = function() return "2026-08-13T09:00:00" end,
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
    return { find = function(username) return online[username] end }
end

next = nil

local sent = {}
function isServer() return true end
function sendServerCommand(player, module, command, args)
    sent[#sent + 1] = { username = player.username, module = module, command = command, args = args }
end
function ZombRand() return 1 end

local function fakePlayer(username)
    return {
        username = username,
        getUsername = function(self) return self.username end,
    }
end

local Report = assert(loadfile(MODS .. "KR_Report.lua"))()
local REQUESTS = "report_requests.json"
local RESULTS = "report_results.json"

local function requestFile()
    return disk[REQUESTS] and Codec.decode(disk[REQUESTS]) or nil
end

local function reset()
    disk = {}
    sent = {}
    online = {}
    Report.forget(fakePlayer("rook"))
    Report.forget(fakePlayer("pike"))
end

reset()
local id = Report.request(fakePlayer("rook"), "pike", "he raided my base during safe hours")
check("a run returns an id", type(id) == "string" and #id > 0, id)

local file = requestFile()
check("exactly one request is recorded", file and #file.requests == 1)
local entry = file and file.requests[1]
check("the username is the reporter", entry and entry.username == "rook")
check("the accused is carried", entry and entry.accused == "pike")
check("the body is carried", entry and entry.body == "he raided my base during safe hours")

local FIELDS = { "id", "username", "accused", "body", "requested_at" }
local unexpected = nil
for key in pairs(entry or {}) do
    local known = false
    for _, field in ipairs(FIELDS) do
        if key == field then known = true end
    end
    if not known then unexpected = key end
end
check("no field the Rust side does not know about", unexpected == nil, unexpected)

reset()
Report.request(fakePlayer("rook"), "pike", "first")
Report.request(fakePlayer("rook"), "wren", "second report with enough detail")
file = requestFile()
check("a second run replaces the first", file and #file.requests == 1)
check("the later accused is kept", file and file.requests[1].accused == "wren")

reset()
id = Report.request(fakePlayer("rook"), "pike", "enough detail to act on this")
online.rook = fakePlayer("rook")
disk[RESULTS] = Codec.encode({
    version = 1,
    updated_at = "2026-08-13T09:00:01",
    results = { { id = id, username = "rook", status = "filed", at = "now" } },
})
local delivered = Report.poll()
check("an answer is handed to the player", delivered == 1, delivered)
check("on the reportReply command", sent[1] and sent[1].command == "reportReply")
check("with the filed status", sent[1] and sent[1].args.status == "filed")
file = requestFile()
check("the answered request is pruned", file and #file.requests == 0)

print("")
print(string.format("%d passed, %d failed", pass, fail))
if fail > 0 then os.exit(1) end
