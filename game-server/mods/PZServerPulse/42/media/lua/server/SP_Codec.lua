--
-- SP_Codec.lua — lightweight JSON encoder for the PZServerPulse bridge.
--
-- Project Zomboid runs Lua 5.1 on LuaJ with no io, os, or external libraries.
-- This module provides a self-contained JSON serializer that works within
-- those constraints. It handles strings, numbers, booleans, nil, arrays,
-- and string-keyed objects. Circular references and non-string keys raise
-- errors so a broken collector cannot silently produce unparseable output.
--

SP_Codec = {}

--------------------------------------------------------------------------
-- Character escaping
--------------------------------------------------------------------------

local ESCAPE_MAP = {
    ['"']  = '\\"',
    ['\\'] = '\\\\',
    ['\b'] = '\\b',
    ['\f'] = '\\f',
    ['\n'] = '\\n',
    ['\r'] = '\\r',
    ['\t'] = '\\t',
}

-- Fill in the C0 control range (0x00–0x1F) not already covered above.
for code = 0, 31 do
    local ch = string.char(code)
    if not ESCAPE_MAP[ch] then
        ESCAPE_MAP[ch] = string.format('\\u%04x', code)
    end
end

-- Pattern that matches any character needing escape inside a JSON string.
local ESCAPE_PATTERN = '[%z\1-\31"\\]'

local function escapeString(s)
    return '"' .. s:gsub(ESCAPE_PATTERN, ESCAPE_MAP) .. '"'
end

--------------------------------------------------------------------------
-- Number formatting
--------------------------------------------------------------------------

local function formatNumber(n)
    if n ~= n then
        error('NaN cannot be encoded as JSON')
    end
    if n == math.huge or n == -math.huge then
        error('Infinity cannot be encoded as JSON')
    end
    -- Integers stay clean; floats get up to 14 significant digits.
    if n % 1 == 0 then
        return tostring(math.floor(n))
    end
    return string.format('%.14g', n)
end

--------------------------------------------------------------------------
-- Recursive serialisation
--------------------------------------------------------------------------

local function encodeValue(value, buffer, seen)

    local t = type(value)

    if t == 'nil' then
        buffer[#buffer + 1] = 'null'

    elseif t == 'boolean' then
        buffer[#buffer + 1] = tostring(value)

    elseif t == 'number' then
        buffer[#buffer + 1] = formatNumber(value)

    elseif t == 'string' then
        buffer[#buffer + 1] = escapeString(value)

    elseif t == 'table' then
        if seen[value] then
            error('circular reference detected')
        end
        seen[value] = true

        -- Distinguish arrays (consecutive integer keys starting at 1) from
        -- objects. A table with value[1] ~= nil is treated as an array.
        if value[1] ~= nil then
            buffer[#buffer + 1] = '['
            local i = 1
            while value[i] ~= nil do
                if i > 1 then
                    buffer[#buffer + 1] = ','
                end
                encodeValue(value[i], buffer, seen)
                i = i + 1
            end
            buffer[#buffer + 1] = ']'
        else
            -- Remember where the brace lands: an empty table has to become []
            -- rather than {}, and that is only known once pairs() finds nothing.
            local openedAt = #buffer + 1
            local first = true
            buffer[openedAt] = '{'
            for k, v in pairs(value) do
                if type(k) ~= 'string' then
                    error('object keys must be strings, got ' .. type(k))
                end
                if first then
                    first = false
                else
                    buffer[#buffer + 1] = ','
                end
                buffer[#buffer + 1] = escapeString(k)
                buffer[#buffer + 1] = ':'
                encodeValue(v, buffer, seen)
            end
            if first then
                -- Empty table with no array keys → [], replacing the '{' that
                -- was written on the assumption there would be keys to follow.
                buffer[openedAt] = '[]'
            else
                buffer[#buffer + 1] = '}'
            end
        end

        seen[value] = nil

    else
        error('cannot encode value of type ' .. t)
    end
end

---
-- Serialise a Lua value to a compact JSON string.
-- Raises on circular references, non-string keys, NaN, or Infinity.
---
function SP_Codec.encode(value)
    local buffer = {}
    encodeValue(value, buffer, {})
    return table.concat(buffer)
end

return SP_Codec
