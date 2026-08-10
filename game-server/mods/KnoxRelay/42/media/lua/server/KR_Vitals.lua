--
-- KR_Vitals.lua — the live character dashboard for connected players.
--
-- Writes Lua/vitals/<username>.json per player: health and wounds per body
-- part, trained skills with XP progress, moodles, the equipped weapon, worn
-- clothing, temperature, protection, encumbrance, quickload and recently
-- learned recipes. When that subdirectory cannot be created a flat
-- vitals_<username>.json is used instead, the same fallback KR_Snapshot uses.
--
-- This is the fast, wide export: player_stats.json (KR_Progress) carries the
-- slow summary every ten minutes, this carries everything the player's own
-- character page draws, every ten seconds or so.
--
-- Every collector is wrapped in pcall. A body-part descriptor that is missing
-- on one build must cost that one panel, not the whole heartbeat.
--

local Bridge = require("KR_Bridge")
local Roster = require("KR_Roster")

KR_Vitals = {}

local LOG = "[KnoxRelay] "
local DIRECTORY = "vitals"

--- Where KR_Boot stashes recipes as they are learned, read back below. The
--- game gives no way to ask a character what it has recently learned, only an
--- event when it happens, so the list has to be accumulated on the player.
KR_Vitals.RECIPE_KEY = "KR_LearnedRecipes"

--- The sixteen body parts PZ tracks damage and insulation for.
local BODY_PARTS = {
    "Head", "Neck", "Torso",
    "UpperArm_L", "UpperArm_R",
    "ForeArm_L", "ForeArm_R",
    "Hand_L", "Hand_R",
    "Groin",
    "UpperLeg_L", "UpperLeg_R",
    "LowerLeg_L", "LowerLeg_R",
    "Foot_L", "Foot_R",
}

--------------------------------------------------------------------------
-- Utilities
--------------------------------------------------------------------------

--- Call `fn` and hand back `default` if it errors or yields nil. Build 42
--- moves accessors between classes often enough that probing for a method by
--- name is less reliable than simply trying it.
local function safe(fn, default)
    local ok, value = pcall(fn)
    if ok and value ~= nil then
        return value
    end

    return default
end

local function round1(value)
    value = tonumber(value) or 0

    return math.floor(value * 10 + 0.5) / 10
end

local function round2(value)
    value = tonumber(value) or 0

    return math.floor(value * 100 + 0.5) / 100
end

--------------------------------------------------------------------------
-- Skills
--------------------------------------------------------------------------

--- Trained perks as name -> { level, xp }, where xp is progress towards the
--- next level between 0 and 1. Untrained perks are left out entirely rather
--- than reported as zero.
---
--- KR_Progress shares this walk rather than keeping its own: the perk list is
--- long, and one implementation is one place for the level lookup to be wrong.
function KR_Vitals.skills(player)
    local trained = {}

    local catalogue = PerkFactory and PerkFactory.PerkList
    if not catalogue then
        return trained
    end

    for index = 0, catalogue:size() - 1 do
        local perk = catalogue:get(index)
        if perk then
            local name = safe(function() return perk:getName() end)
            local level = safe(function() return player:getPerkLevel(perk) end, 0)

            if name and level > 0 then
                trained[name] = { level = level, xp = KR_Vitals.perkProgress(player, perk, level) }
            end
        end
    end

    return trained
end

--- How far into `level` the character is, 0 to 1. Freshly spawned players have
--- no XP object at all, which is why every step here is guarded.
function KR_Vitals.perkProgress(player, perk, level)
    local system = safe(function() return player:getXp() end)
    if not system then
        return 0
    end

    local entry = safe(function() return system:getXP(perk) end)
    if not entry then
        return 0
    end

    local total = safe(function() return entry:getTotalXp() end, 0)
    local nextLevel = safe(function() return entry:getXpForLevel(level + 1) end, 0)
    local thisLevel = safe(function() return entry:getXpForLevel(level) end, 0)

    if nextLevel <= thisLevel or nextLevel <= 0 then
        return 0
    end

    return round2((total - thisLevel) / (nextLevel - thisLevel))
end

--------------------------------------------------------------------------
-- Collectors
--------------------------------------------------------------------------

--- Who the character is: profession, traits, weight, favourite weapon, and the
--- two counters players actually compare with each other.
local function collectInfo(player)
    local info = {}

    info.name = safe(function() return player:getUsername() end)

    local descriptor = safe(function() return player:getDescriptor() end)
    if descriptor then
        info.profession = safe(function() return descriptor:getProfession() end)
    end

    local carried = {}
    local known = safe(function() return player:getCharacterTraits():getKnownTraits() end)
    if known then
        for index = 0, known:size() - 1 do
            local id = known:get(index)
            local label = tostring(id)

            if CharacterTraitDefinition then
                local ok, definition = pcall(CharacterTraitDefinition.getCharacterTraitDefinition, id)
                if ok and definition and definition.getLabel then
                    label = definition:getLabel() or label
                end
            end

            carried[#carried + 1] = label
        end
    end
    info.traits = carried

    info.weight = round2(safe(function() return player:getNutrition():getWeight() end, 0))
    info.favourite_weapon = safe(function() return player:getFavoriteWeapon() end)
    info.kills = safe(function() return player:getZombieKills() end, 0)
    info.hours_survived = round1(safe(function() return player:getHoursSurvived() end, 0))

    return info
end

--- Health and the wound list in one pass.
---
--- Both readings come off the same sixteen body parts, and the wound
--- collection is the expensive half, so they are gathered together and split
--- afterwards rather than walking the body twice per heartbeat.
local function collectBody(player)
    local body = safe(function() return player:getBodyDamage() end)
    if not body then
        return nil, nil
    end

    local parts = {}
    local injuries = {}

    for _, name in ipairs(BODY_PARTS) do
        local types = {}
        local part = safe(function() return body:getBodyPart(name) end)

        if part then
            local wounds = safe(function() return part:getWounds() end)
            local count = wounds and safe(function() return wounds:size() end, 0) or 0

            for index = 0, count - 1 do
                local wound = safe(function() return wounds:get(index) end)
                if wound then
                    local kind = tostring(safe(function() return wound:getType() end, "unknown"))

                    types[#types + 1] = kind
                    injuries[#injuries + 1] = {
                        part = name,
                        type = kind,
                        severity = tostring(safe(function() return wound:getSeverity() end, "unknown")),
                        treated = safe(function() return wound:isTreated() end, false),
                    }
                end
            end
        end

        parts[name] = {
            health = round1(safe(function() return body:getBodyPartHealth(name) end, 100)),
            wounds = types,
        }
    end

    local health = {
        overall = round1(safe(function() return body:getOverallBodyHealth() end, 100)),
        parts = parts,
    }

    return health, injuries
end

--- Bite and scratch defence per body part, from whatever is worn over it.
--- Parts with no cover at all are omitted rather than reported as zero.
local function collectProtection(player)
    local body = safe(function() return player:getBodyDamage() end)
    if not body then
        return nil
    end

    local parts = {}
    for _, name in ipairs(BODY_PARTS) do
        local bite = round1(safe(function() return body:getBiteDefense(name) end, 0))
        local scratch = round1(safe(function() return body:getScratchDefense(name) end, 0))

        if bite > 0 or scratch > 0 then
            parts[name] = { bite = bite, scratch = scratch }
        end
    end

    if next(parts) == nil then
        return nil
    end

    return { parts = parts }
end

--- Core temperature and body heat, plus skin temperature and insulation per
--- part — what tells a player they are freezing before the moodle does.
local function collectTemperature(player)
    local body = safe(function() return player:getBodyDamage() end)
    if not body then
        return nil
    end

    local parts = {}
    for _, name in ipairs(BODY_PARTS) do
        parts[name] = {
            skin = round1(safe(function() return body:getSkinTemperature(name) end, 37)),
            insulation = round1(safe(function() return body:getInsulation(name) end, 0)),
        }
    end

    return {
        core = round1(safe(function() return body:getCoreTemp() end, 37)),
        body_heat = round1(safe(function() return body:getBodyHeat() end, 0)),
        parts = parts,
    }
end

--- The full HUD moodle stack.
local function collectMoodles(player)
    local stats = safe(function() return player:getStats() end)
    if not stats then
        return nil
    end

    --- isHasACold lives on BodyDamage rather than Stats.
    local body = safe(function() return player:getBodyDamage() end)

    return {
        hunger = round2(safe(function() return stats:getHunger() end, 0)),
        thirst = round2(safe(function() return stats:getThirst() end, 0)),
        fatigue = round2(safe(function() return stats:getFatigue() end, 0)),
        endurance = round2(safe(function() return stats:getEndurance() end, 1)),
        stress = round2(safe(function() return stats:getStress() end, 0)),
        panic = round2(safe(function() return stats:getPanic() end, 0)),
        boredom = round2(safe(function() return stats:getBoredom() end, 0)),
        unhappiness = round2(safe(function() return stats:getUnhappiness() end, 0)),
        pain = round2(safe(function() return stats:getPain() end, 0)),
        wetness = round2(safe(function() return stats:getWetness() end, 0)),
        drunk = round2(safe(function() return stats:getDrunkenness() end, 0)),
        temperature = round2(safe(function() return stats:getBodyTemperature() end, 0)),
        sick = safe(function() return stats:isSick() end, false),
        has_cold = body and safe(function() return body:isHasACold() end, false) or false,
        food_sickness = round2(safe(function() return stats:getFoodSickness() end, 0)),
    }
end

--- What is in the character's hands: condition, and the firearm and blade
--- specifics that only exist on some weapons.
local function collectWeapon(player)
    local item = safe(function() return player:getPrimaryHandItem() end)
    if not item then
        return nil
    end

    local weapon = {
        name = safe(function() return item:getName() end),
        condition = round1(safe(function() return item:getCondition() end, 100)),
    }

    local sharpness = safe(function() return item:getSharpness() end)
    if sharpness ~= nil then
        weapon.sharpness = round1(sharpness)
    end

    weapon.ammo = safe(function() return item:getCurrentAmmoCount() end)
    weapon.chamber = safe(function() return item:isRoundChambered() end)
    weapon.jam = safe(function() return item:isJammed() end)

    local attachments = safe(function() return item:getAttachments() end)
    if attachments then
        local fitted = {}
        for index = 0, attachments:size() - 1 do
            local attachment = attachments:get(index)
            if attachment then
                fitted[#fitted + 1] = safe(function() return attachment:getName() end, "unknown")
            end
        end

        if #fitted > 0 then
            weapon.attachments = fitted
        end
    end

    return weapon
end

--- Worn clothing with the numbers that decide whether it is still worth
--- wearing: condition, holes, and what it stops.
local function collectClothing(player)
    local worn = safe(function() return player:getWornItems() end)
    if not worn then
        return nil
    end

    local items = {}
    for index = 0, worn:size() - 1 do
        local entry = worn:get(index)
        if entry then
            --- getWornItems hands back wrapper entries, not the garment.
            local item = safe(function() return entry:getItem() end, entry)

            if item then
                items[#items + 1] = {
                    slot = tostring(safe(function() return item:getBodyLocation() end, "unknown")),
                    name = safe(function() return item:getName() end, "unknown"),
                    condition = round1(safe(function() return item:getCondition() end, 100)),
                    holes = safe(function() return item:getHolesNumber() end, 0),
                    bite = round1(safe(function() return item:getBiteDefense() end, 0)),
                    scratch = round1(safe(function() return item:getScratchDefense() end, 0)),
                }
            end
        end
    end

    return { items = items }
end

--- The five equipment hotbar slots. An empty slot keeps its entry so the page
--- can draw the gap; the item key is simply absent.
local function collectQuickload(player)
    local inventory = safe(function() return player:getInventory() end)
    if not inventory then
        return nil
    end

    local slots = {}
    for index = 1, 5 do
        local item = safe(function() return inventory:getQuickloadItem(index - 1) end)

        slots[index] = {
            index = index,
            item = item and safe(function() return item:getName() end) or nil,
        }
    end

    return { slots = slots }
end

--- Carry load against capacity.
local function collectEncumbrance(player)
    local inventory = safe(function() return player:getInventory() end)
    if not inventory then
        return nil
    end

    return {
        current = round1(safe(function() return inventory:getCapacityWeight() end, 0)),
        capacity = round1(safe(function() return player:getMaxWeight() end, 20)),
    }
end

--- Recipes learned recently, newest last. KR_Boot fills this list from
--- OnRecipeLearned; the collector reads it without draining it, so the page
--- keeps showing the last handful rather than only what arrived since the
--- previous heartbeat.
local function collectRecipes(player)
    local modData = safe(function() return player:getModData() end)
    if not modData then
        return nil
    end

    local learned = modData[KR_Vitals.RECIPE_KEY]
    if type(learned) ~= "table" then
        return nil
    end

    local recipes = {}
    for _, recipe in ipairs(learned) do
        recipes[#recipes + 1] = {
            name = recipe.name or "unknown",
            learned_at = recipe.learned_at,
        }
    end

    return recipes
end

--------------------------------------------------------------------------
-- Heartbeat
--------------------------------------------------------------------------

--- Named collectors, run in order. Kept as a table so adding a panel is one
--- line and the pcall reporting below stays the same shape for all of them.
local PANELS = {
    { key = "info", collect = collectInfo },
    { key = "skills", collect = KR_Vitals.skills },
    { key = "protection", collect = collectProtection },
    { key = "temperature", collect = collectTemperature },
    { key = "moodles", collect = collectMoodles },
    { key = "weapon", collect = collectWeapon },
    { key = "clothing", collect = collectClothing },
    { key = "quickload", collect = collectQuickload },
    { key = "encumbrance", collect = collectEncumbrance },
    { key = "recipes", collect = collectRecipes },
}

--- Everything the dashboard draws for one player, or nil when the player
--- object is not usable yet.
function KR_Vitals.heartbeat(player)
    if not player then
        return nil
    end

    local username = safe(function() return player:getUsername() end)
    if not username or username == "" then
        return nil
    end

    local data = {}

    for _, panel in ipairs(PANELS) do
        local ok, collected = pcall(panel.collect, player)

        if ok then
            data[panel.key] = collected
        else
            print(LOG .. "WARNING: " .. panel.key .. " collector failed for " .. username .. ": " .. tostring(collected))
        end
    end

    --- Health and wounds come off one body walk, so they sit outside PANELS.
    local ok, health, injuries = pcall(collectBody, player)
    if ok then
        data.health = health
        data.wounds = injuries
    else
        print(LOG .. "WARNING: body collector failed for " .. username .. ": " .. tostring(health))
    end

    return data
end

--- Write one player's heartbeat. Falls back to a flat filename when the
--- vitals/ subdirectory cannot be written, as KR_Snapshot does.
function KR_Vitals.write(player)
    local data = KR_Vitals.heartbeat(player)
    if not data then
        return false
    end

    local username = player:getUsername()

    if Bridge.writeJson(DIRECTORY .. "/" .. username .. ".json", data) then
        return true
    end

    local flat = DIRECTORY .. "_" .. username .. ".json"
    if Bridge.writeJson(flat, data) then
        print(LOG .. "Wrote vitals via flat path: " .. flat)

        return true
    end

    print(LOG .. "ERROR: cannot write vitals for " .. username)

    return false
end

--- Export heartbeats for everyone online. Returns the number written.
function KR_Vitals.export()
    local players = Roster.online()
    if not players then
        return 0
    end

    local written = 0
    for _, player in ipairs(players) do
        if KR_Vitals.write(player) then
            written = written + 1
        end
    end

    return written
end

return KR_Vitals
