--
-- Tests for SP_Codec, the JSON encoder every PZServerPulse heartbeat goes
-- through. It is plain Lua 5.1 with no PZ globals, so it runs outside the game.
--
-- Project Zomboid runs Lua 5.1 (LuaJ), so use luajit — Homebrew's `lua` is 5.4
-- and rejects 5.1-only constructs such as the %z pattern class:
--
--   luajit game-server/tests/sp-codec.test.lua   (exit 0 = all pass)
--
-- Regression guard: the encoder used to write '{' before knowing whether the
-- table had any keys, then append '[]' when it turned out empty — producing
-- `{[]`. Every heartbeat for a player with no wounds carries an empty table,
-- so that made the dashboard's JSON unparseable for almost everyone.
--

local here = arg and arg[0] and arg[0]:match("^(.*)/[^/]-$") or "."
package.path = here .. "/../mods/PZServerPulse/42/media/lua/server/?.lua;" .. package.path

local Codec = require("SP_Codec")

local pass, fail = 0, 0

local function ok(desc)
    pass = pass + 1
    print("PASS: " .. desc)
end

local function ng(desc, detail)
    fail = fail + 1
    print("FAIL: " .. desc .. " — " .. detail)
end

-- assert_encodes <desc> <value> <expected-json>
local function assert_encodes(desc, value, expected)
    local succeeded, actual = pcall(Codec.encode, value)
    if not succeeded then
        ng(desc, "raised: " .. tostring(actual))
    elseif actual == expected then
        ok(desc)
    else
        ng(desc, "got " .. tostring(actual) .. ", want " .. expected)
    end
end

-- assert_raises <desc> <fn>
local function assert_raises(desc, fn)
    if pcall(fn) then
        ng(desc, "no error raised")
    else
        ok(desc)
    end
end

-- --- Scalars ----------------------------------------------------------------

assert_encodes("a string is quoted", "hi", '"hi"')
assert_encodes("quotes and backslashes are escaped", 'a"b\\c', '"a\\"b\\\\c"')
assert_encodes("newline and tab are escaped", "a\nb\tc", '"a\\nb\\tc"')
assert_encodes("C0 control chars become \\u escapes", string.char(1), '"\\u0001"')
assert_encodes("integers stay integers", 12, "12")
assert_encodes("negative integers keep their sign", -3, "-3")
assert_encodes("floats keep their fraction", 0.25, "0.25")
assert_encodes("a whole-numbered float loses its .0", 37.0, "37")
assert_encodes("booleans", true, "true")

-- --- Tables -----------------------------------------------------------------

assert_encodes("consecutive integer keys are an array", { 1, 2, 3 }, "[1,2,3]")
assert_encodes("arrays nest", { { 1 }, { 2 } }, "[[1],[2]]")
assert_encodes("string keys are an object", { a = 1 }, '{"a":1}')
assert_encodes("an empty table is an empty array", {}, "[]")
assert_encodes("an empty table nested in an object", { wounds = {} }, '{"wounds":[]}')
assert_encodes("an empty table nested in an array", { {} }, "[[]]")

-- --- Refusals ---------------------------------------------------------------
-- These raise rather than emit garbage: SP_Bridge catches the error and logs it,
-- which is recoverable, whereas invalid JSON on disk is not.

assert_raises("NaN is refused", function() return Codec.encode(0 / 0) end)
assert_raises("Infinity is refused", function() return Codec.encode(math.huge) end)
assert_raises("-Infinity is refused", function() return Codec.encode(-math.huge) end)
assert_raises("non-string object keys are refused", function() return Codec.encode({ [2] = "x" }) end)
assert_raises("functions are refused", function() return Codec.encode({ a = print }) end)
assert_raises("circular references are refused", function()
    local t = {}
    t.self = t

    return Codec.encode(t)
end)

-- --- A whole heartbeat ------------------------------------------------------
-- Shaped like what SP_Collector actually builds, including the empty tables a
-- healthy player produces, so the PHP side gets a keyed payload it can decode.

local heartbeat = Codec.encode({
    info = { name = 'Bob "the" Survivor', traits = { "Brave" }, kills = 12 },
    moodles = { hunger = 0.25, sick = false },
    health = { overall = 91.3, parts = { Head = { health = 100, wounds = {} } } },
    wounds = {},
})

if heartbeat:sub(1, 1) == "{" and heartbeat:sub(-1) == "}" and not heartbeat:find("{%[%]") then
    ok("a full heartbeat encodes as one JSON object")
else
    ng("a full heartbeat encodes as one JSON object", heartbeat)
end

print("----------------------------------------")
print("Passed: " .. pass .. ", Failed: " .. fail)
os.exit(fail == 0 and 0 or 1)
