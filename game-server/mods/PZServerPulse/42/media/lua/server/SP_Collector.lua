--
-- SP_Collector.lua — gathers live character data from every online player.
--
-- Each collector function receives an IsoPlayer and returns a table (or nil
-- when the data is not available). Collectors are wrapped in pcall so one
-- broken descriptor cannot take down the whole export.
--

local Bridge = require("SP_Bridge")

SP_Collector = {}

local LOG = "[PZServerPulse] "

--------------------------------------------------------------------------
-- Utility
--------------------------------------------------------------------------

local function safe(fn, default)
    local ok, val = pcall(fn)
    if ok and val ~= nil then return val end
    return default
end

local function round2(v)
    v = tonumber(v) or 0
    return math.floor(v * 100 + 0.5) / 100
end

local function round1(v)
    v = tonumber(v) or 0
    return math.floor(v * 10 + 0.5) / 10
end

--------------------------------------------------------------------------
-- Body part list (the 16 parts PZ tracks)
--------------------------------------------------------------------------

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
-- Collectors
--------------------------------------------------------------------------

--- Basic character info: profession, traits, weight, favourite weapon.
local function collectInfo(player)
    local info = {}

    info.name = safe(function() return player:getUsername() end)

    local desc = safe(function() return player:getDescriptor() end)
    if desc then
        info.profession = safe(function() return desc.getProfession and desc:getProfession() end)
    end

    -- Traits
    local traitList = {}
    if player.getCharacterTraits then
        local coll = player:getCharacterTraits()
        if coll and coll.getKnownTraits then
            local known = coll:getKnownTraits()
            if known then
                for i = 0, known:size() - 1 do
                    local id = known:get(i)
                    local label = tostring(id)
                    if CharacterTraitDefinition then
                        local ok, def = pcall(CharacterTraitDefinition.getCharacterTraitDefinition, id)
                        if ok and def and def.getLabel then
                            label = def:getLabel() or label
                        end
                    end
                    traitList[#traitList + 1] = label
                end
            end
        end
    end
    info.traits = traitList

    -- Weight
    info.weight = round2(safe(function() return player:getNutrition():getWeight() end, 0))

    -- Favourite weapon
    info.favourite_weapon = safe(function() return player:getFavoriteWeapon() end)

    -- Kills and survival time
    info.kills = safe(function() return player:getZombieKills() end, 0)
    info.hours_survived = round1(safe(function() return player:getHoursSurvived() end, 0))

    return info
end

--- Skills with XP progress.
local function collectSkills(player)
    local skills = {}
    local catalogue = PerkFactory and PerkFactory.PerkList
    if not catalogue then return skills end

    for i = 0, catalogue:size() - 1 do
        local perk = catalogue:get(i)
        if perk then
            local name = safe(function() return perk:getName() end)
            if name then
                local level = safe(function() return player:getPerkLevel(perk) end, 0)
                if level > 0 then
                    local xpPct = 0
                    -- getXp() may return nil for freshly-spawned players; safe() handles that
                    local xpSystem = safe(function() return player:getXp() end)
                    if xpSystem then
                        local perkInfo = safe(function() return xpSystem:getXP(perk) end)
                        if perkInfo then
                            local totalXp = safe(function() return perkInfo:getTotalXp() end, 0)
                            local nextLvl = safe(function() return perkInfo:getXpForLevel(level + 1) end, 0)
                            local prevLvl = safe(function() return perkInfo:getXpForLevel(level) end, 0)
                            if nextLvl > prevLvl and nextLvl > 0 then
                                xpPct = round2((totalXp - prevLvl) / (nextLvl - prevLvl))
                            end
                        end
                    end
                    skills[name] = { level = level, xp = xpPct }
                end
            end
        end
    end

    return skills
end

--- Health: overall + per-body-part damage and wound flags.
local function collectHealth(player)
    local body = safe(function() return player:getBodyDamage() end)
    if not body then return nil end

    local health = {}
    health.overall = round1(safe(function() return body:getOverallBodyHealth() end, 100))

    local parts = {}
    for _, partName in ipairs(BODY_PARTS) do
        local partHealth = round1(safe(function() return body:getBodyPartHealth(partName) end, 100))
        local wounds = {}
        -- getBodyPart may not exist on all builds; safe() handles that
        local bp = safe(function() return body:getBodyPart(partName) end)
        if bp then
            local woundCount = safe(function() return bp:getWounds():size() end, 0)
            for w = 0, woundCount - 1 do
                local wound = safe(function() return bp:getWounds():get(w) end)
                if wound then
                    local wType = safe(function() return wound:getType() end, "unknown")
                    wounds[#wounds + 1] = tostring(wType)
                end
            end
        end
        parts[partName] = { health = partHealth, wounds = wounds }
    end
    health.parts = parts

    return health
end

--- Protection: bite/scratch defense per body part from clothing.
local function collectProtection(player)
    local body = safe(function() return player:getBodyDamage() end)
    if not body then return nil end

    local parts = {}
    for _, partName in ipairs(BODY_PARTS) do
        local bite = round1(safe(function() return body:getBiteDefense(partName) end, 0))
        local scratch = round1(safe(function() return body:getScratchDefense(partName) end, 0))
        if bite > 0 or scratch > 0 then
            parts[partName] = { bite = bite, scratch = scratch }
        end
    end

    if next(parts) == nil then return nil end
    return { parts = parts }
end

--- Body temperature: core temp, body heat, per-part skin temp / insulation.
local function collectTemperature(player)
    local body = safe(function() return player:getBodyDamage() end)
    if not body then return nil end

    local temp = {}
    temp.core = round1(safe(function() return body:getCoreTemp() end, 37))
    temp.body_heat = round1(safe(function() return body:getBodyHeat() end, 0))

    local parts = {}
    for _, partName in ipairs(BODY_PARTS) do
        local skin = round1(safe(function() return body:getSkinTemperature(partName) end, 37))
        local insulation = round1(safe(function() return body:getInsulation(partName) end, 0))
        parts[partName] = { skin = skin, insulation = insulation }
    end
    temp.parts = parts

    return temp
end

--- Moodles & needs: the full HUD moodle stack.
local function collectMoodles(player)
    local stats = safe(function() return player:getStats() end)
    if not stats then return nil end

    -- isHasACold lives on BodyDamage, not Stats
    local body = safe(function() return player:getBodyDamage() end)

    return {
        hunger      = round2(safe(function() return stats:getHunger() end, 0)),
        thirst      = round2(safe(function() return stats:getThirst() end, 0)),
        fatigue     = round2(safe(function() return stats:getFatigue() end, 0)),
        endurance   = round2(safe(function() return stats:getEndurance() end, 1)),
        stress      = round2(safe(function() return stats:getStress() end, 0)),
        panic       = round2(safe(function() return stats:getPanic() end, 0)),
        boredom     = round2(safe(function() return stats:getBoredom() end, 0)),
        unhappiness = round2(safe(function() return stats:getUnhappiness() end, 0)),
        pain        = round2(safe(function() return stats:getPain() end, 0)),
        wetness     = round2(safe(function() return stats:getWetness() end, 0)),
        drunk       = round2(safe(function() return stats:getDrunkenness() end, 0)),
        temperature = round2(safe(function() return stats:getBodyTemperature() end, 0)),
        sick        = safe(function() return stats:isSick() end, false),
        has_cold    = body and safe(function() return body:isHasACold() end, false) or false,
        food_sickness = round2(safe(function() return stats:getFoodSickness() end, 0)),
    }
end

--- Weapon condition: in-hand durability, sharpness, ammo, attachments.
local function collectWeapon(player)
    local item = safe(function() return player:getPrimaryHandItem() end)
    if not item then return nil end

    local weapon = {}
    weapon.name = safe(function() return item:getName() end)
    weapon.condition = round1(safe(function() return item:getCondition() end, 100))

    -- Sharpness (blade weapons) — use safe() instead of if item.getSharpness
    local sharpness = safe(function() return item:getSharpness() end)
    if sharpness ~= nil then
        weapon.sharpness = round1(sharpness)
    end

    -- Firearm specifics — use safe() instead of if item.getCurrentAmmoCount
    local ammo = safe(function() return item:getCurrentAmmoCount() end)
    if ammo ~= nil then
        weapon.ammo = ammo
    end
    local chambered = safe(function() return item:isRoundChambered() end)
    if chambered ~= nil then
        weapon.chamber = chambered
    end
    local jammed = safe(function() return item:isJammed() end)
    if jammed ~= nil then
        weapon.jam = jammed
    end

    -- Attachments — use safe() instead of if item.getAttachments
    local atts = safe(function() return item:getAttachments() end)
    if atts then
        local attList = {}
        for i = 0, atts:size() - 1 do
            local att = atts:get(i)
            if att then
                attList[#attList + 1] = safe(function() return att:getName() end, "unknown")
            end
        end
        if #attList > 0 then weapon.attachments = attList end
    end

    return weapon
end

--- Clothing: per-garment condition, holes, and protection.
local function collectClothing(player)
    local worn = safe(function() return player:getWornItems() end)
    if not worn then return nil end

    local items = {}
    for i = 0, worn:size() - 1 do
        local entry = worn:get(i)
        if entry then
            -- getWornItems returns wrapper entries; unwrap to the real item
            local item = entry
            if entry.getItem then
                item = entry:getItem()
            end
            if item then
                local slot = safe(function() return item:getBodyLocation() end, "unknown")
                items[#items + 1] = {
                    slot      = tostring(slot),
                    name      = safe(function() return item:getName() end, "unknown"),
                    condition = round1(safe(function() return item:getCondition() end, 100)),
                    holes     = safe(function() return item:getHolesNumber() end, 0),
                    bite      = round1(safe(function() return item:getBiteDefense() end, 0)),
                    scratch   = round1(safe(function() return item:getScratchDefense() end, 0)),
                }
            end
        end
    end

    return { items = items }
end

--- Quickload slots: equipment hotbar.
local function collectQuickload(player)
    local inv = safe(function() return player:getInventory() end)
    if not inv then return nil end

    local slots = {}
    for i = 1, 5 do
        local item = safe(function() return inv:getQuickloadItem(i - 1) end)
        slots[i] = {
            index = i,
            item  = item and safe(function() return item:getName() end),
        }
    end

    return { slots = slots }
end

--- Encumbrance: carry load vs. capacity.
local function collectEncumbrance(player)
    local inv = safe(function() return player:getInventory() end)
    if not inv then return nil end

    local current = round1(safe(function() return inv:getCapacityWeight() end, 0))
    local capacity = round1(safe(function() return player:getMaxWeight() end, 20))

    return {
        current = current,
        capacity = capacity,
    }
end

--- Open wounds: triage list of active, untreated injuries.
local function collectWounds(player)
    local body = safe(function() return player:getBodyDamage() end)
    if not body then return nil end

    local wounds = {}
    for _, partName in ipairs(BODY_PARTS) do
        local bp = safe(function() return body:getBodyPart(partName) end)
        if bp then
            local wc = safe(function() return bp:getWounds():size() end, 0)
            for w = 0, wc - 1 do
                local wound = safe(function() return bp:getWounds():get(w) end)
                if wound then
                    wounds[#wounds + 1] = {
                        part     = partName,
                        type     = tostring(safe(function() return wound:getType() end, "unknown")),
                        severity = tostring(safe(function() return wound:getSeverity() end, "unknown")),
                        treated  = safe(function() return wound:isTreated() end, false),
                    }
                end
            end
        end
    end

    return wounds
end

--- Recent recipes: transient note when you learn something new.
local function collectRecipes(player)
    -- Recipes learned are stored in modData by the game
    local modData = safe(function() return player:getModData() end)
    if not modData then return nil end

    local learned = modData["SP_LearnedRecipes"]
    if not learned or type(learned) ~= "table" then return nil end

    local recipes = {}
    for _, recipe in ipairs(learned) do
        recipes[#recipes + 1] = {
            name       = recipe.name or "unknown",
            learned_at = recipe.learned_at,
        }
    end

    return recipes
end

--------------------------------------------------------------------------
-- Full heartbeat export for a single player
--------------------------------------------------------------------------

--- Gather every panel for one player. Returns nil when the player object
--- is not usable.
function SP_Collector.heartbeat(player)
    if not player or not player.getUsername then return nil end

    local username = player:getUsername()
    if not username or username == "" then return nil end

    local data = {}

    -- Each collector is wrapped in pcall so one broken subsystem cannot
    -- prevent the rest of the heartbeat from being written.
    local ok

    ok, data.info = pcall(collectInfo, player)
    if not ok then
        print(LOG .. "WARNING: info collector failed for " .. username .. ": " .. tostring(data.info))
        data.info = nil
    end

    ok, data.skills = pcall(collectSkills, player)
    if not ok then
        print(LOG .. "WARNING: skills collector failed for " .. username .. ": " .. tostring(data.skills))
        data.skills = nil
    end

    ok, data.health = pcall(collectHealth, player)
    if not ok then
        print(LOG .. "WARNING: health collector failed for " .. username .. ": " .. tostring(data.health))
        data.health = nil
    end

    ok, data.protection = pcall(collectProtection, player)
    if not ok then
        print(LOG .. "WARNING: protection collector failed for " .. username .. ": " .. tostring(data.protection))
        data.protection = nil
    end

    ok, data.temperature = pcall(collectTemperature, player)
    if not ok then
        print(LOG .. "WARNING: temperature collector failed for " .. username .. ": " .. tostring(data.temperature))
        data.temperature = nil
    end

    ok, data.moodles = pcall(collectMoodles, player)
    if not ok then
        print(LOG .. "WARNING: moodles collector failed for " .. username .. ": " .. tostring(data.moodles))
        data.moodles = nil
    end

    ok, data.weapon = pcall(collectWeapon, player)
    if not ok then
        print(LOG .. "WARNING: weapon collector failed for " .. username .. ": " .. tostring(data.weapon))
        data.weapon = nil
    end

    ok, data.clothing = pcall(collectClothing, player)
    if not ok then
        print(LOG .. "WARNING: clothing collector failed for " .. username .. ": " .. tostring(data.clothing))
        data.clothing = nil
    end

    ok, data.quickload = pcall(collectQuickload, player)
    if not ok then
        print(LOG .. "WARNING: quickload collector failed for " .. username .. ": " .. tostring(data.quickload))
        data.quickload = nil
    end

    ok, data.encumbrance = pcall(collectEncumbrance, player)
    if not ok then
        print(LOG .. "WARNING: encumbrance collector failed for " .. username .. ": " .. tostring(data.encumbrance))
        data.encumbrance = nil
    end

    ok, data.wounds = pcall(collectWounds, player)
    if not ok then
        print(LOG .. "WARNING: wounds collector failed for " .. username .. ": " .. tostring(data.wounds))
        data.wounds = nil
    end

    ok, data.recipes = pcall(collectRecipes, player)
    if not ok then
        print(LOG .. "WARNING: recipes collector failed for " .. username .. ": " .. tostring(data.recipes))
        data.recipes = nil
    end

    return data
end

--- Write a heartbeat file for a single player.
--- Tries the PZServerPulse/ subdirectory first, then falls back to a flat
--- filename in the Lua root (pzsp_<username>.json) when the subdirectory
--- cannot be created — same pattern KnoxRelay uses for inventory snapshots.
function SP_Collector.writeHeartbeat(player)
    local data = SP_Collector.heartbeat(player)
    if not data then return false end

    local username = player:getUsername()
    local filename = "PZServerPulse/" .. username .. ".json"

    if Bridge.writeJson(filename, data) then
        return true
    end

    -- Flat fallback when the subdirectory is unwritable
    local flat = "pzsp_" .. username .. ".json"
    if Bridge.writeJson(flat, data) then
        print(LOG .. "Wrote heartbeat via flat path: " .. flat)
        return true
    end

    print(LOG .. "ERROR: cannot write heartbeat for " .. username)
    return false
end

--- Export heartbeats for all online players.
--- Returns the number of players exported.
function SP_Collector.exportAll()
    local connected = getOnlinePlayers()
    if not connected then return 0 end

    local count = 0
    for i = 0, connected:size() - 1 do
        local player = connected:get(i)
        if player and player.getUsername then
            if SP_Collector.writeHeartbeat(player) then
                count = count + 1
            end
        end
    end

    return count
end

return SP_Collector
