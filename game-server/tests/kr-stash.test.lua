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

function instanceof(item, class)
    return type(item) == "table" and item.class == class
end

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

local function javaList(items)
    return {
        size = function() return #items end,
        get = function(_, index) return items[index + 1] end,
    }
end

local function itemOf(fullType, extras)
    extras = extras or {}
    local item = {
        class = extras.class,
        getFullType = function() return fullType end,
        getType = function() return string.match(fullType, "([^%.]+)$") or fullType end,
        getCategory = function() return extras.category end,
        getInventory = extras.getInventory,
        getItemContainer = extras.getItemContainer,
        getContainer = extras.getContainer,
    }
    return item
end

local function box(items)
    items = items or {}
    local container = {}
    container.getItems = function() return javaList(items) end
    container.getItemsFromFullType = function(_, fullType)
        local found = {}
        for _, entry in ipairs(items) do
            if entry:getFullType() == fullType then
                found[#found + 1] = entry
            end
        end
        return javaList(found)
    end
    container.DoRemoveItem = function(_, entry)
        for index, existing in ipairs(items) do
            if existing == entry then
                table.remove(items, index)
                return
            end
        end
    end
    return container
end

local note = itemOf("Base.Money")
local walletInv = box({ note })
note.getContainer = function() return walletInv end
local wallet = itemOf("Base.Wallet", {
    class = "InventoryContainer",
    category = "Container",
    getInventory = function() return walletInv end,
})
local pockets = box({ wallet })
local player = {
    getInventory = function() return pockets end,
    getClothingItem_Back = function() return nil end,
}

local found = Stash.containers(player)
check("a B42 wallet is a reachable container", #found == 2, #found)
check("wallet cash is counted", Stash.count(player, "Base.Money") == 1)
check("wallet cash can be located", Stash.locate(player, "Base.Money") == note)
Stash.detach(player, note)
check("wallet cash can be removed", Stash.count(player, "Base.Money") == 0)

local legacyNote = itemOf("Base.Money")
local legacyInv = box({ legacyNote })
legacyNote.getContainer = function() return legacyInv end
local legacyBag = itemOf("Base.Bag_Schoolbag", {
    category = "Container",
    getItemContainer = function() return legacyInv end,
})
local legacyPlayer = {
    getInventory = function() return box({ legacyBag }) end,
    getClothingItem_Back = function() return nil end,
}
check("older bags that only have getItemContainer still count", Stash.count(legacyPlayer, "Base.Money") == 1)

print("----------------------------------------")
print("Passed: " .. pass .. ", Failed: " .. fail)
if fail > 0 then os.exit(1) end
