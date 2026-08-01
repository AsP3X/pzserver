--
-- ZM_Utils.lua — Shared utility functions for ZomboidManager mod
--

local JSON = require("ZM_JSON")

ZM_Utils = {}

local _docFolderLogged = false
local _writeDiagDone = false

--- Get ISO 8601 timestamp using real wall-clock time (not PZ's in-game calendar)
function ZM_Utils.getTimestamp()
    local cal = Calendar.getInstance()
    return string.format("%04d-%02d-%02dT%02d:%02d:%02d",
        cal:get(Calendar.YEAR), cal:get(Calendar.MONTH) + 1, cal:get(Calendar.DAY_OF_MONTH),
        cal:get(Calendar.HOUR_OF_DAY), cal:get(Calendar.MINUTE), cal:get(Calendar.SECOND))
end

--- Document / cache folder (where getFileWriter stores Lua/*).
function ZM_Utils.getDocumentFolder()
    local ok, folder = pcall(function()
        if getMyDocumentFolder then
            return getMyDocumentFolder()
        end
        if getCore and getCore() and getCore().getMyDocumentFolder then
            return getCore():getMyDocumentFolder()
        end
        return nil
    end)
    if ok then
        return folder
    end
    return nil
end

function ZM_Utils.getPathSep()
    if getFileSeparator then
        local ok, sep = pcall(getFileSeparator)
        if ok and sep and sep ~= "" then
            return sep
        end
    end
    return "/"
end

--- Normalize relative Lua path to use the platform separator.
function ZM_Utils.normalizeLuaPath(path)
    if not path then
        return path
    end
    local sep = ZM_Utils.getPathSep()
    if sep == "\\" then
        return string.gsub(path, "/", "\\")
    end
    return string.gsub(path, "\\", "/")
end

local function logDocFolderOnce()
    if _docFolderLogged then
        return
    end
    _docFolderLogged = true
    local folder = ZM_Utils.getDocumentFolder()
    print("[ZomboidManager] Document folder (Lua root parent): " .. tostring(folder))
    print("[ZomboidManager] File separator: " .. tostring(ZM_Utils.getPathSep()))
end

--- Try getFileWriter (standard PZ API).
local function writeViaFileWriter(path, content)
    local writer = getFileWriter(path, true, false)
    if not writer then
        return false, "getFileWriter returned nil"
    end
    local ok, err = pcall(function()
        writer:write(content)
        writer:close()
    end)
    if not ok then
        pcall(function() writer:close() end)
        return false, "getFileWriter write error: " .. tostring(err)
    end
    return true, nil
end

--- Try getFileOutput (DataOutputStream under Lua/).
local function writeViaFileOutput(path, content)
    if not getFileOutput then
        return false, "getFileOutput unavailable"
    end
    local out = getFileOutput(path)
    if not out then
        return false, "getFileOutput returned nil"
    end
    local ok, err = pcall(function()
        -- DataOutputStream
        if out.writeBytes then
            out:writeBytes(content)
        elseif out.writeUTF then
            out:writeUTF(content)
        else
            -- last resort: write each byte (slow, rare)
            for i = 1, #content do
                out:write(string.byte(content, i))
            end
        end
        out:close()
    end)
    if not ok then
        pcall(function() out:close() end)
        return false, "getFileOutput write error: " .. tostring(err)
    end
    return true, nil
end

--- Absolute path write using Java FileWriter (bypasses getFileWriter sandbox quirks).
local function writeViaJavaFileWriter(path, content)
    local folder = ZM_Utils.getDocumentFolder()
    if not folder or folder == "" then
        return false, "document folder unknown"
    end
    local sep = ZM_Utils.getPathSep()
    local rel = ZM_Utils.normalizeLuaPath(path)
    local full = folder .. sep .. "Lua" .. sep .. rel

    local ok, err = pcall(function()
        local File = luajava and luajava.bindClass and luajava.bindClass("java.io.File")
        local FileWriter = luajava and luajava.bindClass and luajava.bindClass("java.io.FileWriter")
        if not File or not FileWriter then
            error("luajava File/FileWriter not available")
        end
        local f = File.new(full)
        local parent = f:getParentFile()
        if parent and not parent:exists() then
            parent:mkdirs()
        end
        local fw = FileWriter.new(full, false)
        fw:write(content)
        fw:close()
    end)
    if not ok then
        return false, "java FileWriter: " .. tostring(err)
    end
    return true, nil
end

--- Write raw string to a path under the Lua folder (multi-strategy).
function ZM_Utils.writeRawFile(path, content)
    logDocFolderOnce()
    path = ZM_Utils.normalizeLuaPath(path)

    local strategies = {
        { name = "getFileWriter", fn = writeViaFileWriter },
        { name = "getFileOutput", fn = writeViaFileOutput },
        { name = "java.FileWriter", fn = writeViaJavaFileWriter },
    }

    local errors = {}
    for _, s in ipairs(strategies) do
        local ok, err = s.fn(path, content)
        if ok then
            if not _writeDiagDone then
                _writeDiagDone = true
                print("[ZomboidManager] File write OK via " .. s.name .. " → " .. path)
            end
            return true
        end
        table.insert(errors, s.name .. "=" .. tostring(err))
    end

    print("[ZomboidManager] ERROR: cannot write " .. path .. " | " .. table.concat(errors, " | "))
    print("[ZomboidManager] HINT: document folder=" .. tostring(ZM_Utils.getDocumentFolder())
        .. " — ensure host bind mount matches that path's Lua/ dir (0777/0666, no sticky)")
    return false
end

--- Read a JSON file and return parsed data or nil
function ZM_Utils.readJsonFile(path)
    path = ZM_Utils.normalizeLuaPath(path)
    local reader = getFileReader(path, false)
    if not reader then
        return nil
    end

    local lines = {}
    local line = reader:readLine()
    while line ~= nil do
        table.insert(lines, line)
        line = reader:readLine()
    end
    reader:close()

    local content = table.concat(lines, "")
    if content == "" then
        return nil
    end

    local ok, data = pcall(JSON.decode, content)
    if not ok then
        print("[ZomboidManager] ERROR parsing " .. path .. ": " .. tostring(data))
        return nil
    end

    return data
end

--- Write data to a JSON file
function ZM_Utils.writeJsonFile(path, data)
    local ok, jsonStr = pcall(JSON.encode, data)
    if not ok then
        print("[ZomboidManager] ERROR encoding " .. path .. ": " .. tostring(jsonStr))
        return false
    end

    -- Prefer multi-strategy raw write (handles B42/docker getFileWriter failures)
    if ZM_Utils.writeRawFile(path, jsonStr) then
        return true
    end

    -- Last attempt: classic getFileWriter with retries (legacy path)
    local attempts = 3
    path = ZM_Utils.normalizeLuaPath(path)
    for attempt = 1, attempts do
        local writer = getFileWriter(path, true, false)
        if writer then
            writer:write(jsonStr)
            writer:close()
            return true
        end
        if attempt < attempts then
            print("[ZomboidManager] ERROR: cannot write " .. path .. " (attempt " .. attempt .. "/" .. attempts .. "), retrying...")
        end
    end

    return false
end

--- One-shot bridge self-test (call from OnServerStarted)
function ZM_Utils.selfTestBridge()
    logDocFolderOnce()
    local testPath = "zm_bridge_selftest.txt"
    local payload = "ok " .. ZM_Utils.getTimestamp()
    if ZM_Utils.writeRawFile(testPath, payload) then
        print("[ZomboidManager] Bridge self-test PASSED (" .. testPath .. ")")
        return true
    end
    print("[ZomboidManager] Bridge self-test FAILED — inventory/deposits/stats will not work until writes succeed")
    return false
end

return ZM_Utils
