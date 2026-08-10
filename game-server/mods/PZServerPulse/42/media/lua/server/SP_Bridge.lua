--
-- SP_Bridge.lua — file I/O channel between the game server and the web panel.
--
-- Writes JSON heartbeat files into the server's Lua/ directory, which is
-- bind-mounted into the Laravel container. Tries multiple write strategies
-- because Build 42 in Docker can return nil from getFileWriter() depending
-- on how the mount is owned.
--

local Codec = require("SP_Codec")

SP_Bridge = {}

SP_Bridge.VERSION = "1.1"

local LOG = "[PZServerPulse] "

local announcedRoot = false
local announcedWriter = false

--------------------------------------------------------------------------
-- Path helpers
--------------------------------------------------------------------------

function SP_Bridge.rootFolder()
    local ok, folder = pcall(function()
        if getMyDocumentFolder then
            return getMyDocumentFolder()
        end
        if getCore and getCore() and getCore().getMyDocumentFolder then
            return getCore():getMyDocumentFolder()
        end
        return nil
    end)
    if ok then return folder end
    return nil
end

function SP_Bridge.separator()
    if getFileSeparator then
        local ok, sep = pcall(getFileSeparator)
        if ok and sep and sep ~= "" then return sep end
    end
    return "/"
end

function SP_Bridge.localisePath(path)
    if not path then return path end
    if SP_Bridge.separator() == "\\" then
        return (string.gsub(path, "/", "\\"))
    end
    return (string.gsub(path, "\\", "/"))
end

local function announceRoot()
    if announcedRoot then return end
    announcedRoot = true
    print(LOG .. "Document folder: " .. tostring(SP_Bridge.rootFolder()))
    print(LOG .. "File separator: " .. tostring(SP_Bridge.separator()))
end

--------------------------------------------------------------------------
-- Write strategies
--------------------------------------------------------------------------

local function viaFileWriter(path, body)
    local writer = getFileWriter(path, true, false)
    if not writer then return false, "getFileWriter returned nil" end
    local ok, err = pcall(function()
        writer:write(body)
        writer:close()
    end)
    if not ok then
        pcall(function() writer:close() end)
        return false, "write error: " .. tostring(err)
    end
    return true, nil
end

local function viaFileOutput(path, body)
    if not getFileOutput then return false, "getFileOutput unavailable" end
    local stream = getFileOutput(path)
    if not stream then return false, "getFileOutput returned nil" end
    local ok, err = pcall(function()
        if stream.writeBytes then
            stream:writeBytes(body)
        elseif stream.writeUTF then
            stream:writeUTF(body)
        else
            for i = 1, #body do
                stream:write(string.byte(body, i))
            end
        end
        stream:close()
    end)
    if not ok then
        pcall(function() stream:close() end)
        return false, "write error: " .. tostring(err)
    end
    return true, nil
end

local function viaJavaIo(path, body)
    local root = SP_Bridge.rootFolder()
    if not root or root == "" then return false, "document folder unknown" end
    local absolute = root .. SP_Bridge.separator() .. "Lua" .. SP_Bridge.separator() .. SP_Bridge.localisePath(path)
    local ok, err = pcall(function()
        local bind = luajava and luajava.bindClass
        local FileClass = bind and luajava.bindClass("java.io.File")
        local WriterClass = bind and luajava.bindClass("java.io.FileWriter")
        if not FileClass or not WriterClass then
            error("luajava File/FileWriter not available")
        end
        local parent = FileClass.new(absolute):getParentFile()
        if parent and not parent:exists() then parent:mkdirs() end
        local writer = WriterClass.new(absolute, false)
        writer:write(body)
        writer:close()
    end)
    if not ok then return false, "java FileWriter: " .. tostring(err) end
    return true, nil
end

local STRATEGIES = {
    { label = "getFileWriter", write = viaFileWriter },
    { label = "getFileOutput", write = viaFileOutput },
    { label = "java.FileWriter", write = viaJavaIo },
}

--------------------------------------------------------------------------
-- Public API
--------------------------------------------------------------------------

--- Write a raw string to a path relative to the Lua/ folder.
function SP_Bridge.writeText(path, body)
    announceRoot()
    path = SP_Bridge.localisePath(path)
    for _, s in ipairs(STRATEGIES) do
        local ok, err = s.write(path, body)
        if ok then
            if not announcedWriter then
                announcedWriter = true
                print(LOG .. "File write OK via " .. s.label .. " -> " .. path)
            end
            return true
        end
    end
    print(LOG .. "ERROR: cannot write " .. path)
    return false
end

--- Encode and write a JSON payload.
function SP_Bridge.writeJson(path, payload)
    local ok, body = pcall(Codec.encode, payload)
    if not ok then
        print(LOG .. "ERROR encoding " .. path .. ": " .. tostring(body))
        return false
    end
    return SP_Bridge.writeText(path, body)
end

--- Self-test: prove writes land on disk at boot.
function SP_Bridge.probe()
    announceRoot()
    local path = "sp_bridge_selftest.txt"
    if SP_Bridge.writeText(path, "ok") then
        print(LOG .. "Bridge self-test PASSED")
        return true
    end
    print(LOG .. "Bridge self-test FAILED")
    return false
end

return SP_Bridge
