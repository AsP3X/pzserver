--
-- KR_Bridge.lua — the file channel between the game server and Laravel.
--
-- Everything Knox Relay exports or consumes travels through plain JSON files
-- under the server's Lua/ folder, which is bind-mounted into the Laravel
-- container. There is no socket and no shared database: a file appears, the
-- other side notices it, the file is rewritten.
--
-- Writing is the fragile half. Build 42 in Docker can hand back a nil writer
-- from getFileWriter() depending on how the mount is owned, so writes are
-- attempted through three separate mechanisms before giving up.
--

local Codec = require("KR_Codec")

KR_Bridge = {}

--- Mod version, exported in game_state.json so the panel can tell which
--- bridge features the server it is talking to actually has. Keep in step
--- with modversion in mod.info; nothing else reads that file at runtime.
KR_Bridge.VERSION = "1.25"

--- What this build can do. The panel reads these from game_state.json and
--- degrades when a flag is missing, instead of assuming git matches Workshop.
KR_Bridge.FEATURES = {
    "force_snapshot",
    "panel_jobs",
    "held_vault",
    "desk_inbox",
    "case_insensitive_roster",
}

local LOG = "[KnoxRelay] "

local announcedRoot = false
local announcedWriter = false

--------------------------------------------------------------------------
-- Clocks
--------------------------------------------------------------------------

--- Real wall-clock stamp from the JVM calendar, independent of the in-game
--- date. Used for anything Laravel correlates with its own timestamps.
function KR_Bridge.wallStamp()
    local calendar = Calendar.getInstance()

    return string.format("%04d-%02d-%02dT%02d:%02d:%02d",
        calendar:get(Calendar.YEAR),
        calendar:get(Calendar.MONTH) + 1,
        calendar:get(Calendar.DAY_OF_MONTH),
        calendar:get(Calendar.HOUR_OF_DAY),
        calendar:get(Calendar.MINUTE),
        calendar:get(Calendar.SECOND))
end

--- Stamp taken from the in-game calendar, falling back to wall clock when the
--- game clock is not up yet. `withSeconds` asks for real seconds instead of 00.
function KR_Bridge.worldStamp(withSeconds)
    if not getGameTime then
        return KR_Bridge.wallStamp()
    end

    local clock = getGameTime()
    local seconds = 0
    if withSeconds and clock.getSeconds then
        seconds = clock:getSeconds()
    end

    return string.format("%04d-%02d-%02dT%02d:%02d:%02d",
        clock:getYear(),
        clock:getMonth() + 1,
        clock:getDay(),
        clock:getHour(),
        clock:getMinutes(),
        seconds)
end

--------------------------------------------------------------------------
-- Paths
--------------------------------------------------------------------------

--- Parent of the Lua/ folder that getFileWriter() writes into. Logged once so
--- a misconfigured bind mount is obvious from the container output.
function KR_Bridge.rootFolder()
    local resolved, folder = pcall(function()
        if getMyDocumentFolder then
            return getMyDocumentFolder()
        end
        if getCore and getCore() and getCore().getMyDocumentFolder then
            return getCore():getMyDocumentFolder()
        end

        return nil
    end)

    if resolved then
        return folder
    end

    return nil
end

function KR_Bridge.separator()
    if getFileSeparator then
        local resolved, separator = pcall(getFileSeparator)
        if resolved and separator and separator ~= "" then
            return separator
        end
    end

    return "/"
end

--- Swap slashes so a relative path matches the host platform.
function KR_Bridge.localisePath(path)
    if not path then
        return path
    end

    if KR_Bridge.separator() == "\\" then
        return (string.gsub(path, "/", "\\"))
    end

    return (string.gsub(path, "\\", "/"))
end

local function announceRoot()
    if announcedRoot then
        return
    end
    announcedRoot = true

    print(LOG .. "Document folder (Lua root parent): " .. tostring(KR_Bridge.rootFolder()))
    print(LOG .. "File separator: " .. tostring(KR_Bridge.separator()))
end

--------------------------------------------------------------------------
-- Write strategies
--------------------------------------------------------------------------

--- The documented PZ API. Works on a healthy install.
local function viaFileWriter(path, body)
    local writer = getFileWriter(path, true, false)
    if not writer then
        return false, "getFileWriter returned nil"
    end

    local wrote, failure = pcall(function()
        writer:write(body)
        writer:close()
    end)

    if not wrote then
        pcall(function() writer:close() end)

        return false, "getFileWriter write error: " .. tostring(failure)
    end

    return true, nil
end

--- DataOutputStream flavour, which sometimes survives where the writer above
--- does not. Byte-at-a-time is the last-ditch branch and effectively unused.
local function viaFileOutput(path, body)
    if not getFileOutput then
        return false, "getFileOutput unavailable"
    end

    local stream = getFileOutput(path)
    if not stream then
        return false, "getFileOutput returned nil"
    end

    local wrote, failure = pcall(function()
        if stream.writeBytes then
            stream:writeBytes(body)
        elseif stream.writeUTF then
            stream:writeUTF(body)
        else
            for index = 1, #body do
                stream:write(string.byte(body, index))
            end
        end
        stream:close()
    end)

    if not wrote then
        pcall(function() stream:close() end)

        return false, "getFileOutput write error: " .. tostring(failure)
    end

    return true, nil
end

--- Reach past the sandbox entirely and use java.io directly against an
--- absolute path. Creates missing parent directories on the way.
local function viaJavaIo(path, body)
    local root = KR_Bridge.rootFolder()
    if not root or root == "" then
        return false, "document folder unknown"
    end

    local absolute = root .. KR_Bridge.separator() .. "Lua" .. KR_Bridge.separator() .. KR_Bridge.localisePath(path)

    local wrote, failure = pcall(function()
        local bind = luajava and luajava.bindClass
        local FileClass = bind and luajava.bindClass("java.io.File")
        local WriterClass = bind and luajava.bindClass("java.io.FileWriter")
        if not FileClass or not WriterClass then
            error("luajava File/FileWriter not available")
        end

        local parent = FileClass.new(absolute):getParentFile()
        if parent and not parent:exists() then
            parent:mkdirs()
        end

        local writer = WriterClass.new(absolute, false)
        writer:write(body)
        writer:close()
    end)

    if not wrote then
        return false, "java FileWriter: " .. tostring(failure)
    end

    return true, nil
end

local STRATEGIES = {
    { label = "getFileWriter", write = viaFileWriter },
    { label = "getFileOutput", write = viaFileOutput },
    { label = "java.FileWriter", write = viaJavaIo },
}

--------------------------------------------------------------------------
-- Public file operations
--------------------------------------------------------------------------

--- Write a raw string to `path`, relative to the Lua/ folder. Tries every
--- strategy in turn and reports which one worked the first time round.
function KR_Bridge.writeText(path, body)
    announceRoot()
    path = KR_Bridge.localisePath(path)

    local failures = {}
    for _, strategy in ipairs(STRATEGIES) do
        local wrote, failure = strategy.write(path, body)
        if wrote then
            if not announcedWriter then
                announcedWriter = true
                print(LOG .. "File write OK via " .. strategy.label .. " -> " .. path)
            end

            return true
        end
        failures[#failures + 1] = strategy.label .. "=" .. tostring(failure)
    end

    print(LOG .. "ERROR: cannot write " .. path .. " | " .. table.concat(failures, " | "))
    print(LOG .. "HINT: document folder=" .. tostring(KR_Bridge.rootFolder())
        .. " — ensure host bind mount matches that path's Lua/ dir (0777/0666, no sticky)")

    return false
end

--- Read and parse a JSON file. Returns nil for missing, empty or broken files
--- so callers can simply treat "no data" as "nothing to do".
function KR_Bridge.readJson(path)
    path = KR_Bridge.localisePath(path)

    local reader = getFileReader(path, false)
    if not reader then
        return nil
    end

    local chunks = {}
    local line = reader:readLine()
    while line ~= nil do
        chunks[#chunks + 1] = line
        line = reader:readLine()
    end
    reader:close()

    local body = table.concat(chunks, "")
    if body == "" then
        return nil
    end

    local parsed, result = pcall(Codec.decode, body)
    if not parsed then
        print(LOG .. "ERROR parsing " .. path .. ": " .. tostring(result))

        return nil
    end

    return result
end

--- Encode `payload` and write it to `path`.
function KR_Bridge.writeJson(path, payload)
    local encoded, body = pcall(Codec.encode, payload)
    if not encoded then
        print(LOG .. "ERROR encoding " .. path .. ": " .. tostring(body))

        return false
    end

    if KR_Bridge.writeText(path, body) then
        return true
    end

    -- Every strategy failed. Retry the plain PZ writer a few times in case the
    -- mount was momentarily busy rather than permanently mis-owned.
    local localPath = KR_Bridge.localisePath(path)
    for attempt = 1, 3 do
        local writer = getFileWriter(localPath, true, false)
        if writer then
            writer:write(body)
            writer:close()

            return true
        end
        if attempt < 3 then
            print(LOG .. "ERROR: cannot write " .. localPath .. " (attempt " .. attempt .. "/3), retrying...")
        end
    end

    return false
end

--- Prove at boot that writes land on disk. Without this the first sign of a
--- broken mount would be a silently failed player deposit.
function KR_Bridge.probe()
    announceRoot()

    local path = "zm_bridge_selftest.txt"
    if KR_Bridge.writeText(path, "ok " .. KR_Bridge.wallStamp()) then
        print(LOG .. "Bridge self-test PASSED (" .. path .. ")")

        return true
    end

    print(LOG .. "Bridge self-test FAILED — inventory/deposits/stats will not work until writes succeed")

    return false
end

return KR_Bridge
