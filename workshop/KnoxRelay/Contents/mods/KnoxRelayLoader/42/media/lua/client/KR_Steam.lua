--
-- KR_Steam.lua — load Knox Relay from the Steam Workshop cache.
--
-- PZ's folder order is workshop, steam, mods. The in-game upload tree
-- (Zomboid/Workshop/KnoxRelay/Contents/) wins, so a leftover copy from the
-- last time this PC published the item pins the Desk to that old Lua even
-- after Steam has downloaded a newer build.
--
-- This file lives in a *second* mod id inside the same Workshop item. An
-- old Contents tree does not contain it, so Steam still loads it. It then
-- reloads Knox Relay's client Lua from the Steam install folder. Players
-- do not delete anything.
--
-- A Contents tree written by `make knox-client` carries `.knox-dev` so a
-- developer can still test unpublished Lua without this file stomping it.
--

KR_Steam = KR_Steam or {}

KR_Steam.ITEM_ID = "3777446787"
KR_Steam.MOD_ID = "KnoxRelay"
KR_Steam.MARKER = ".knox-dev"

-- Same order PZ uses (alphabetical under media/lua/client). Keep in step
-- with game-server/mods/KnoxRelay/42/media/lua/client/. The test suite
-- fails if a file is added there and missing here.
KR_Steam.CLIENT_LUA = {
    "KR_Console.lua",
    "KR_Desk.lua",
    "KR_DeskFriends.lua",
    "KR_DeskHud.lua",
    "KR_DeskInbox.lua",
    "KR_DeskReports.lua",
    "KR_Echo.lua",
    "KR_FriendMap.lua",
    "KR_Hold.lua",
    "KR_Social.lua",
}

local LOG = "[KnoxRelay] "

function KR_Steam.normalizePath(path)
    if type(path) ~= "string" or path == "" then
        return nil
    end
    local normalized = path:gsub("\\", "/")
    normalized = normalized:gsub("/+", "/")
    if #normalized > 1 then
        normalized = normalized:gsub("/$", "")
    end
    return normalized
end

function KR_Steam.join(root, rel)
    root = KR_Steam.normalizePath(root)
    if not root then
        return nil
    end
    rel = tostring(rel or ""):gsub("\\", "/"):gsub("^/", "")
    if rel == "" then
        return root
    end
    return root .. "/" .. rel
end

function KR_Steam.isUploadTree(path)
    local normalized = KR_Steam.normalizePath(path)
    if not normalized then
        return false
    end
    local lower = string.lower(normalized)
    return string.find(lower, "/zomboid/workshop/", 1, true) ~= nil
        and string.find(lower, "/contents/mods/", 1, true) ~= nil
end

function KR_Steam.samePath(left, right)
    left = KR_Steam.normalizePath(left)
    right = KR_Steam.normalizePath(right)
    if not left or not right then
        return false
    end
    return string.lower(left) == string.lower(right)
end

function KR_Steam.markerPath(modRoot)
    return KR_Steam.join(modRoot, KR_Steam.MARKER)
end

function KR_Steam.clientFilePath(modRoot, name)
    return KR_Steam.join(modRoot, "42/media/lua/client/" .. tostring(name or ""))
end

--- Adopt Steam when the loaded tree is the leftover upload folder or a
--- loose Zomboid/mods copy, unless a developer marker says Contents is
--- the tree under test.
function KR_Steam.shouldAdopt(loadedDir, steamDir, isDev)
    if type(steamDir) ~= "string" or steamDir == "" then
        return false
    end
    if isDev then
        return false
    end
    if KR_Steam.samePath(loadedDir, steamDir) then
        return false
    end
    if KR_Steam.isUploadTree(loadedDir) then
        return true
    end
    local normalized = KR_Steam.normalizePath(loadedDir)
    if normalized and string.find(string.lower(normalized), "/zomboid/mods/", 1, true) then
        return true
    end
    return false
end

function KR_Steam.steamCandidates(home, extra)
    local candidates = {}
    local function add(path)
        path = KR_Steam.normalizePath(path)
        if path then
            candidates[#candidates + 1] = path
        end
    end

    if type(extra) == "string" then
        add(extra)
    elseif type(extra) == "table" then
        for i = 1, #extra do
            add(extra[i])
        end
    end

    local item = KR_Steam.ITEM_ID
    local tail = "steamapps/workshop/content/108600/" .. item .. "/mods/KnoxRelay"
    if type(home) == "string" and home ~= "" then
        local root = KR_Steam.normalizePath(home)
        add(root .. "/Library/Application Support/Steam/" .. tail)
        add(root .. "/.steam/steam/" .. tail)
        add(root .. "/.local/share/Steam/" .. tail)
        add(root .. "/Steam/" .. tail)
    end
    add("C:/Program Files (x86)/Steam/" .. tail)
    add("C:/Program Files/Steam/" .. tail)
    return candidates
end

--------------------------------------------------------------------------
-- I/O against the live game. Tests pass a fake table instead.
--------------------------------------------------------------------------

local function fileExists(path)
    if type(path) ~= "string" or path == "" then
        return false
    end
    if type(io) == "table" and type(io.open) == "function" then
        local handle = io.open(path, "r")
        if handle then
            handle:close()
            return true
        end
    end
    return false
end

local function loadedDir()
    if type(getModInfoByID) ~= "function" then
        return nil
    end
    local ok, info = pcall(getModInfoByID, KR_Steam.MOD_ID)
    if not ok or not info or type(info.getDir) ~= "function" then
        return nil
    end
    local got, dir = pcall(function()
        return info:getDir()
    end)
    if got then
        return dir
    end
    return nil
end

local function dirFromWorkshopMods()
    if type(getSteamWorkshopItemMods) ~= "function" then
        return nil
    end
    local ok, mods = pcall(getSteamWorkshopItemMods, KR_Steam.ITEM_ID)
    if not ok or not mods or type(mods.size) ~= "function" then
        return nil
    end
    local sizeOk, size = pcall(function()
        return mods:size()
    end)
    if not sizeOk or type(size) ~= "number" then
        return nil
    end
    for index = 0, size - 1 do
        local got, mod = pcall(function()
            return mods:get(index)
        end)
        if got and mod and type(mod.getId) == "function" then
            local idOk, id = pcall(function()
                return mod:getId()
            end)
            if idOk and id == KR_Steam.MOD_ID and type(mod.getDir) == "function" then
                local dirOk, dir = pcall(function()
                    return mod:getDir()
                end)
                if dirOk and type(dir) == "string" and not KR_Steam.isUploadTree(dir) then
                    return dir
                end
            end
        end
    end
    return nil
end

local function userHome()
    if type(getMyDocumentFolder) == "function" then
        local ok, docs = pcall(getMyDocumentFolder)
        if ok and type(docs) == "string" and docs ~= "" then
            local normalized = KR_Steam.normalizePath(docs)
            if normalized then
                local home = string.match(normalized, "^(.*)/Zomboid$")
                    or string.match(normalized, "^(.*)/zomboid$")
                if home then
                    return home
                end
            end
        end
    end
    return nil
end

local function steamDir()
    local fromApi = dirFromWorkshopMods()
    if fromApi and not KR_Steam.isUploadTree(fromApi) then
        return fromApi
    end
    -- io.open is often nil in Kahlua, so a missing probe file cannot
    -- rule a candidate out. Prefer an existing file when we can read it;
    -- otherwise take the first OS-shaped path and let reloadLuaFile fail
    -- closed if it is wrong.
    local candidates = KR_Steam.steamCandidates(userHome())
    local fallback = nil
    for i = 1, #candidates do
        local probe = KR_Steam.clientFilePath(candidates[i], "KR_Desk.lua")
        if fileExists(probe) then
            return candidates[i]
        end
        if not fallback then
            fallback = candidates[i]
        end
    end
    return fallback or fromApi
end

local function isDevTree(dir)
    if fileExists(KR_Steam.markerPath(dir)) then
        return true
    end
    -- PZ often sandboxes io.open. The loaded mod's own files still open
    -- through getModFileReader, which is how `make knox-client` marks a
    -- Contents tree so unpublished Lua is not replaced by Steam.
    if type(getModFileReader) == "function" then
        local ok, reader = pcall(getModFileReader, KR_Steam.MOD_ID, KR_Steam.MARKER, false)
        if ok and reader then
            pcall(function()
                reader:close()
            end)
            return true
        end
    end
    return false
end

local function reloadFile(path)
    if type(reloadLuaFile) ~= "function" then
        return false
    end
    local ok = pcall(reloadLuaFile, path)
    return ok == true
end

function KR_Steam.adopt(io)
    io = io or {}
    local loaded = io.loadedDir or loadedDir()
    local steam = io.steamDir or steamDir()
    local dev = io.isDev
    if dev == nil then
        dev = isDevTree(loaded)
    end
    local reload = io.reload or reloadFile

    if not KR_Steam.shouldAdopt(loaded, steam, dev) then
        return false, "keep"
    end

    local n = 0
    for i = 1, #KR_Steam.CLIENT_LUA do
        local name = KR_Steam.CLIENT_LUA[i]
        local path = KR_Steam.clientFilePath(steam, name)
        if reload(path) then
            n = n + 1
        end
    end

    if n > 0 then
        print(LOG .. "Using Steam Workshop copy of Knox Relay (" .. tostring(n) .. " files); leftover upload folder ignored")
        return true, n
    end
    return false, "reload-failed"
end

--------------------------------------------------------------------------
-- If Steam cannot be adopted, tell the player to fully quit. Disconnect
-- keeps the old Lua; that is a PZ engine limit, not a Knox setting.
--------------------------------------------------------------------------

local wall = nil

local function showWall()
    if wall or type(ISPanel) ~= "table" or type(ISPanel.derive) ~= "function" then
        return
    end

    local KnoxSteamWall = ISPanel:derive("KnoxSteamWall")

    function KnoxSteamWall:new(x, y, w, h)
        local o = ISPanel:new(x, y, w, h)
        setmetatable(o, self)
        self.__index = self
        o.backgroundColor = { r = 0.027, g = 0.031, b = 0.024, a = 0.97 }
        o.borderColor = { r = 0.949, g = 0.635, b = 0.047, a = 1 }
        return o
    end

    function KnoxSteamWall:prerender()
        ISPanel.prerender(self)
        self:drawTextCentre("KNOX RELAY UPDATED", self.width / 2, 24, 0.949, 0.635, 0.047, 1, UIFont.Medium)
        self:drawTextCentre("Fully close Project Zomboid, then join this server again.",
            self.width / 2, 56, 0.910, 0.902, 0.867, 1, UIFont.Small)
        self:drawTextCentre("Disconnecting is not enough.",
            self.width / 2, 76, 0.604, 0.627, 0.576, 1, UIFont.Small)
    end

    local w, h = 520, 120
    local x, y = 40, 40
    pcall(function()
        local core = getCore()
        if core then
            w = math.min(560, core:getScreenWidth() - 80)
            x = math.max(10, math.floor((core:getScreenWidth() - w) / 2))
            y = math.max(10, math.floor(core:getScreenHeight() / 2 - 60))
        end
    end)

    local ok, err = pcall(function()
        wall = KnoxSteamWall:new(x, y, w, h)
        wall:initialise()
        wall:addToUIManager()
        wall:setAlwaysOnTop(true)
    end)
    if not ok then
        print(LOG .. "Could not show update wall: " .. tostring(err))
        wall = nil
    end
end

local adopted, reason = KR_Steam.adopt()
KR_Steam.adopted = adopted == true
KR_Steam.adoptReason = reason

if not KR_Steam.adopted then
    local loaded = loadedDir()
    if KR_Steam.isUploadTree(loaded) and not isDevTree(loaded) then
        KR_Steam.needsRestart = true
        print(LOG .. "Leftover upload folder is pinning Knox Relay; fully close the game so Steam can load")
    end
end

if KR_Steam.needsRestart and type(Events) == "table" then
    if Events.OnGameStart and Events.OnGameStart.Add then
        Events.OnGameStart.Add(showWall)
    end
    if Events.OnCreatePlayer and Events.OnCreatePlayer.Add then
        Events.OnCreatePlayer.Add(showWall)
    end
end
