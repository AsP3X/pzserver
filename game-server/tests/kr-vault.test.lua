--
-- Tests for KR_Vault: cash inside B42 wallets must be counted, removed,
-- and reported so the website can credit the balance.
--
--   luajit game-server/tests/kr-vault.test.lua
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

function isServer() return true end

local commands = {}
function sendServerCommand(player, module, command, args)
    commands[#commands + 1] = {
        username = player:getUsername(),
        module = module,
        command = command,
        args = args,
    }
end

local Stash = assert(loadfile(MODS .. "KR_Stash.lua"))()
package.preload["KR_Stash"] = function() return Stash end

local disk = {}
package.preload["KR_Bridge"] = function()
    return {
        wallStamp = function() return "2026-09-04T12:00:00" end,
        readJson = function(path) return disk[path] end,
        writeJson = function(path, payload)
            disk[path] = payload
            return true
        end,
    }
end

local online = {}
package.preload["KR_Roster"] = function()
    return {
        find = function(username) return online[username] end,
    }
end

local snapshots = 0
package.preload["KR_Snapshot"] = function()
    return {
        capture = function()
            snapshots = snapshots + 1
            return true
        end,
    }
end

local Vault = assert(loadfile(MODS .. "KR_Vault.lua"))()

local function javaList(items)
    return {
        size = function() return #items end,
        get = function(_, index) return items[index + 1] end,
    }
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
    container.AddItem = function(_, fullType)
        local added = {
            getFullType = function() return fullType end,
            getType = function() return string.match(fullType, "([^%.]+)$") or fullType end,
            getContainer = function() return container end,
        }
        items[#items + 1] = added
        return added
    end
    return container
end

local note = {
    class = nil,
    getFullType = function() return "Base.Money" end,
    getType = function() return "Money" end,
    getCategory = function() return "Junk" end,
}
local walletInv = box({ note })
note.getContainer = function() return walletInv end

local wallet = {
    class = "InventoryContainer",
    getFullType = function() return "Base.Wallet" end,
    getType = function() return "Wallet" end,
    getCategory = function() return "Container" end,
    getInventory = function() return walletInv end,
}

local pockets = box({ wallet })
local player = {
    getUsername = function() return "rook" end,
    getInventory = function() return pockets end,
    getClothingItem_Back = function() return nil end,
    isEquipped = function() return false end,
    getPrimaryHandItem = function() return nil end,
    getSecondaryHandItem = function() return nil end,
}
online.rook = player

disk["deposit_requests.json"] = {
    requests = {
        {
            id = "dep-1",
            username = "rook",
            status = "pending",
        },
    },
}
disk["money_deposit_config.json"] = { money_value = 1, bundle_value = 100 }

local recorded = Vault.process()
check("a wallet-only deposit is recorded", recorded == 1, recorded)

local result = disk["deposit_results.json"] and disk["deposit_results.json"].results[1]
check("the result is a success", result and result.status == "success", result and result.status)
check("the note inside the wallet is counted", result and result.money_count == 1, result and result.money_count)
check("the wallet is emptied", Stash.count(player, "Base.Money") == 0)
check("the client is told to drop the note", commands[1] and commands[1].command == "removeItem")
check("a snapshot is taken after the strip", snapshots == 1, snapshots)

print("----------------------------------------")
print("Passed: " .. pass .. ", Failed: " .. fail)
if fail > 0 then os.exit(1) end
