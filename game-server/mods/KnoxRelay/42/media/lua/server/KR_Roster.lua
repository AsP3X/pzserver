--
-- KR_Roster.lua — access to the set of connected players.
--
-- getOnlinePlayers() hands back a Java ArrayList, which is awkward to work
-- with and returns nil while the server is still coming up. Every module that
-- needs players goes through here so that nil case is handled in one place.
--

KR_Roster = {}

--- Is this entity a human player rather than a zombie or an animal? Wrapped
--- in pcall because instanceof throws on some of the things the combat events
--- hand over.
function KR_Roster.isPlayer(entity)
    local ok, human = pcall(function()
        return instanceof(entity, "IsoPlayer")
    end)

    return ok and human == true
end

--- Connected players as a plain Lua array, or nil when the roster is not
--- available yet. nil and {} mean different things: "ask again later" versus
--- "nobody is on".
function KR_Roster.online()
    local connected = getOnlinePlayers()
    if not connected then
        return nil
    end

    local players = {}
    for index = 0, connected:size() - 1 do
        local player = connected:get(index)
        if player then
            players[#players + 1] = player
        end
    end

    return players
end

--- PZ names are case-sensitive in the engine; website accounts are not.
function KR_Roster.sameName(left, right)
    if type(left) ~= "string" or type(right) ~= "string" then
        return false
    end

    return string.lower(left) == string.lower(right)
end

--- Single connected player by username, case-insensitive, or nil.
function KR_Roster.find(username)
    local players = KR_Roster.online()
    if not players or type(username) ~= "string" then
        return nil
    end

    for _, player in ipairs(players) do
        if KR_Roster.sameName(player:getUsername(), username) then
            return player
        end
    end

    return nil
end

--- username -> player map, for callers resolving several names at once.
---
--- Both the in-game spelling and its lower-case form are stored so a panel
--- request that used the account name still finds the IsoPlayer.
function KR_Roster.byUsername()
    local players = KR_Roster.online()
    if not players then
        return nil
    end

    local lookup = {}
    for _, player in ipairs(players) do
        local name = player:getUsername()
        if type(name) == "string" then
            lookup[name] = player
            lookup[string.lower(name)] = player
        end
    end

    return lookup
end

return KR_Roster
