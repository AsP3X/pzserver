--
-- Tests for KR_Enrol, the /account register channel.
--
-- This is the one module whose file format is consumed by something outside
-- the mod, so the assertions are about the JSON as much as the behaviour: the
-- Rust side deserialises `account_links.json` into a fixed set of serde fields
-- (see web/api/crates/pz-bridge/src/links.rs) and a rename here is a silent
-- break there. The codec is the real one and the fake bridge round-trips
-- through it, so pruning is exercised against text that was genuinely encoded
-- and decoded rather than a table handed straight back.
--
-- Project Zomboid runs Lua 5.1, so run this with luajit, not luaXX:
--   luajit game-server/tests/kr-enrol.test.lua   (exit 0 = all pass)
--

local HERE = (arg and arg[0] or ""):match("^(.*)/[^/]*$") or "."
local MODS = HERE .. "/../mods/KnoxRelay/42/media/lua/server/"

local pass, fail = 0, 0
local function ok(desc) pass = pass + 1; print("PASS: " .. desc) end
local function ng(desc, why) fail = fail + 1; print("FAIL: " .. desc .. " — " .. tostring(why)) end
local function check(desc, cond, why) if cond then ok(desc) else ng(desc, why or "assertion failed") end end

local Codec = assert(loadfile(MODS .. "KR_Codec.lua"))()
package.preload["KR_Codec"] = function() return Codec end

--------------------------------------------------------------------------
-- A disk that is really just a table of JSON strings
--------------------------------------------------------------------------

local disk = {}
local stamp = "2026-08-13T09:00:00"
local writeFails = false

package.preload["KR_Bridge"] = function()
    return {
        VERSION = "1.18",
        wallStamp = function() return stamp end,
        worldStamp = function() return "1993-07-09T12:00:00" end,
        writeJson = function(path, payload)
            if writeFails then
                return false
            end
            -- Encode for real: a table the codec chokes on must fail here too.
            disk[path] = Codec.encode(payload)

            return true
        end,
        -- Mirrors the real readJson: a file that will not parse is nil, not a
        -- raise, so callers can treat "no data" and "bad data" the same way.
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
        find = function(username) return online[username] end,
    }
end

--------------------------------------------------------------------------
-- PZ globals
--------------------------------------------------------------------------

-- Not a stub: a removal. PZ's Lua runtime does not expose next(), and version
-- 1.8 lost the entire vitals panel to an empty-table check that used it. The
-- failure is silent on a live server — the pcall guard swallows it and the
-- export returns defaults — so it has to be loud here. pairs() is a separate C
-- function and keeps working without it.
next = nil

local sent = {}

function isServer() return true end

function sendServerCommand(player, module, command, args)
    sent[#sent + 1] = {
        username = player.username,
        module = module,
        command = command,
        args = args,
    }
end

local rolls = 0
function ZombRand(ceiling)
    rolls = rolls + 1

    return (rolls * 7919) % ceiling
end

local function fakePlayer(username, steamId)
    return {
        username = username,
        getUsername = function(self) return self.username end,
        getSteamID = function() return steamId end,
    }
end

--------------------------------------------------------------------------
-- Module under test
--------------------------------------------------------------------------

local Enrol = assert(loadfile(MODS .. "KR_Enrol.lua"))()

local REQUESTS = "account_links.json"
local RESULTS = "account_link_results.json"

local function requestFile()
    return disk[REQUESTS] and Codec.decode(disk[REQUESTS]) or nil
end

--- Put an answer on disk the way the panel would.
local function answer(entries)
    disk[RESULTS] = Codec.encode({
        version = 1,
        updated_at = "2026-08-13T09:00:01Z",
        results = entries,
    })
end

local function reset()
    disk = {}
    sent = {}
    online = {}
    writeFails = false
    stamp = "2026-08-13T09:00:00"
    -- Drop anything left waiting from the previous case.
    Enrol.forget(fakePlayer("rook"))
    Enrol.forget(fakePlayer("pike"))
    Enrol.forget(fakePlayer("wren"))
end

--------------------------------------------------------------------------
-- Writing the request
--------------------------------------------------------------------------

reset()
local rookId = Enrol.request(fakePlayer("rook", "76561198000000001"))

check("a run of the command returns an id", type(rookId) == "string" and #rookId > 0, rookId)
check("the request file is written", disk[REQUESTS] ~= nil)

local file = requestFile()
check("the file is an object with a requests array", type(file) == "table" and type(file.requests) == "table")
check("version is stamped", file and file.version == 1, file and file.version)
check("exactly one request is recorded", file and #file.requests == 1, file and #file.requests)

local entry = file and file.requests[1]
check("the id matches the one returned", entry and entry.id == rookId)
check("the username is carried", entry and entry.username == "rook", entry and entry.username)
check("the steam id is carried", entry and entry.steam_id == "76561198000000001", entry and entry.steam_id)
check("requested_at is stamped", entry and entry.requested_at == stamp, entry and entry.requested_at)

-- The Rust side names these exactly. A rename here breaks deserialisation there.
local FIELDS = { "id", "username", "steam_id", "requested_at" }
local unexpected = nil
for key in pairs(entry or {}) do
    local known = false
    for _, field in ipairs(FIELDS) do
        if key == field then known = true end
    end
    if not known then unexpected = key end
end
check("no field the Rust side does not know about", unexpected == nil, unexpected)

--------------------------------------------------------------------------
-- Steam is optional
--------------------------------------------------------------------------

reset()
Enrol.request(fakePlayer("rook", "0"))
check("a steam id of 0 is left out entirely", (requestFile().requests[1].steam_id) == nil)

reset()
Enrol.request(fakePlayer("rook", nil))
check("a missing steam id is left out entirely", (requestFile().requests[1].steam_id) == nil)

--------------------------------------------------------------------------
-- Identity
--------------------------------------------------------------------------

reset()
local firstId = Enrol.request(fakePlayer("rook"))
local secondId = Enrol.request(fakePlayer("pike"))
check("two characters in the same second get different ids", firstId ~= secondId, firstId)
check("both are recorded", #requestFile().requests == 2, #requestFile().requests)

reset()
Enrol.request(fakePlayer("rook"))
local replacement = Enrol.request(fakePlayer("rook"))
local afterReplace = requestFile()
check("asking twice replaces rather than stacks", #afterReplace.requests == 1, #afterReplace.requests)
check("the surviving entry is the newer one", afterReplace.requests[1].id == replacement)

--------------------------------------------------------------------------
-- A write that fails
--------------------------------------------------------------------------

reset()
writeFails = true
check("a failed write reports no id", Enrol.request(fakePlayer("rook")) == nil)

--------------------------------------------------------------------------
-- The answer
--------------------------------------------------------------------------

reset()
online["rook"] = fakePlayer("rook")
local issuedId = Enrol.request(fakePlayer("rook"))
answer({
    {
        id = issuedId,
        username = "rook",
        status = "issued",
        code = "3ACQ2R",
        expires_at = "2026-08-13T09:30:00Z",
        at = "2026-08-13T09:00:01Z",
    },
})

local delivered = Enrol.poll()

check("the answer is delivered", delivered == 1, delivered)
check("exactly one command went out", #sent == 1, #sent)
check("it went to the right player", sent[1] and sent[1].username == "rook")
check("on the mod's own channel", sent[1] and sent[1].module == "KnoxRelay")
check("as an accountReply", sent[1] and sent[1].command == "accountReply")
check("carrying the status", sent[1] and sent[1].args.status == "issued")
check("carrying the code", sent[1] and sent[1].args.code == "3ACQ2R")
check("carrying the expiry", sent[1] and sent[1].args.expires_at == "2026-08-13T09:30:00Z")
check("the answered request is pruned", #requestFile().requests == 0, #requestFile().requests)

-- Polling again must not deliver the same answer twice.
sent = {}
check("a second poll delivers nothing", Enrol.poll() == 0)
check("and sends nothing", #sent == 0, #sent)

--------------------------------------------------------------------------
-- Rejection
--------------------------------------------------------------------------

reset()
online["pike"] = fakePlayer("pike")
local takenId = Enrol.request(fakePlayer("pike"))
answer({
    { id = takenId, username = "pike", status = "already_registered", at = "2026-08-13T09:00:01Z" },
})
Enrol.poll()

check("a rejection reaches the player", #sent == 1, #sent)
check("with the status", sent[1] and sent[1].args.status == "already_registered")
check("and no code", sent[1] and sent[1].args.code == nil)
check("and is pruned like any other answer", #requestFile().requests == 0)

--------------------------------------------------------------------------
-- Answers we did not ask for
--------------------------------------------------------------------------

reset()
online["rook"] = fakePlayer("rook")
Enrol.request(fakePlayer("rook"))
answer({
    { id = "some-other-server", username = "wren", status = "issued", code = "AAAAAA", at = "x" },
})
Enrol.poll()

check("an id we never asked about is ignored", #sent == 0, #sent)
check("and our own request survives", #requestFile().requests == 1)

--------------------------------------------------------------------------
-- The player left before the answer landed
--------------------------------------------------------------------------

reset()
local goneId = Enrol.request(fakePlayer("wren"))
answer({ { id = goneId, username = "wren", status = "issued", code = "ZZZZZZ", at = "x" } })
local handled = Enrol.poll()

check("nothing is sent to an offline player", #sent == 0, #sent)
check("and it does not count as delivered", handled == 0, handled)
check("but the request is still pruned", #requestFile().requests == 0)

--------------------------------------------------------------------------
-- Nobody answered
--------------------------------------------------------------------------

reset()
online["rook"] = fakePlayer("rook")
Enrol.request(fakePlayer("rook"))

for _ = 1, 11 do
    Enrol.poll()
end
check("no complaint before the timeout", #sent == 0, #sent)
check("and the request is still outstanding", #requestFile().requests == 1)

Enrol.poll()
check("the twelfth tick gives up", #sent == 1, #sent)
check("telling the player nobody answered", sent[1] and sent[1].args.status == "no_answer")
check("and clearing the request", #requestFile().requests == 0)

sent = {}
Enrol.poll()
check("it only says so once", #sent == 0, #sent)

--------------------------------------------------------------------------
-- Nothing to do
--------------------------------------------------------------------------

reset()
check("polling with nothing outstanding is a no-op", Enrol.poll() == 0)

reset()
online["rook"] = fakePlayer("rook")
Enrol.request(fakePlayer("rook"))
check("a missing results file is not an error", Enrol.poll() == 0)
disk[RESULTS] = "{}"
check("a results file with no results array is not an error", Enrol.poll() == 0)
disk[RESULTS] = "not json at all"
local survived = pcall(Enrol.poll)
check("a corrupt results file does not raise", survived)

--------------------------------------------------------------------------
-- Disconnecting
--------------------------------------------------------------------------

reset()
online["rook"] = fakePlayer("rook")
local droppedId = Enrol.request(fakePlayer("rook"))
Enrol.forget(fakePlayer("rook"))
answer({ { id = droppedId, username = "rook", status = "issued", code = "QQQQQQ", at = "x" } })
Enrol.poll()
check("an answer for a forgotten request is not delivered", #sent == 0, #sent)

--------------------------------------------------------------------------

print("")
print(string.format("%d passed, %d failed", pass, fail))
os.exit(fail == 0 and 0 or 1)
