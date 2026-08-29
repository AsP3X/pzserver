--
-- Tests for KR_Stash.primeSpawned: shop-spawned fluid items must be a single
-- drinkable fluid, not a Water+CarbonatedWater mixture that PZ will pour but
-- not drink.
--
--   luajit game-server/tests/kr-stash.test.lua
--

local HERE = (arg and arg[0] or ""):match("^(.*[/\\])[^/\\]*$") or "./"
local MODS = HERE .. "../mods/KnoxRelay/42/media/lua/server/"

local pass, fail = 0, 0
local function ok(desc) pass = pass + 1; print("PASS: " .. desc) end
local function ng(desc, why) fail = fail + 1; print("FAIL: " .. desc .. " — " .. tostring(why)) end
local function check(desc, cond, why) if cond then ok(desc) else ng(desc, why or "assertion failed") end end

function instanceof() return false end

local Stash = assert(loadfile(MODS .. "KR_Stash.lua"))()

Fluid = { Water = "Water", Petrol = "Petrol" }

local function bottle(state)
    state = state or {}
    local emptied = false
    local added = nil
    local delta = nil
    local item = {
        setUsedDelta = function(_, value) delta = value end,
        getFluidContainer = function()
            return {
                isEmpty = function() return state.empty == true end,
                isMixture = function() return state.mixture == true end,
                isFull = function() return state.full == true end,
                contains = function(_, fluid) return fluid == (state.contains or Fluid.Water) end,
                isPureFluid = function(_, fluid) return state.pure == fluid end,
                canAddFluid = function(_, fluid)
                    if state.whitelist then
                        return fluid == state.whitelist
                    end
                    return true
                end,
                Empty = function() emptied = true end,
                addFluid = function(_, fluid, amount) added = { fluid = fluid, amount = amount } end,
                getCapacity = function() return state.capacity or 1.0 end,
                getPrimaryFluid = function() return state.primary end,
            }
        end,
    }
    return item, function() return emptied, added, delta end
end

local mixed, mixedSeen = bottle({ mixture = true, contains = Fluid.Water })
Stash.primeSpawned(mixed)
local emptied, added = mixedSeen()
check("empties a mixed water bottle", emptied == true)
check("refills mixed bottles with Water to capacity", added and added.fluid == Fluid.Water and added.amount == 1.0)

local empty, emptySeen = bottle({ empty = true, contains = Fluid.Water })
Stash.primeSpawned(empty)
emptied, added = emptySeen()
check("fills an empty water bottle", emptied == true and added and added.fluid == Fluid.Water)

local petrol, petrolSeen = bottle({
    empty = true,
    whitelist = Fluid.Petrol,
    primary = Fluid.Petrol,
    contains = Fluid.Petrol,
})
Stash.primeSpawned(petrol)
emptied, added = petrolSeen()
check("does not fill a petrol can with water", not added or added.fluid == Fluid.Petrol)

local full, fullSeen = bottle({ full = true, pure = Fluid.Water, contains = Fluid.Water })
Stash.primeSpawned(full)
emptied, added = fullSeen()
check("leaves a pure full water bottle alone", emptied == false and added == nil)

print("----------------------------------------")
print("Passed: " .. pass .. ", Failed: " .. fail)
if fail > 0 then os.exit(1) end
