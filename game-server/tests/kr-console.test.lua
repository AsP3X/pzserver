--
-- Tests for KR_Console, the /account chat command on the client.
--
-- These exist because of one specific failure. ISChat:createChildren does
--
--     self.textEntry.onCommandEntered = ISChat.onCommandEntered
--
-- which copies the function by reference when the chat UI is built. The first
-- version of this file replaced ISChat.onCommandEntered afterwards, which
-- changes a name nothing reads again — the entry went on calling the original,
-- `/account register` fell through to SendCommandToServer, and the server
-- answered "Unknown Command". From the outside that is indistinguishable from
-- the mod not being installed at all.
--
-- So the ISChat stub below reproduces that capture faithfully: it copies the
-- function onto the entry at build time, exactly as the game does. A patch that
-- only assigns ISChat.onCommandEntered fails here.
--
-- Project Zomboid runs Lua 5.1, so run this with luajit, not luaXX:
--   luajit game-server/tests/kr-console.test.lua   (exit 0 = all pass)
--

local HERE = (arg and arg[0] or ""):match("^(.*)/[^/]*$") or "."
local CLIENT = HERE .. "/../mods/KnoxRelay/42/media/lua/client/"

local pass, fail = 0, 0
local function ok(desc) pass = pass + 1; print("PASS: " .. desc) end
local function ng(desc, why) fail = fail + 1; print("FAIL: " .. desc .. " — " .. tostring(why)) end
local function check(desc, cond, why) if cond then ok(desc) else ng(desc, why or "assertion failed") end end

--------------------------------------------------------------------------
-- PZ globals
--------------------------------------------------------------------------

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

local function fire(name, ...)
    for _, fn in ipairs({ unpack(handlers[name] or {}) }) do
        fn(...)
    end
end

local halos, overheads = {}, {}
local player = {
    setHaloNote = function(_, text) halos[#halos + 1] = text end,
    addLineChatElement = function(_, text) overheads[#overheads + 1] = text end,
}

function getSpecificPlayer() return player end

local sent = {}
function sendClientCommand(_, module, command, args)
    sent[#sent + 1] = { module = module, command = command, args = args }
end

--------------------------------------------------------------------------
-- A chat box shaped like the real one
--------------------------------------------------------------------------

local vanillaCalls = 0

local function buildChat()
    local entry = {
        text = "",
        getText = function(self) return self.text end,
        clear = function(self) self.text = "" end,
    }

    ISChat = {
        instance = {
            textEntry = entry,
            unfocus = function() end,
            logChatCommand = function() end,
        },
    }

    -- The real ISChat:createChildren body, and the whole reason for this file.
    ISChat.onCommandEntered = function() vanillaCalls = vanillaCalls + 1 end
    entry.onCommandEntered = ISChat.onCommandEntered

    return entry
end

--------------------------------------------------------------------------

local entry = buildChat()
assert(loadfile(CLIENT .. "KR_Console.lua"))()

fire("OnGameStart")

check("the text entry is patched, not just ISChat", entry.onCommandEntered ~= ISChat.onCommandEntered)

--- Type something and press enter.
local function enter(text)
    entry.text = text
    entry:onCommandEntered()
end

-- /account register
sent, halos, overheads, vanillaCalls = {}, {}, {}, 0
enter("/account register")

check("a command is sent to the server", #sent == 1, #sent)
check("on the mod's channel", sent[1] and sent[1].module == "KnoxRelay", sent[1] and sent[1].module)
check("as accountRegister", sent[1] and sent[1].command == "accountRegister")
check("vanilla never sees it", vanillaCalls == 0, vanillaCalls)
check("the box is cleared", entry.text == "", "[" .. entry.text .. "]")

-- Case and padding
for _, text in ipairs({ "/ACCOUNT REGISTER", "  /Account   Register  ", "/account  register" }) do
    sent, vanillaCalls = {}, 0
    enter(text)
    check("accepted: [" .. text .. "]", #sent == 1 and vanillaCalls == 0,
        "sent=" .. #sent .. " vanilla=" .. vanillaCalls)
end

-- Bare /account explains itself rather than reaching the server
sent, halos, vanillaCalls = {}, {}, 0
enter("/account")
check("a bare /account is consumed", vanillaCalls == 0, vanillaCalls)
check("and sends nothing", #sent == 0, #sent)
check("and shows the usage", (halos[1] or ""):find("register") ~= nil, halos[1])

-- Anything else falls through untouched
for _, text in ipairs({ "/help", "hello everyone", "/accountant", "/safehouse", "/reporter" }) do
    sent, vanillaCalls = {}, 0
    enter(text)
    check("passed through: [" .. text .. "]", vanillaCalls == 1 and #sent == 0,
        "sent=" .. #sent .. " vanilla=" .. vanillaCalls)
end

-- /report Name details
sent, halos, vanillaCalls = {}, {}, 0
enter("/report pike he raided my base during safe hours")
check("a report command is sent", #sent == 1, #sent)
check("as playerReport", sent[1] and sent[1].command == "playerReport")
check("the accused is the first word", sent[1] and sent[1].args.accused == "pike", sent[1] and sent[1].args.accused)
check("the body is the rest", sent[1] and sent[1].args.body == "he raided my base during safe hours", sent[1] and sent[1].args.body)
check("vanilla never sees a report", vanillaCalls == 0, vanillaCalls)

sent, halos, vanillaCalls = {}, {}, 0
enter("/report")
check("a bare /report is consumed", vanillaCalls == 0)
check("and shows the usage", (halos[1] or ""):find("Usage") ~= nil, halos[1])

sent, halos, vanillaCalls = {}, {}, 0
enter("/report pike")
check("a report without detail is consumed", vanillaCalls == 0)
check("and does not send", #sent == 0, #sent)

--------------------------------------------------------------------------
-- The answer coming back
--------------------------------------------------------------------------

local function reply(args) fire("OnServerCommand", "KnoxRelay", "accountReply", args) end

halos, overheads = {}, {}
reply({ status = "issued", code = "3ACQ2R", expires_at = "2026-08-13T10:30:00Z" })
check("an issued code is shown", (halos[1] or ""):find("3ACQ2R") ~= nil, halos[1])
check("and never says the code is public", not (halos[1] or ""):find("chat"), halos[1])

halos = {}
reply({ status = "already_registered" })
check("a rejection is shown", (halos[1] or ""):find("already") ~= nil, halos[1])

halos = {}
reply({ status = "no_answer" })
check("a timeout is shown", (halos[1] or ""):find("did not answer") ~= nil, halos[1])

halos = {}
fire("OnServerCommand", "SomeOtherMod", "accountReply", { status = "issued", code = "XXXXXX" })
check("another mod's command is ignored", #halos == 0, halos[1])

halos = {}
fire("OnServerCommand", "KnoxRelay", "reportReply", { status = "filed" })
check("a filed report is confirmed", (halos[1] or ""):find("sent") ~= nil, halos[1])

halos = {}
fire("OnServerCommand", "KnoxRelay", "reportReply", { status = "self" })
check("a self-report is refused", (halos[1] or ""):find("yourself") ~= nil, halos[1])

--------------------------------------------------------------------------
-- A chat box rebuilt later must be re-patched
--------------------------------------------------------------------------

local rebuilt = buildChat()
fire("OnCreatePlayer")
sent, vanillaCalls = {}, 0
rebuilt.text = "/account register"
rebuilt:onCommandEntered()
check("a rebuilt chat box is patched again", #sent == 1 and vanillaCalls == 0,
    "sent=" .. #sent .. " vanilla=" .. vanillaCalls)

--------------------------------------------------------------------------

print("")
print(string.format("%d passed, %d failed", pass, fail))
os.exit(fail == 0 and 0 or 1)
