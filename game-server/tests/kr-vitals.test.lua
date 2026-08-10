--
-- Tests for KR_Vitals, the live character dashboard export.
--
-- The collectors cannot be run inside a real game from CI, so the PZ globals
-- they touch are stubbed and a fake player is driven through the real module.
-- The codec and the JSON it emits are real, which is the half that has bitten
-- before: an encoder that mishandles an empty table breaks every heartbeat for
-- a player with no wounds.
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
        VERSION = "1.7",
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

local PERKS = {
    { getName = function() return "Strength" end },
    { getName = function() return "Carpentry" end },
    { getName = function() return "Cooking" end },
}
PerkFactory = { PerkList = list(PERKS) }
CharacterTraitDefinition = nil

local LEVELS = { Strength = 5, Carpentry = 2, Cooking = 0 }

local function bodyDamage(wounds)
    return {
        getOverallBodyHealth = function() return 87.5 end,
        getBodyPartHealth = function(_, part) return part == "Head" and 62.25 or 100 end,
        getBodyPart = function(_, part)
            local onPart = wounds[part] or {}
            return { getWounds = function() return list(onPart) end }
        end,
        getBiteDefense = function(_, part) return part == "Torso" and 40 or 0 end,
        getScratchDefense = function(_, part) return part == "Torso" and 55 or 0 end,
        getSkinTemperature = function() return 36.6 end,
        getInsulation = function() return 0.4 end,
        getCoreTemp = function() return 37.02 end,
        getBodyHeat = function() return 1.25 end,
        isHasACold = function() return false end,
    }
end

local function wound(kind, severity, treated)
    return {
        getType = function() return kind end,
        getSeverity = function() return severity end,
        isTreated = function() return treated end,
    }
end

local function fakePlayer(name, opts)
    opts = opts or {}
    local modData = opts.modData or {}

    return {
        getUsername = function() return name end,
        getDescriptor = function() return { getProfession = function() return "carpenter" end } end,
        getCharacterTraits = function()
            return { getKnownTraits = function() return list({ "Thickskinned", "Brave" }) end }
        end,
        getNutrition = function() return { getWeight = function() return 81.267 end } end,
        getFavoriteWeapon = function() return "Axe" end,
        getZombieKills = function() return 412 end,
        getHoursSurvived = function() return 133.48 end,
        getPerkLevel = function(_, perk) return LEVELS[perk.getName()] or 0 end,
        getXp = function()
            return {
                getXP = function(_, perk)
                    if perk.getName() ~= "Strength" then return nil end
                    return {
                        getTotalXp = function() return 150 end,
                        getXpForLevel = function(_, lvl) return lvl == 6 and 200 or 100 end,
                    }
                end,
            }
        end,
        getBodyDamage = function() return bodyDamage(opts.wounds or {}) end,
        getStats = function()
            return {
                getHunger = function() return 0.253 end,
                getThirst = function() return 0.1 end,
                getFatigue = function() return 0 end,
                getEndurance = function() return 0.9 end,
                getStress = function() return 0 end,
                getPanic = function() return 0 end,
                getBoredom = function() return 0 end,
                getUnhappiness = function() return 0 end,
                getPain = function() return 0.05 end,
                getWetness = function() return 0 end,
                getDrunkenness = function() return 0 end,
                getBodyTemperature = function() return 37 end,
                isSick = function() return false end,
                getFoodSickness = function() return 0 end,
            }
        end,
        getPrimaryHandItem = function()
            if opts.unarmed then return nil end
            return {
                getName = function() return "Axe" end,
                getCondition = function() return 74.4 end,
                getSharpness = function() return 60 end,
                getCurrentAmmoCount = function() return nil end,
                isRoundChambered = function() return nil end,
                isJammed = function() return nil end,
                getAttachments = function() return nil end,
            }
        end,
        getWornItems = function()
            return list({
                {
                    getItem = function()
                        return {
                            getBodyLocation = function() return "Torso" end,
                            getName = function() return "Jacket" end,
                            getCondition = function() return 90 end,
                            getHolesNumber = function() return 1 end,
                            getBiteDefense = function() return 40 end,
                            getScratchDefense = function() return 55 end,
                        }
                    end,
                },
            })
        end,
        getInventory = function()
            return {
                getQuickloadItem = function(_, i) return i == 0 and { getName = function() return "Bandage" end } or nil end,
                getCapacityWeight = function() return 8.32 end,
            }
        end,
        getMaxWeight = function() return 20 end,
        getModData = function() return modData end,
        isDead = function() return false end,
    }
end

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
    wounds = { Head = { wound("Scratch", "Moderate", false) } },
    modData = { KR_LearnedRecipes = { { name = "Make Stew", learned_at = "2026-08-10T11:00:00" } } },
})
roster = { player }

local beat = Vitals.heartbeat(player)

check("heartbeat is a keyed table", type(beat) == "table" and beat.info ~= nil)
check("info carries the identity fields",
    beat.info.name == "Bob" and beat.info.profession == "carpenter" and beat.info.kills == 412,
    "got " .. tostring(beat.info.name) .. "/" .. tostring(beat.info.profession))
check("weight is rounded to 2dp", beat.info.weight == 81.27, "got " .. tostring(beat.info.weight))
check("hours survived is rounded to 1dp", beat.info.hours_survived == 133.5, "got " .. tostring(beat.info.hours_survived))
check("traits are collected", #beat.info.traits == 2, "got " .. #beat.info.traits)

check("untrained perks are omitted", beat.skills.Cooking == nil)
check("trained perks carry their level", beat.skills.Strength.level == 5 and beat.skills.Carpentry.level == 2)
check("xp progress is a 0-1 fraction", beat.skills.Strength.xp == 0.5, "got " .. tostring(beat.skills.Strength.xp))
check("a perk with no xp entry still reports a level", beat.skills.Carpentry.xp == 0, "got " .. tostring(beat.skills.Carpentry.xp))

check("overall health is exported", beat.health.overall == 87.5, "got " .. tostring(beat.health.overall))
check("all 16 body parts are present", (function()
    local n = 0
    for _ in pairs(beat.health.parts) do n = n + 1 end
    return n
end)() == 16)
check("a damaged part reports its own health", beat.health.parts.Head.health == 62.2 or beat.health.parts.Head.health == 62.3,
    "got " .. tostring(beat.health.parts.Head.health))
check("wound types land on the part", beat.health.parts.Head.wounds[1] == "Scratch")
check("an undamaged part has an empty wound list", #beat.health.parts.Torso.wounds == 0)

check("the flat wound list is built from the same walk", #beat.wounds == 1, "got " .. #beat.wounds)
check("the wound carries part, severity and treatment",
    beat.wounds[1].part == "Head" and beat.wounds[1].severity == "Moderate" and beat.wounds[1].treated == false)

check("uncovered parts are dropped from protection", beat.protection.parts.Head == nil)
check("covered parts keep both defences", beat.protection.parts.Torso.bite == 40 and beat.protection.parts.Torso.scratch == 55)

check("core temperature is rounded", beat.temperature.core == 37, "got " .. tostring(beat.temperature.core))
check("moodles are rounded to 2dp", beat.moodles.hunger == 0.25, "got " .. tostring(beat.moodles.hunger))
check("has_cold comes off BodyDamage", beat.moodles.has_cold == false)

check("the equipped weapon is reported", beat.weapon.name == "Axe" and beat.weapon.condition == 74.4)
check("absent firearm fields are omitted", beat.weapon.ammo == nil and beat.weapon.chamber == nil)
check("clothing is unwrapped from the worn entry", beat.clothing.items[1].name == "Jacket")
check("quickload keeps empty slots", #beat.quickload.slots == 5 and beat.quickload.slots[2].item == nil)
check("quickload reports a filled slot", beat.quickload.slots[1].item == "Bandage")
check("encumbrance is load over capacity", beat.encumbrance.current == 8.3 and beat.encumbrance.capacity == 20)
check("recipes are read without draining", beat.recipes[1].name == "Make Stew")

-- Export through the real codec.
local count = Vitals.export()
check("export writes one file per online player", count == 1, "got " .. tostring(count))

local body = written["vitals/Bob.json"]
check("the heartbeat lands at vitals/<username>.json", body ~= nil)
check("output is a JSON object, not a list", body and body:sub(1, 1) == "{", "starts with " .. tostring(body and body:sub(1, 1)))
check("no unencodable placeholder leaked in", body and not body:match("%{%[%]"), "found '{[]' in output")
check("an empty wound list encodes as []", body and body:match('"wounds":%[%]') ~= nil)

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

print("----------------------------------------")
print("Passed: " .. pass .. ", Failed: " .. fail)
os.exit(fail == 0 and 0 or 1)
