--
-- ZM_Utils.lua — Shared utility functions for ZomboidManager mod
--

local JSON = require("ZM_JSON")

ZM_Utils = {}

--- Get ISO 8601 timestamp using real wall-clock time (not PZ's in-game calendar)
function ZM_Utils.getTimestamp()
    local cal = Calendar.getInstance()
    return string.format("%04d-%02d-%02dT%02d:%02d:%02d",
        cal:get(Calendar.YEAR), cal:get(Calendar.MONTH) + 1, cal:get(Calendar.DAY_OF_MONTH),
        cal:get(Calendar.HOUR_OF_DAY), cal:get(Calendar.MINUTE), cal:get(Calendar.SECOND))
end

--- Read a JSON file and return parsed data or nil
function ZM_Utils.readJsonFile(path)
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

    local writer = getFileWriter(path, true, false)
    if not writer then
        print("[ZomboidManager] ERROR: cannot write " .. path)
        return false
    end

    writer:write(jsonStr)
    writer:close()
    return true
end

return ZM_Utils
