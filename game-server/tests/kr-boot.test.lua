--
-- Tests for KR_Boot's load-time event wiring.
--
-- A connecting B42 client still loads media/lua/server. KR_Boot must return
-- before it requires the server stack or hooks Events that do not exist on
-- that side. Missing Events.X.Add also has to be skipped without calling it:
-- pcall still dumps a Kahlua stack trace.
--
-- Project Zomboid runs Lua 5.1:
--   luajit game-server/tests/kr-boot.test.lua
--

local HERE = (arg and arg[0] or ""):match("^(.*)/[^/]*$") or "."
local MODS = HERE .. "/../mods/KnoxRelay/42/media/lua/server/"

local pass, fail = 0, 0
local function ok(desc) pass = pass + 1; print("PASS: " .. desc) end
local function ng(desc, why) fail = fail + 1; print("FAIL: " .. desc .. " — " .. tostring(why)) end
local function check(desc, cond, why) if cond then ok(desc) else ng(desc, why or "assertion failed") end end

local boot = assert(loadfile(MODS .. "KR_Boot.lua"))

isClient = function() return true end
isServer = function() return false end
Events = {}

local loaded, err = pcall(boot)
check("a joining client does not load the server event loop", loaded, err)

print(string.format("\n%d passed, %d failed", pass, fail))
os.exit(fail == 0 and 0 or 1)
