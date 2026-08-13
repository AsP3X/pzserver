--
-- Tests for KR_Vitals, the live character dashboard export.
--
-- The collectors cannot be run inside a real game from CI, so the PZ globals
-- they touch are stubbed and a fake player is driven through the real module.
-- The codec and the JSON it emits are real, which is the half that has bitten
-- before: an encoder that mishandles an empty table breaks every heartbeat for
-- a player with no wounds.
--
-- The stubs below are deliberately strict. Version 1.7 shipped calling Build 41
-- accessors that Build 42 had moved — BodyDamage onto BodyPartType enums, the
-- Stats getters onto Stats.get(CharacterStat) — and every one of those calls
-- raised at runtime, was swallowed by KR_Vitals' own pcall guard, and returned
-- a default. The export looked healthy and was almost entirely fabricated. The
-- old stubs accepted whatever they were handed, so the suite passed throughout.
--
-- So: anything the engine type-checks, these stubs type-check too, and a method
-- the engine does not have is a method these do not define. A collector that
-- reaches for the wrong API now fails here instead of on a live server.
--
-- KR_Progress is exercised too. It shares the perk walk with KR_Vitals but must
-- keep exporting plain name -> level, since player_stats.json feeds the DB.
--
-- Project Zomboid runs Lua 5.1, so run this with luajit, not luaXX:
--   luajit game-server/tests/kr-vitals.test.lua   (exit 0 = all pass)
--

local HERE = (arg and arg[0] or ""):match("^(.*)/[^/]*$") or "."
local MODS = HERE .. "/../mods/KnoxRelay/42/media/lua/server/"

local pass, fail = 0, 0
local function ok(desc) pass = pass + 1; print("PASS: " .. desc) end
local function ng(desc, why) fail = fail + 1; print("FAIL: " .. desc .. " — " .. tostring(why)) end
local function check(desc, cond, why) if cond then ok(desc) else ng(desc, why or "assertion failed") end end

-- Real codec, loaded from source.
local Codec = assert(loadfile(MODS .. "KR_Codec.lua"))()
package.preload["KR_Codec"] = function() return Codec end

-- Fake bridge: captures writes instead of touching disk, but encodes for real
-- so an unencodable table still blows up here.
local written = {}
package.preload["KR_Bridge"] = function()
    return {
        VERSION = "1.11",
        wallStamp = function() return "2026-08-10T12:00:00" end,
        worldStamp = function() return "1993-07-09T12:00:00" end,
        writeText = function(path, body)
            written[path] = body
            return true
        end,
        writeJson = function(path, payload)
            written[path] = Codec.encode(payload)
            return true
        end,
    }
end

local roster = {}
package.preload["KR_Roster"] = function()
    return { online = function() return roster end }
end

--------------------------------------------------------------------------
-- PZ globals
--------------------------------------------------------------------------

local function list(items)
    return {
        size = function() return #items end,
        get = function(_, i) return items[i + 1] end,
    }
end

-- BodyPartType, in the engine's own order. Note there is no "Torso": Build 42
-- splits the trunk into Torso_Upper and Torso_Lower.
local PART_NAMES = {
    "Hand_L", "Hand_R", "ForeArm_L", "ForeArm_R", "UpperArm_L", "UpperArm_R",
    "Torso_Upper", "Torso_Lower", "Head", "Neck", "Groin",
    "UpperLeg_L", "UpperLeg_R", "LowerLeg_L", "LowerLeg_R", "Foot_L", "Foot_R",
}

local partTypes = {}
BodyPartType = {}
for index, name in ipairs(PART_NAMES) do
    local partType = { isBodyPartType = true, name = name, index = index - 1 }
    partTypes[index] = partType
    BodyPartType[name] = partType
end
BodyPartType.MAX = { isBodyPartType = true, name = "MAX", index = #PART_NAMES }
BodyPartType.FromIndex = function(i) return partTypes[i + 1] end
BodyPartType.ToIndex = function(t) return t.index end
BodyPartType.ToString = function(t) return t.name end

--- What the engine does when a String arrives where a BodyPartType belongs.
local function assertPartType(value)
    if type(value) ~= "table" or not value.isBodyPartType then
        error("expected argument of type BodyPartType, got " .. type(value), 0)
    end
    return value
end

-- CharacterStat, the Build 42 replacement for the per-stat getters.
CharacterStat = {}
for _, name in ipairs({
    "ANGER", "BOREDOM", "DISCOMFORT", "ENDURANCE", "FATIGUE", "FITNESS", "HUNGER",
    "IDLENESS", "INTOXICATION", "MORALE", "PAIN", "PANIC", "POISON", "SANITY",
    "SICKNESS", "STRESS", "TEMPERATURE", "THIRST", "UNHAPPINESS", "WETNESS",
}) do
    CharacterStat[name] = { isCharacterStat = true, name = name }
end

local STAT_VALUES = {
    HUNGER = 0.253, THIRST = 0.1, FATIGUE = 0, ENDURANCE = 0.9, STRESS = 0,
    PANIC = 0, BOREDOM = 0, UNHAPPINESS = 0, PAIN = 0.05, WETNESS = 0,
    INTOXICATION = 0, TEMPERATURE = 37, SICKNESS = 0, POISON = 0,
}

--- Cumulative XP to reach each level, which is what getTotalXpForLevel returns.
local function perk(name)
    return {
        getName = function() return name end,
        getTotalXpForLevel = function(_, level) return level * 100 end,
    }
end

local PERKS = { perk("Strength"), perk("Carpentry"), perk("Cooking") }
PerkFactory = { PerkList = list(PERKS) }
CharacterTraitDefinition = nil

local LEVELS = { Strength = 5, Carpentry = 2, Cooking = 0 }

--- One BodyPart. `injuries` is a set of flag names that read true.
local function bodyPart(injuries, treated)
    injuries = injuries or {}
    return {
        bitten = function() return injuries.bitten == true end,
        scratched = function() return injuries.scratched == true end,
        isDeepWounded = function() return injuries.deep == true end,
        isCut = function() return injuries.cut == true end,
        isBurnt = function() return injuries.burnt == true end,
        isInfectedWound = function() return injuries.infected == true end,
        getFractureTime = function() return injuries.fracture and 12 or 0 end,
        bandaged = function() return treated == true end,
        stitched = function() return false end,
    }
end

local function thermalNode(name)
    return {
        getName = function() return name end,
        getSkinCelcius = function() return name == "Hand_L" and 29.84 or 33.5 end,
        getInsulation = function() return name == "Torso_Upper" and 0.723 or 0.25 end,
    }
end

local function bodyDamage(injuries)
    return {
        getOverallBodyHealth = function() return 87.5 end,
        getBodyPartHealth = function(_, partType)
            assertPartType(partType)
            return partType.name == "Head" and 62.25 or 100
        end,
        getBodyPart = function(_, partType)
            assertPartType(partType)
            local onPart = injuries[partType.name]
            return bodyPart(onPart, onPart and onPart.treated)
        end,
        isHasACold = function() return false end,
        getThermoregulator = function()
            return {
                getCoreTemperature = function() return 37.02 end,
                getBodyHeatDelta = function() return 1.256 end,
                getNodeForType = function(_, partType)
                    assertPartType(partType)
                    return thermalNode(partType.name)
                end,
            }
        end,
    }
end

local function fakePlayer(name, opts)
    opts = opts or {}
    local modData = opts.modData or {}

    return {
        getUsername = function() return name end,
        getDescriptor = function()
            return { getCharacterProfession = function()
                return { getName = function() return "carpenter" end }
            end }
        end,
        getCharacterTraits = function()
            return { getKnownTraits = function() return list({ "Thickskinned", "Brave" }) end }
        end,
        getNutrition = function() return { getWeight = function() return 81.267 end } end,
        getZombieKills = function() return 412 end,
        getHoursSurvived = function() return 133.48 end,
        getPerkLevel = function(_, perk) return LEVELS[perk.getName()] or 0 end,
        getXp = function()
            return {
                --- A number. It used to be stubbed as an object with
                --- getTotalXp/getXpForLevel, which the engine has never had.
                getXP = function(_, p)
                    if p.getName() ~= "Strength" then return nil end
                    return 550
                end,
            }
        end,
        getBodyDamage = function() return bodyDamage(opts.injuries or {}) end,
        getStats = function()
            return {
                get = function(_, stat)
                    if type(stat) ~= "table" or not stat.isCharacterStat then
                        error("expected argument of type CharacterStat, got " .. type(stat), 0)
                    end
                    return STAT_VALUES[stat.name] or 0
                end,
            }
        end,
        getPrimaryHandItem = function()
            if opts.unarmed then return nil end
            return {
                getName = function() return "Axe" end,
                getCondition = function() return 74.4 end,
                hasSharpness = function() return true end,
                getSharpness = function() return 3 end,
                getMaxSharpness = function() return 5 end,
                getCurrentAmmoCount = function() return nil end,
                isRoundChambered = function() return nil end,
                isJammed = function() return nil end,
                getAttachmentsProvided = function() return list({ "Scope" }) end,
            }
        end,
        getWornItems = function()
            return list({
                {
                    getItem = function()
                        return {
                            IsClothing = function() return true end,
                            getBodyLocation = function() return "Torso" end,
                            getName = function() return "Jacket" end,
                            getCondition = function() return 90 end,
                            getHolesNumber = function() return 1 end,
                            getBiteDefense = function() return 40 end,
                            getScratchDefense = function() return 55 end,
                        }
                    end,
                },
                {
                    --- A backpack: worn, but not Clothing, so it has none of the
                    --- holes/defence accessors. Asking anyway used to raise once
                    --- per bag per heartbeat.
                    getItem = function()
                        return {
                            IsClothing = function() return false end,
                            getBodyLocation = function() return "Back" end,
                            getName = function() return "Big Hiking Bag" end,
                            getCondition = function() return 80 end,
                        }
                    end,
                },
            })
        end,
        getInventory = function()
            return { getCapacityWeight = function() return 8.32 end }
        end,
        getMaxWeight = function() return 20 end,
        getModData = function() return modData end,
        isDead = function() return false end,
    }
end

--- PZ runs Kahlua, whose base library has no `next` — pcall, select, type,
--- unpack and friends, but not that one. Dropping it here makes any use in mod
--- code fail in CI instead of once per heartbeat on a live server. `pairs` is
--- unaffected: it returns the builtin iterator rather than looking up a global.
next = nil

--------------------------------------------------------------------------
-- Load the real modules
--------------------------------------------------------------------------

package.path = MODS .. "?.lua;" .. package.path
local Vitals = assert(loadfile(MODS .. "KR_Vitals.lua"))()
package.preload["KR_Vitals"] = function() return Vitals end
local Progress = assert(loadfile(MODS .. "KR_Progress.lua"))()

--------------------------------------------------------------------------
-- Tests
--------------------------------------------------------------------------

local player = fakePlayer("Bob", {
    injuries = {
        Head = { scratched = true },
        ForeArm_L = { bitten = true, deep = true, treated = true },
    },
    modData = { KR_LearnedRecipes = { { name = "Make Stew", learned_at = "2026-08-10T11:00:00" } } },
})
roster = { player }

local beat = Vitals.heartbeat(player)

check("heartbeat is a keyed table", type(beat) == "table" and beat.info ~= nil)
check("profession is read off the CharacterProfession object",
    beat.info.profession == "carpenter", "got " .. tostring(beat.info.profession))
check("info carries the identity fields",
    beat.info.name == "Bob" and beat.info.profession == "carpenter" and beat.info.kills == 412,
    "got " .. tostring(beat.info.name) .. "/" .. tostring(beat.info.profession))
check("weight is rounded to 2dp", beat.info.weight == 81.27, "got " .. tostring(beat.info.weight))
check("hours survived is rounded to 1dp", beat.info.hours_survived == 133.5, "got " .. tostring(beat.info.hours_survived))
check("traits are collected", #beat.info.traits == 2, "got " .. #beat.info.traits)
check("no favourite weapon is claimed", beat.info.favourite_weapon == nil)

check("untrained perks are omitted", beat.skills.Cooking == nil)
check("trained perks carry their level", beat.skills.Strength.level == 5 and beat.skills.Carpentry.level == 2)
check("xp progress is a 0-1 fraction against the perk's own thresholds",
    beat.skills.Strength.xp == 0.5, "got " .. tostring(beat.skills.Strength.xp))
check("a perk with no xp entry still reports a level", beat.skills.Carpentry.xp == 0, "got " .. tostring(beat.skills.Carpentry.xp))

-- Body parts come from the enum, so the count and the names track the build.
check("overall health is exported", beat.health.overall == 87.5, "got " .. tostring(beat.health.overall))
check("every body part the enum defines is present", (function()
    local n = 0
    for _ in pairs(beat.health.parts) do n = n + 1 end
    return n
end)() == #PART_NAMES, "expected " .. #PART_NAMES)
check("the trunk is split, not a single Torso",
    beat.health.parts.Torso == nil and beat.health.parts.Torso_Upper ~= nil and beat.health.parts.Torso_Lower ~= nil)
check("a damaged part reports its own health", beat.health.parts.Head.health == 62.2 or beat.health.parts.Head.health == 62.3,
    "got " .. tostring(beat.health.parts.Head.health))
check("wound kinds land on the part", beat.health.parts.Head.wounds[1] == "Scratch")
check("a part carries every injury it has", #beat.health.parts.ForeArm_L.wounds == 2,
    "got " .. #beat.health.parts.ForeArm_L.wounds)
check("an uninjured part has an empty wound list", #beat.health.parts.Torso_Upper.wounds == 0)

check("the flat wound list is built from the same walk", #beat.wounds == 3, "got " .. #beat.wounds)
check("severity comes from the part's health", (function()
    for _, w in ipairs(beat.wounds) do
        if w.part == "Head" then return w.severity == "Moderate" end
    end
end)(), "Head at 62% should be Moderate")
check("a bandaged part reports its wounds treated", (function()
    for _, w in ipairs(beat.wounds) do
        if w.part == "ForeArm_L" then return w.treated == true end
    end
end)())

check("core temperature comes off the thermoregulator", beat.temperature.core == 37, "got " .. tostring(beat.temperature.core))
check("body heat is the thermoregulator delta", beat.temperature.body_heat == 1.26, "got " .. tostring(beat.temperature.body_heat))
check("per-part skin temperature is read from its node", beat.temperature.parts.Hand_L.skin == 29.8,
    "got " .. tostring(beat.temperature.parts.Hand_L.skin))
check("per-part insulation is read from its node", beat.temperature.parts.Torso_Upper.insulation == 0.72,
    "got " .. tostring(beat.temperature.parts.Torso_Upper.insulation))

check("moodles are read through CharacterStat", beat.moodles.hunger == 0.25, "got " .. tostring(beat.moodles.hunger))
check("intoxication maps to drunk", beat.moodles.drunk == 0)
check("sickness is a level, not a flag", beat.moodles.sickness == 0)
check("has_cold comes off BodyDamage", beat.moodles.has_cold == false)

check("the equipped weapon is reported", beat.weapon.name == "Axe" and beat.weapon.condition == 74.4)
check("sharpness is a proportion of the item's maximum", beat.weapon.sharpness == 60,
    "got " .. tostring(beat.weapon.sharpness))
check("attachments come from getAttachmentsProvided", beat.weapon.attachments[1] == "Scope")
check("absent firearm fields are omitted", beat.weapon.ammo == nil and beat.weapon.chamber == nil)
check("clothing is unwrapped from the worn entry", beat.clothing.items[1].name == "Jacket")
check("a worn non-garment is still listed", beat.clothing.items[2].name == "Big Hiking Bag")
check("a worn non-garment reports no holes or defence", (function()
    local bag = beat.clothing.items[2]
    return bag.holes == 0 and bag.bite == 0 and bag.scratch == 0
end)())
check("clothing keeps both defences", beat.clothing.items[1].bite == 40 and beat.clothing.items[1].scratch == 55)
check("encumbrance is load over capacity", beat.encumbrance.current == 8.3 and beat.encumbrance.capacity == 20)
check("recipes are read without draining", beat.recipes[1].name == "Make Stew")

-- Panels PZ has no API for must not be invented.
check("no protection panel is exported", beat.protection == nil)
check("no quickload panel is exported", beat.quickload == nil)

-- Export through the real codec.
local count = Vitals.export()
check("export writes one file per online player", count == 1, "got " .. tostring(count))

local body = written["vitals/Bob.json"]
check("the heartbeat lands at vitals/<username>.json", body ~= nil)
check("output is a JSON object, not a list", body and body:sub(1, 1) == "{", "starts with " .. tostring(body and body:sub(1, 1)))
check("no unencodable placeholder leaked in", body and not body:match("%{%[%]"), "found '{[]' in output")

-- A player with nothing wrong: every optional collector returns empty.
local clean = fakePlayer("Ann")
roster = { clean }
written = {}
Vitals.export()
local cleanBody = written["vitals/Ann.json"]
check("a clean player still produces valid output", cleanBody ~= nil and cleanBody:sub(1, 1) == "{")
check("a clean player's wound list is empty", cleanBody and cleanBody:match('"wounds":%[%]') ~= nil)

-- KR_Progress must still export levels only, through the shared walk.
roster = { player }
local rows = Progress.export()
check("progress still exports every online player", rows == 1, "got " .. tostring(rows))

local stats = written["player_stats.json"] or ""
check("player_stats.json is still written", stats ~= "")
-- The slow export must keep name -> level; the XP map is the heartbeat's shape.
check("progress skills stay a flat name -> level map",
    stats:match('"Strength":5') ~= nil and stats:match('"Strength":{') == nil,
    "skills block: " .. tostring(stats:match('"skills":.-}')))
check("progress still carries its own summary fields",
    stats:match('"zombie_kills":412') ~= nil and stats:match('"player_count":1') ~= nil)

local levels = Vitals.skills(player)
local flattened = {}
for name, perk in pairs(levels) do flattened[name] = perk.level end
check("the shared walk yields plain levels for progress",
    flattened.Strength == 5 and flattened.Carpentry == 2 and flattened.Cooking == nil)

-- The guard that would have caught 1.7: a String where a BodyPartType belongs
-- must raise, the way the engine does.
local raised = not pcall(function()
    return fakePlayer("Cal").getBodyDamage().getBodyPart(nil, "Head")
end)
check("passing a part name instead of a BodyPartType raises", raised)

print("----------------------------------------")
print("Passed: " .. pass .. ", Failed: " .. fail)
os.exit(fail == 0 and 0 or 1)
