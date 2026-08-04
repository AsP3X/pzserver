--
-- KR_Codec.lua — JSON reader/writer for the Knox Relay bridge.
--
-- Project Zomboid runs a trimmed Lua 5.1 dialect on LuaJ: no io, no os.rename,
-- no bit library, no utf8 library. Everything here therefore operates on raw
-- byte strings and leans on nothing outside string/table/math.
--
-- The writer streams into a flat buffer and joins once at the end; the reader
-- is a cursor object that walks the source in a single forward pass.
--

KR_Codec = {}

--------------------------------------------------------------------------
-- Writing
--------------------------------------------------------------------------

--- Byte -> escape sequence. Built once at load: the seven short forms JSON
--- defines, plus \u00xx for every other C0 control character.
local ESCAPES = {
    ['"'] = '\\"',
    ["\\"] = "\\\\",
    ["\b"] = "\\b",
    ["\f"] = "\\f",
    ["\n"] = "\\n",
    ["\r"] = "\\r",
    ["\t"] = "\\t",
}

for code = 0, 31 do
    local char = string.char(code)
    if not ESCAPES[char] then
        ESCAPES[char] = string.format("\\u%04x", code)
    end
end

--- Anything outside this set (including raw UTF-8 bytes and "/") is emitted
--- untouched, which keeps Cyrillic/Georgian player names readable on disk.
local NEEDS_ESCAPE = '[%z\1-\31"\\]'

local function quote(text)
    return '"' .. text:gsub(NEEDS_ESCAPE, ESCAPES) .. '"'
end

local function formatNumber(value)
    if value ~= value then
        error("refusing to encode NaN")
    end
    if value <= -math.huge or value >= math.huge then
        error("refusing to encode infinity")
    end
    if value % 1 == 0 then
        return tostring(math.floor(value))
    end

    return string.format("%.14g", value)
end

local appendValue

--- A table with a value at index 1 is treated as a list; a table with no keys
--- at all collapses to [] so PHP always sees an array where it expects one.
local function appendTable(value, buffer, open)
    if open[value] then
        error("refusing to encode a table that contains itself")
    end
    open[value] = true

    if value[1] ~= nil then
        buffer[#buffer + 1] = "["
        local slot = 1
        while value[slot] ~= nil do
            if slot > 1 then
                buffer[#buffer + 1] = ","
            end
            appendValue(value[slot], buffer, open)
            slot = slot + 1
        end
        buffer[#buffer + 1] = "]"
        open[value] = nil

        return
    end

    local empty = true
    for key, item in pairs(value) do
        if type(key) ~= "string" then
            error("refusing to encode a table keyed by " .. type(key) .. " (" .. tostring(key) .. ")")
        end
        buffer[#buffer + 1] = empty and "{" or ","
        empty = false
        buffer[#buffer + 1] = quote(key)
        buffer[#buffer + 1] = ":"
        appendValue(item, buffer, open)
    end

    buffer[#buffer + 1] = empty and "[]" or "}"
    open[value] = nil
end

appendValue = function(value, buffer, open)
    local kind = type(value)

    if kind == "nil" then
        buffer[#buffer + 1] = "null"
    elseif kind == "boolean" then
        buffer[#buffer + 1] = tostring(value)
    elseif kind == "number" then
        buffer[#buffer + 1] = formatNumber(value)
    elseif kind == "string" then
        buffer[#buffer + 1] = quote(value)
    elseif kind == "table" then
        appendTable(value, buffer, open)
    else
        error("refusing to encode a value of type " .. kind)
    end
end

--- Serialise a Lua value to a compact JSON string.
function KR_Codec.encode(value)
    local buffer = {}
    appendValue(value, buffer, {})

    return table.concat(buffer)
end

--------------------------------------------------------------------------
-- Reading
--------------------------------------------------------------------------

local BLANK = { [" "] = true, ["\t"] = true, ["\r"] = true, ["\n"] = true }

--- Characters that end an unquoted token (number or literal).
local TOKEN_END = {
    [" "] = true, ["\t"] = true, ["\r"] = true, ["\n"] = true,
    ["]"] = true, ["}"] = true, [","] = true,
}

local UNESCAPE = {
    ['"'] = '"',
    ["\\"] = "\\",
    ["/"] = "/",
    ["b"] = "\b",
    ["f"] = "\f",
    ["n"] = "\n",
    ["r"] = "\r",
    ["t"] = "\t",
}

--- Encode a Unicode scalar as UTF-8 without the utf8 library.
local function toUtf8(code)
    if code < 0x80 then
        return string.char(code)
    end
    if code < 0x800 then
        return string.char(
            0xC0 + math.floor(code / 0x40),
            0x80 + code % 0x40)
    end
    if code < 0x10000 then
        return string.char(
            0xE0 + math.floor(code / 0x1000),
            0x80 + math.floor(code / 0x40) % 0x40,
            0x80 + code % 0x40)
    end
    if code <= 0x10FFFF then
        return string.char(
            0xF0 + math.floor(code / 0x40000),
            0x80 + math.floor(code / 0x1000) % 0x40,
            0x80 + math.floor(code / 0x40) % 0x40,
            0x80 + code % 0x40)
    end

    error(string.format("codepoint U+%X is outside the Unicode range", code))
end

--- `hex` is either four hex digits, or a surrogate pair still carrying the
--- literal "\u" that joins its halves.
local function fromHexEscape(hex)
    local lead = tonumber(hex:sub(1, 4), 16)
    local trail = tonumber(hex:sub(7, 10), 16)

    if trail then
        return toUtf8((lead - 0xD800) * 0x400 + (trail - 0xDC00) + 0x10000)
    end

    return toUtf8(lead)
end

local Cursor = {}
Cursor.__index = Cursor

function Cursor:abort(reason)
    local line = 1
    local column = 1
    for i = 1, self.at - 1 do
        if self.text:sub(i, i) == "\n" then
            line = line + 1
            column = 1
        else
            column = column + 1
        end
    end

    error(string.format("%s at line %d column %d", reason, line, column))
end

function Cursor:here()
    return self.text:sub(self.at, self.at)
end

function Cursor:eatBlanks()
    local at = self.at
    local last = #self.text
    while at <= last and BLANK[self.text:sub(at, at)] do
        at = at + 1
    end
    self.at = at
end

--- Index of the first token-terminating character at or after the cursor.
function Cursor:tokenEnd()
    local text = self.text
    for i = self.at, #text do
        if TOKEN_END[text:sub(i, i)] then
            return i
        end
    end

    return #text + 1
end

function Cursor:readString()
    local text = self.text
    local last = #text
    local pieces = {}
    local at = self.at + 1
    local runStart = at

    while at <= last do
        local byte = text:byte(at)

        if byte == 34 then
            pieces[#pieces + 1] = text:sub(runStart, at - 1)
            self.at = at + 1

            return table.concat(pieces)
        end

        if byte < 32 then
            self.at = at
            self:abort("unescaped control character inside string")
        end

        if byte == 92 then
            pieces[#pieces + 1] = text:sub(runStart, at - 1)
            local marker = text:sub(at + 1, at + 1)

            if marker == "u" then
                local hex = text:match("^[dD][89aAbB]%x%x\\u%x%x%x%x", at + 2)
                    or text:match("^%x%x%x%x", at + 2)
                if not hex then
                    self.at = at + 2
                    self:abort("malformed \\u escape inside string")
                end
                pieces[#pieces + 1] = fromHexEscape(hex)
                at = at + 2 + #hex
            else
                local plain = UNESCAPE[marker]
                if not plain then
                    self.at = at
                    self:abort("unsupported escape \\" .. marker .. " inside string")
                end
                pieces[#pieces + 1] = plain
                at = at + 2
            end

            runStart = at
        else
            at = at + 1
        end
    end

    self:abort("string never closed")
end

function Cursor:readNumber()
    local stop = self:tokenEnd()
    local token = self.text:sub(self.at, stop - 1)
    local value = tonumber(token)

    if not value then
        self:abort("'" .. token .. "' is not a number")
    end
    self.at = stop

    return value
end

--- true / false / null. JSON null becomes Lua nil, matching how the bridge
--- files treat "absent" and "null" as the same thing.
function Cursor:readKeyword()
    local stop = self:tokenEnd()
    local token = self.text:sub(self.at, stop - 1)
    self.at = stop

    if token == "true" then
        return true
    end
    if token == "false" then
        return false
    end
    if token == "null" then
        return nil
    end

    self.at = stop - #token
    self:abort("'" .. token .. "' is not a JSON literal")
end

function Cursor:readArray()
    local list = {}
    local slot = 0
    self.at = self.at + 1

    while true do
        self:eatBlanks()
        if self:here() == "]" then
            self.at = self.at + 1
            break
        end

        slot = slot + 1
        list[slot] = self:readValue()

        self:eatBlanks()
        local mark = self:here()
        self.at = self.at + 1

        if mark == "]" then
            break
        end
        if mark ~= "," then
            self:abort("expected ',' or ']' while reading an array")
        end
    end

    return list
end

function Cursor:readObject()
    local map = {}
    self.at = self.at + 1

    while true do
        self:eatBlanks()
        if self:here() == "}" then
            self.at = self.at + 1
            break
        end

        if self:here() ~= '"' then
            self:abort("object keys must be strings")
        end
        local key = self:readString()

        self:eatBlanks()
        if self:here() ~= ":" then
            self:abort("expected ':' after object key")
        end
        self.at = self.at + 1

        self:eatBlanks()
        map[key] = self:readValue()

        self:eatBlanks()
        local mark = self:here()
        self.at = self.at + 1

        if mark == "}" then
            break
        end
        if mark ~= "," then
            self:abort("expected ',' or '}' while reading an object")
        end
    end

    return map
end

function Cursor:readValue()
    local char = self:here()

    if char == '"' then
        return self:readString()
    end
    if char == "{" then
        return self:readObject()
    end
    if char == "[" then
        return self:readArray()
    end
    if char == "-" or (char >= "0" and char <= "9") then
        return self:readNumber()
    end
    if char == "" then
        self:abort("input ended where a value was expected")
    end

    return self:readKeyword()
end

--- Parse a JSON document. Raises on anything malformed, so every caller wraps
--- this in pcall — a half-written bridge file must never take the server down.
function KR_Codec.decode(text)
    if type(text) ~= "string" then
        error("KR_Codec.decode needs a string, got " .. type(text))
    end

    local cursor = setmetatable({ text = text, at = 1 }, Cursor)
    cursor:eatBlanks()
    local value = cursor:readValue()
    cursor:eatBlanks()

    if cursor.at <= #text then
        cursor:abort("trailing content after the JSON value")
    end

    return value
end

return KR_Codec
