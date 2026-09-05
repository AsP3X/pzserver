--
-- KR_Vitals.lua — the live character dashboard for connected players.
--
-- Writes Lua/vitals/<username>.json per player: health and wounds per body
-- part, trained skills with XP progress, moodles, the equipped weapon, worn
-- clothing, body temperature, encumbrance and recently learned recipes. When
-- that subdirectory cannot be created a flat vitals_<username>.json is used
-- instead, the same fallback KR_Snapshot uses.
--
-- This is the fast, wide export: player_stats.json (KR_Progress) carries the
-- slow summary every ten minutes, this carries everything the player's own
-- character page draws, every ten seconds or so.
--
-- Every collector is wrapped in pcall. A body-part descriptor that is missing
-- on one build must cost that one panel, not the whole heartbeat.
--
-- That safety net is also why 1.7 looked healthy while being almost entirely
-- wrong: Build 42 moved BodyDamage onto BodyPartType enums, replaced the Stats
-- getters with Stats.get(CharacterStat), and never had per-part bite/scratch
-- defence, a quickload accessor or a favourite weapon at all. Every one of
-- those calls raised, was swallowed, and returned the default — so the page
-- drew 100% health, no wounds and a flat 37°C. Anything added here must be
-- checked against the real class, not assumed from an older build.
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

--- The body parts this build tracks, as { name, type } pairs.
---
--- Read out of the BodyPartType enum rather than hardcoded. Every BodyDamage
--- accessor takes a BodyPartType and rejects a string, so the names have to
--- come from the enum anyway — and a list written by hand had already drifted
--- from it, carrying a "Torso" the game has never had (it splits the trunk into
--- Torso_Upper and Torso_Lower). Built once at load: the enum cannot change
--- while the server runs.
local BODY_PARTS = {}

do
    if BodyPartType and BodyPartType.MAX then
        local ok, count = pcall(BodyPartType.ToIndex, BodyPartType.MAX)

        if ok and type(count) == "number" then
            for index = 0, count - 1 do
                local partType = select(2, pcall(BodyPartType.FromIndex, index))
                local name = partType and select(2, pcall(BodyPartType.ToString, partType))

                if partType and type(name) == "string" then
                    BODY_PARTS[#BODY_PARTS + 1] = { name = name, type = partType }
                end
            end
        end
    end

    if #BODY_PARTS == 0 then
        print("[KnoxRelay] WARNING: BodyPartType unavailable — per-part vitals will be empty")
    end
end

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

--- Call `object:method()` only when the method exists. A missing Java method
--- still dumps a Kahlua stack trace from inside pcall, so `safe()` is not
--- silent for firearm-only getters on a melee weapon.
local function callIf(object, method, default)
    if not object or not object[method] then
        return default
    end

    return safe(function() return object[method](object) end, default)
end

local function round1(value)
    value = tonumber(value) or 0

    return math.floor(value * 10 + 0.5) / 10
end

local function round2(value)
    value = tonumber(value) or 0

    return math.floor(value * 100 + 0.5) / 100
end

--- Wear as a 0–100 percentage of the item's own ceiling.
---
--- getCondition() is a raw count against getConditionMax(), not a percent.
--- Most clothing is 10/10, sneakers are 24/24, weapons vary. Reporting the
--- raw count made a pristine t-shirt look 10% worn on the dashboard.
local function conditionPercent(item)
    local current = safe(function() return item:getCondition() end)
    if current == nil then
        return 100
    end

    local ceiling = safe(function() return item:getConditionMax() end, 0)
    if ceiling and ceiling > 0 then
        return round1((current / ceiling) * 100)
    end

    --- No ceiling: treat the reading as already a percent, which is how the
    --- older export and the unit stubs without getConditionMax behave.
    return round1(current)
end

--- Whether a keyed table has no entries.
---
--- `next` is the obvious way to write this and is not available: PZ runs Kahlua,
--- whose base library ships pcall/select/type/unpack and friends but no `next`
--- at all, so calling it raises rather than returning nil.
local function isEmpty(collection)
    for _ in pairs(collection) do
        return false
    end

    return true
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

    --- getXP hands back the perk's total XP as a number, not an object to ask
    --- further questions of. The level thresholds live on the perk itself.
    local total = safe(function() return system:getXP(perk) end)
    if type(total) ~= "number" then
        return 0
    end

    local nextLevel = safe(function() return perk:getTotalXpForLevel(level + 1) end, 0)
    local thisLevel = safe(function() return perk:getTotalXpForLevel(level) end, 0)

    if nextLevel <= thisLevel or nextLevel <= 0 then
        return 0
    end

    --- A level reached without the XP behind it — an admin grant, a boost
    --- trait, a mod — puts this outside 0..1, so clamp rather than export a
    --- fraction every consumer has to defend against.
    local progress = (total - thisLevel) / (nextLevel - thisLevel)

    return round2(math.max(0, math.min(1, progress)))
end

--------------------------------------------------------------------------
-- Collectors
--------------------------------------------------------------------------

--- Who the character is: profession, traits, weight, favourite weapon, and the
--- two counters players actually compare with each other.
local function collectInfo(player)
    local info = {}

    info.name = safe(function() return player:getUsername() end)

    --- The descriptor holds a CharacterProfession object, not a name.
    local descriptor = safe(function() return player:getDescriptor() end)
    if descriptor then
        local profession = safe(function() return descriptor:getCharacterProfession() end)

        if profession then
            info.profession = safe(function() return profession:getName() end)
        end
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

    --- No favourite weapon here: PZ exposes nothing of the sort on a character,
    --- so the call it used to make raised once per heartbeat and always
    --- resolved to nil anyway.
    info.weight = round2(safe(function() return player:getNutrition():getWeight() end, 0))
    info.kills = safe(function() return player:getZombieKills() end, 0)
    info.hours_survived = round1(safe(function() return player:getHoursSurvived() end, 0))

    return info
end

--- Health and the wound list in one pass.
---
--- Both readings come off the same sixteen body parts, and the wound
--- collection is the expensive half, so they are gathered together and split
--- afterwards rather than walking the body twice per heartbeat.
--- The injuries a BodyPart can carry, each a predicate on the part itself.
---
--- PZ has no wound objects to walk: a BodyPart is a flat set of flags and
--- timers, one per kind of damage, so the list has to be assembled from them.
local INJURIES = {
    { kind = "Bite", present = function(part) return part:bitten() end },
    { kind = "Scratch", present = function(part) return part:scratched() end },
    { kind = "Deep wound", present = function(part) return part:isDeepWounded() end },
    { kind = "Cut", present = function(part) return part:isCut() end },
    { kind = "Burn", present = function(part) return part:isBurnt() end },
    { kind = "Fracture", present = function(part) return part:getFractureTime() > 0 end },
    { kind = "Infection", present = function(part) return part:isInfectedWound() end },
}

--- Wounds carry no severity of their own, so it comes from what the part they
--- sit on has been reduced to.
local function severityOf(health)
    if health < 34 then
        return "Severe"
    elseif health < 67 then
        return "Moderate"
    end

    return "Minor"
end

--- Health and the wound list in one pass.
---
--- Both readings come off the same body parts, and resolving a part is the
--- expensive half, so they are gathered together and split afterwards rather
--- than walking the body twice per heartbeat.
local function collectBody(player)
    local body = safe(function() return player:getBodyDamage() end)
    if not body then
        return nil, nil
    end

    local parts = {}
    local injuries = {}

    for _, entry in ipairs(BODY_PARTS) do
        local kinds = {}
        local part = safe(function() return body:getBodyPart(entry.type) end)
        local health = round1(safe(function() return body:getBodyPartHealth(entry.type) end, 100))

        if part then
            --- Bandaged or stitched is as close as PZ gets to "treated": there
            --- is no per-wound treatment flag, only these two on the part.
            local treated = safe(function() return part:bandaged() end, false)
                or safe(function() return part:stitched() end, false)

            for _, injury in ipairs(INJURIES) do
                if safe(function() return injury.present(part) end, false) then
                    kinds[#kinds + 1] = injury.kind
                    injuries[#injuries + 1] = {
                        part = entry.name,
                        type = injury.kind,
                        severity = severityOf(health),
                        treated = treated,
                    }
                end
            end
        end

        parts[entry.name] = {
            health = health,
            wounds = kinds,
        }
    end

    local health = {
        overall = round1(safe(function() return body:getOverallBodyHealth() end, 100)),
        parts = parts,
    }

    return health, injuries
end

--- Core temperature and body heat, plus skin temperature and insulation per
--- part — what tells a player they are freezing before the moodle does.
---
--- All of this hangs off the thermoregulator, which keeps one thermal node per
--- body part. BodyDamage itself exposes no temperature accessors at all.
local function collectTemperature(player)
    local body = safe(function() return player:getBodyDamage() end)
    if not body then
        return nil
    end

    local thermo = safe(function() return body:getThermoregulator() end)
    if not thermo then
        return nil
    end

    local parts = {}
    for _, entry in ipairs(BODY_PARTS) do
        local node = safe(function() return thermo:getNodeForType(entry.type) end)

        if node then
            parts[entry.name] = {
                skin = round1(safe(function() return node:getSkinCelcius() end, 37)),
                insulation = round2(safe(function() return node:getInsulation() end, 0)),
            }
        end
    end

    if isEmpty(parts) then
        return nil
    end

    return {
        core = round1(safe(function() return thermo:getCoreTemperature() end, 37)),
        body_heat = round2(safe(function() return thermo:getBodyHeatDelta() end, 0)),
        parts = parts,
    }
end

--- The moodles this exports, as JSON key -> CharacterStat member.
---
--- Build 42 replaced the per-stat getters (getHunger, getThirst, ...) with a
--- single enum-keyed Stats.get(CharacterStat), so every one of the old calls
--- raised "No implementation found" once per heartbeat.
local MOODLE_STATS = {
    { key = "hunger", stat = "HUNGER", default = 0 },
    { key = "thirst", stat = "THIRST", default = 0 },
    { key = "fatigue", stat = "FATIGUE", default = 0 },
    { key = "endurance", stat = "ENDURANCE", default = 1 },
    { key = "stress", stat = "STRESS", default = 0 },
    { key = "panic", stat = "PANIC", default = 0 },
    { key = "boredom", stat = "BOREDOM", default = 0 },
    { key = "unhappiness", stat = "UNHAPPINESS", default = 0 },
    { key = "pain", stat = "PAIN", default = 0 },
    { key = "wetness", stat = "WETNESS", default = 0 },
    { key = "drunk", stat = "INTOXICATION", default = 0 },
    { key = "temperature", stat = "TEMPERATURE", default = 0 },
    { key = "sickness", stat = "SICKNESS", default = 0 },
    { key = "food_sickness", stat = "POISON", default = 0 },
}

--- The full HUD moodle stack.
---
--- Each CharacterStat has its own ceiling. Hunger is 0–1, boredom/panic/pain/
--- wetness/unhappiness/intoxication/poison are 0–100, temperature is Celsius.
--- The dashboard always wants a 0–1 fraction, so we divide by getMaximumValue()
--- except for temperature, which is shown as degrees, not a bar.
local function collectMoodles(player)
    local stats = safe(function() return player:getStats() end)
    if not stats or not CharacterStat then
        return nil
    end

    local moodles = {}

    for _, entry in ipairs(MOODLE_STATS) do
        local member = CharacterStat[entry.stat]

        if member then
            local current = safe(function() return stats:get(member) end, entry.default)

            if entry.key == "temperature" then
                moodles[entry.key] = round2(current)
            else
                local ceiling = safe(function() return member:getMaximumValue() end, 0)

                if ceiling and ceiling > 0 then
                    moodles[entry.key] = round2(current / ceiling)
                else
                    moodles[entry.key] = round2(current)
                end
            end
        end
    end

    --- isHasACold lives on BodyDamage rather than Stats.
    local body = safe(function() return player:getBodyDamage() end)
    moodles.has_cold = body and safe(function() return body:isHasACold() end, false) or false

    return moodles
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
        condition = conditionPercent(item),
    }

    --- Sharpness is an absolute value against the item's own maximum, so it
    --- only means anything as a proportion of it.
    if callIf(item, "hasSharpness", false) then
        local sharpness = callIf(item, "getSharpness", 0)
        local maximum = callIf(item, "getMaxSharpness", 0)

        if maximum > 0 then
            weapon.sharpness = round1(sharpness / maximum * 100)
        end
    end

    --- Firearm-only. Calling these on an axe logs a Java exception every
    --- heartbeat even when wrapped in pcall.
    weapon.ammo = callIf(item, "getCurrentAmmoCount")
    weapon.chamber = callIf(item, "isRoundChambered")
    weapon.jam = callIf(item, "isJammed")

    --- getAttachmentsProvided, not getAttachments, and it is a list of plain
    --- strings rather than of items.
    local attachments = callIf(item, "getAttachmentsProvided")
    if attachments then
        local fitted = {}
        for index = 0, safe(function() return attachments:size() end, 0) - 1 do
            local attachment = safe(function() return attachments:get(index) end)
            if attachment then
                fitted[#fitted + 1] = tostring(attachment)
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
                local garment = {
                    slot = tostring(safe(function() return item:getBodyLocation() end, "unknown")),
                    name = safe(function() return item:getName() end, "unknown"),
                    condition = conditionPercent(item),
                    holes = 0,
                    bite = 0,
                    scratch = 0,
                }

                --- Holes and defence live on Clothing, and a worn slot can hold
                --- something that is not one — a backpack is the common case.
                --- Asking anyway raises once per bag per heartbeat.
                if safe(function() return item:IsClothing() end, false) then
                    garment.holes = safe(function() return item:getHolesNumber() end, 0)
                    garment.bite = round1(safe(function() return item:getBiteDefense() end, 0))
                    garment.scratch = round1(safe(function() return item:getScratchDefense() end, 0))
                end

                items[#items + 1] = garment
            end
        end
    end

    return { items = items }
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
--- No per-body-part protection collector sits here on purpose. PZ exposes bite
--- and scratch defence on the garment only — there is no accessor for what a
--- body part ends up protected by, and vanilla's own UI never shows one. The
--- clothing panel carries both figures per garment instead, which is the same
--- information in the shape the game actually keeps it.
local PANELS = {
    { key = "info", collect = collectInfo },
    { key = "skills", collect = KR_Vitals.skills },
    { key = "temperature", collect = collectTemperature },
    { key = "moodles", collect = collectMoodles },
    { key = "weapon", collect = collectWeapon },
    { key = "clothing", collect = collectClothing },
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
