--
-- Tests for KR_Steam — prefer the Steam Workshop copy of Knox Relay over a
-- leftover in-game upload folder, without asking the player to delete files.
--
--   luajit game-server/tests/kr-steam.test.lua
--

local HERE = (arg and arg[0] or ""):match("^(.*)/[^/]*$") or "."
local LOADER = HERE .. "/../mods/KnoxRelayLoader/42/media/lua/client/KR_Steam.lua"
local CLIENT = HERE .. "/../mods/KnoxRelay/42/media/lua/client/"

local pass, fail = 0, 0
local function ok(desc) pass = pass + 1; print("PASS: " .. desc) end
local function ng(desc, why) fail = fail + 1; print("FAIL: " .. desc .. " — " .. tostring(why)) end
local function check(desc, cond, why) if cond then ok(desc) else ng(desc, why or "assertion failed") end end

local chunk = assert(loadfile(LOADER))
chunk()
check("KR_Steam table exists after load", type(KR_Steam) == "table")

local contents = "C:/Users/asp3x/Zomboid/Workshop/KnoxRelay/Contents/mods/KnoxRelay"
local steam = "C:/Program Files (x86)/Steam/steamapps/workshop/content/108600/3777446787/mods/KnoxRelay"
local macContents = "/Users/nvorberg/Zomboid/Workshop/KnoxRelay/Contents/mods/KnoxRelay"
local macSteam = "/Users/nvorberg/Library/Application Support/Steam/steamapps/workshop/content/108600/3777446787/mods/KnoxRelay"
local loose = "C:/Users/asp3x/Zomboid/mods/KnoxRelay"

check("Windows Contents is an upload tree", KR_Steam.isUploadTree(contents))
check("Mac Contents is an upload tree", KR_Steam.isUploadTree(macContents))
check("Steam cache is not an upload tree", not KR_Steam.isUploadTree(steam))
check("loose Zomboid/mods is not an upload tree", not KR_Steam.isUploadTree(loose))
check("path compare ignores slash direction and case",
    KR_Steam.samePath(steam, "c:\\program files (x86)\\steam\\steamapps\\workshop\\content\\108600\\3777446787\\mods\\KnoxRelay"))

check("adopt when Contents shadows Steam",
    KR_Steam.shouldAdopt(contents, steam, false) == true)
check("adopt when Mac Contents shadows Steam",
    KR_Steam.shouldAdopt(macContents, macSteam, false) == true)
check("do not adopt when already on Steam",
    KR_Steam.shouldAdopt(steam, steam, false) == false)
check("do not adopt a developer Contents tree",
    KR_Steam.shouldAdopt(contents, steam, true) == false)
check("adopt a leftover Zomboid/mods copy",
    KR_Steam.shouldAdopt(loose, steam, false) == true)
check("do not adopt without a Steam dir",
    KR_Steam.shouldAdopt(contents, nil, false) == false)

local reloaded = {}
local adopted, n = KR_Steam.adopt({
    loadedDir = contents,
    steamDir = steam,
    isDev = false,
    reload = function(path)
        reloaded[#reloaded + 1] = path
        return true
    end,
})
check("adopt reloads client Lua from Steam", adopted == true)
check("adopt reloads every listed client file", n == #KR_Steam.CLIENT_LUA)
check("first reload is KR_Console from the Steam 42/ tree",
    reloaded[1] == KR_Steam.clientFilePath(steam, "KR_Console.lua"),
    tostring(reloaded[1]))
check("desk file is on the Steam path",
    reloaded[2] == KR_Steam.clientFilePath(steam, "KR_Desk.lua"),
    tostring(reloaded[2]))

local skipped = 0
KR_Steam.adopt({
    loadedDir = contents,
    steamDir = steam,
    isDev = true,
    reload = function()
        skipped = skipped + 1
        return true
    end,
})
check("developer marker skips reload", skipped == 0)

local onDisk = {}
local pipe = io.popen('ls "' .. CLIENT .. '"')
if pipe then
    for line in pipe:lines() do
        if line:match("%.lua$") then
            onDisk[#onDisk + 1] = line
        end
    end
    pipe:close()
end
table.sort(onDisk)
local expected = {}
for i = 1, #KR_Steam.CLIENT_LUA do
    expected[i] = KR_Steam.CLIENT_LUA[i]
end
table.sort(expected)
local same = #onDisk == #expected
local joinedDisk, joinedList = table.concat(onDisk, ","), table.concat(expected, ",")
if same then
    for i = 1, #onDisk do
        if onDisk[i] ~= expected[i] then
            same = false
            break
        end
    end
end
check("CLIENT_LUA matches KnoxRelay client files", same,
    "disk=[" .. joinedDisk .. "] list=[" .. joinedList .. "]")

local homes = KR_Steam.steamCandidates("/Users/nvorberg")
local sawMac = false
for i = 1, #homes do
    if homes[i]:find("Library/Application Support/Steam", 1, true) then
        sawMac = true
    end
end
check("Mac home produces a Steam cache candidate", sawMac)

print(string.format("\n%d passed, %d failed", pass, fail))
os.exit(fail == 0 and 0 or 1)
