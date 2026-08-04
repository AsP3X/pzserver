--
-- KR_Progress.lua — character progression for connected players.
--
-- Writes Lua/player_stats.json: kills, hours survived, profession and every
-- perk the character has actually trained. Runs on the ten-minute hook since
-- walking the perk list for everyone online is the most expensive export the
-- mod does.
--
-- Each player is built inside a pcall so one broken character descriptor
-- cannot cost the whole batch.
--

local Codec = require("KR_Codec")
local Bridge = require("KR_Bridge")
local Roster = require("KR_Roster")

KR_Progress = {}

local LOG = "[KnoxRelay] "
local FILE = "player_stats.json"

--- Trained perks as a name -> level map. Untrained perks are left out
--- entirely rather than reported as zero.
local function perks(player)
    local trained = {}

    local catalogue = PerkFactory.PerkList
    if not catalogue then
        return trained
    end

    for index = 0, catalogue:size() - 1 do
        local perk = catalogue:get(index)
        if perk then
            local ok, level = pcall(player.getPerkLevel, player, perk)
            if ok and level and level > 0 then
                trained[perk:getName() or tostring(perk)] = level
            end
        end
    end

    return trained
end

--- Chosen occupation, or nil if the character has none.
local function profession(player)
    local descriptor = player:getDescriptor()
    if not descriptor or not descriptor.getProfession then
        return nil
    end

    local ok, name = pcall(descriptor.getProfession, descriptor)
    if ok and name and name ~= "" then
        return name
    end

    return nil
end

--- Export everyone online. Returns the number of players written.
function KR_Progress.export()
    local players = Roster.online()
    if not players then
        return 0
    end

    local rows = {}

    for position, player in ipairs(players) do
        local ok, row = pcall(function()
            local kills = 0
            if player.getZombieKills then
                kills = player:getZombieKills() or 0
            end

            local hours = 0
            if player.getHoursSurvived then
                hours = math.floor((player:getHoursSurvived() or 0) * 10 + 0.5) / 10
            end

            return {
                username = player:getUsername() or "unknown",
                zombie_kills = kills,
                hours_survived = hours,
                profession = profession(player),
                skills = perks(player),
                is_dead = player:isDead() or false,
            }
        end)

        if ok and row then
            rows[#rows + 1] = row
        elseif not ok then
            print(LOG .. "WARNING: failed to export stats for player index " .. position .. ": " .. tostring(row))
        end
    end

    local encoded, body = pcall(Codec.encode, {
        timestamp = Bridge.worldStamp(false),
        player_count = #rows,
        players = rows,
    })

    if not encoded then
        print(LOG .. "ERROR encoding player stats: " .. tostring(body))

        return 0
    end

    if not Bridge.writeText(FILE, body) then
        print(LOG .. "ERROR: cannot write player stats")

        return 0
    end

    return #rows
end

return KR_Progress
