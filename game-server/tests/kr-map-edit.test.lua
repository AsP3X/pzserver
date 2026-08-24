--
-- Tests for KR_MapEdit client wrappers.
--
-- Closing a curtain calls ISOpenCloseCurtain:complete. If we wrap the name
-- after the queue has already copied the function, the action never reports.
-- This file copies complete onto a fake instance first, then loads the wrap
-- and checks a later complete sends worldEdit.
--
--   luajit game-server/tests/kr-map-edit.test.lua
--

local HERE = (arg and arg[0] or ""):match("^(.*)/[^/]*$") or "."
local CLIENT = HERE .. "/../mods/KnoxRelay/42/media/lua/client/"

local pass, fail = 0, 0
local function ok(desc) pass = pass + 1; print("PASS: " .. desc) end
local function ng(desc, why) fail = fail + 1; print("FAIL: " .. desc .. " — " .. tostring(why)) end
local function check(desc, cond, why) if cond then ok(desc) else ng(desc, why or "assertion failed") end end

local handlers = {}
Events = setmetatable({}, {
    __index = function(self, name)
        handlers[name] = handlers[name] or {}
        local slot = {
            Add = function(fn) table.insert(handlers[name], fn) end,
            Remove = function(fn)
                for index, existing in ipairs(handlers[name]) do
                    if existing == fn then
                        table.remove(handlers[name], index)
                        break
                    end
                end
            end,
        }
        rawset(self, name, slot)
        return slot
    end,
})

local sent = {}
function sendClientCommand(player, module, command, args)
    sent[#sent + 1] = { player = player, module = module, command = command, args = args }
end

function getSpecificPlayer() return nil end

ISOpenCloseCurtain = {
    complete = function() return true end,
}

dofile(CLIENT .. "KR_MapEdit.lua")

for _, fn in ipairs(handlers.OnGameStart or {}) do
    fn()
end
for _, fn in ipairs(handlers.OnTick or {}) do
    fn()
end

local action = {
    character = { getUsername = function() return "AsP3X" end },
    item = {
        getSquare = function()
            return { getX = function() return 11001 end, getY = function() return 10010 end }
        end,
    },
}
local okComplete = ISOpenCloseCurtain.complete(action)
check("wrapped complete still returns true", okComplete == true)
check("worldEdit was sent", #sent == 1)
check("command is worldEdit", sent[1] and sent[1].command == "worldEdit")
check("kind is curtain", sent[1] and sent[1].args.kind == "curtain")
check("coords are floored squares", sent[1] and sent[1].args.x == 11001 and sent[1].args.y == 10010)

print(string.format("Passed: %d, Failed: %d", pass, fail))
if fail > 0 then os.exit(1) end
