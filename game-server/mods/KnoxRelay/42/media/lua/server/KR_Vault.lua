--
-- KR_Vault.lua — converting in-game cash into wallet coins.
--
-- The panel queues a deposit in deposit_requests.json; this module strips every
-- Base.Money and Base.MoneyBundle off the player — including notes sitting in
-- wallets and other bags — and reports the tally in deposit_results.json.
-- The panel polls for that result and only then credits the website wallet.
--
-- The ordering is items-first, and the result file is the point of no return:
-- a player is considered charged only once their result has been written. If
-- the write fails after the cash was taken, the cash is put back so nobody
-- loses money to a broken bind mount. The request stays pending and is retried.
--
-- Coin rates come from money_deposit_config.json (Admin -> Lua Bridge) and
-- fall back to 1 per note and 100 per bundle.
--

local Bridge = require("KR_Bridge")
local Roster = require("KR_Roster")
local Stash = require("KR_Stash")
local Snapshot = require("KR_Snapshot")

KR_Vault = {}

local LOG = "[KnoxRelay] "
local REQUESTS = "deposit_requests.json"
local RESULTS = "deposit_results.json"
local RATES = "money_deposit_config.json"
local RESULT_LIMIT = 200

local NOTE = "Base.Money"
local BUNDLE = "Base.MoneyBundle"

--- Guard against a container whose contents never shrink, which would
--- otherwise spin the server forever.
local REMOVE_CEILING = 10000

--------------------------------------------------------------------------
-- Configuration
--------------------------------------------------------------------------

--- @return number coins per note, number coins per bundle
local function rates()
    local perNote = 1
    local perBundle = 100

    local config = Bridge.readJson(RATES)
    if config then
        if config.money_value ~= nil then
            perNote = tonumber(config.money_value) or perNote
        end
        if config.bundle_value ~= nil then
            perBundle = tonumber(config.bundle_value) or perBundle
        elseif config.stack_value ~= nil then
            perBundle = tonumber(config.stack_value) or perBundle
        end
    end

    return perNote, perBundle
end

--------------------------------------------------------------------------
-- Result ledger
--------------------------------------------------------------------------

local function loadLedger()
    return Bridge.readJson(RESULTS) or { version = 1, updated_at = "", results = {} }
end

local function saveLedger(ledger)
    ledger.updated_at = Bridge.wallStamp()

    while ledger.results and #ledger.results > RESULT_LIMIT do
        table.remove(ledger.results, 1)
    end

    return Bridge.writeJson(RESULTS, ledger)
end

--- Append a result and persist immediately. On a failed write the entry is
--- rolled back out of the in-memory ledger so the caller can undo the removal.
local function commit(ledger, result)
    ledger.results[#ledger.results + 1] = result

    if saveLedger(ledger) then
        return true
    end

    table.remove(ledger.results, #ledger.results)

    return false
end

--------------------------------------------------------------------------
-- Cash handling
--------------------------------------------------------------------------

--- @return number notes, number bundles held anywhere on the player
local function tally(player)
    return Stash.count(player, NOTE), Stash.count(player, BUNDLE)
end

local function drainType(player, fullType)
    local removed = 0
    while true do
        local item = Stash.locate(player, fullType)
        if not item then
            break
        end

        Stash.detach(player, item)
        removed = removed + 1
        if removed > REMOVE_CEILING then
            print(LOG .. "WARNING: hit safety limit removing " .. fullType)
            break
        end
    end

    return removed
end

--- @return number notes, number bundles actually taken
local function confiscate(player)
    local notes = drainType(player, NOTE)
    local bundles = drainType(player, BUNDLE)

    if isServer() then
        if notes > 0 then
            sendServerCommand(player, "KnoxRelay", "removeItem", {
                item_type = NOTE,
                count = tostring(notes),
            })
        end
        if bundles > 0 then
            sendServerCommand(player, "KnoxRelay", "removeItem", {
                item_type = BUNDLE,
                count = tostring(bundles),
            })
        end
    end

    return notes, bundles
end

--- Put cash back into the main inventory after a deposit could not be
--- recorded. Never leaves a player poorer than before the attempt.
local function refund(player, notes, bundles)
    if not player then
        return
    end

    local inventory = player:getInventory()
    if not inventory then
        return
    end

    notes = notes or 0
    bundles = bundles or 0

    for _ = 1, notes do
        inventory:AddItem(NOTE)
    end
    for _ = 1, bundles do
        inventory:AddItem(BUNDLE)
    end

    if isServer() then
        if notes > 0 then
            sendServerCommand(player, "KnoxRelay", "addItem", {
                item_type = NOTE,
                count = tostring(notes),
            })
        end
        if bundles > 0 then
            sendServerCommand(player, "KnoxRelay", "addItem", {
                item_type = BUNDLE,
                count = tostring(bundles),
            })
        end
    end

    print(LOG .. "Restored " .. notes .. " Money + " .. bundles
        .. " MoneyBundle to " .. (player:getUsername() or "?")
        .. " after failed deposit_results write")
end

--------------------------------------------------------------------------
-- Request processing
--------------------------------------------------------------------------

--- Handle every pending deposit. Returns how many were recorded.
function KR_Vault.process()
    local inbox = Bridge.readJson(REQUESTS)
    if not inbox or not inbox.requests then
        return 0
    end

    local waiting = false
    for _, request in ipairs(inbox.requests) do
        if request.status == "pending" then
            waiting = true
            break
        end
    end
    if not waiting then
        return 0
    end

    local perNote, perBundle = rates()
    local ledger = loadLedger()

    local done = {}
    if ledger.results then
        for _, result in ipairs(ledger.results) do
            done[result.id] = true
        end
    end

    local recorded = 0

    for _, request in ipairs(inbox.requests) do
        if request.status == "pending" and not done[request.id] then
            local result = {
                id = request.id,
                username = request.username,
                status = "failed",
                money_count = 0,
                stack_count = 0,
                bundle_count = 0,
                total_coins = 0,
                message = nil,
                processed_at = Bridge.wallStamp(),
            }

            local player = Roster.find(request.username)
            local notesTaken = 0
            local bundlesTaken = 0
            local holdingCash = false

            if not player then
                result.message = "player not online"
            else
                local notes, bundles = tally(player)

                if notes == 0 and bundles == 0 then
                    result.message = "no money items found"
                else
                    notesTaken, bundlesTaken = confiscate(player)
                    holdingCash = (notesTaken > 0 or bundlesTaken > 0)

                    local leftoverNotes, leftoverBundles = tally(player)

                    if leftoverNotes > 0 or leftoverBundles > 0 then
                        -- A partial strip would credit less than the player
                        -- gave up, so treat it as a total failure and undo it.
                        result.message = "removal failed: " .. leftoverNotes .. " Money, "
                            .. leftoverBundles .. " MoneyBundle still in inventory"
                        print(LOG .. "WARNING: Money deposit removal incomplete for "
                            .. request.username .. " — " .. leftoverNotes .. " Money + "
                            .. leftoverBundles .. " MoneyBundle remaining")

                        if holdingCash then
                            refund(player, notesTaken, bundlesTaken)
                            holdingCash = false
                            notesTaken = 0
                            bundlesTaken = 0
                        end
                    else
                        local coins = (notesTaken * perNote) + (bundlesTaken * perBundle)

                        result.status = "success"
                        result.money_count = notesTaken
                        result.bundle_count = bundlesTaken
                        result.stack_count = bundlesTaken
                        result.total_coins = coins

                        print(LOG .. "Money deposit: " .. request.username .. " deposited "
                            .. notesTaken .. " Money + " .. bundlesTaken
                            .. " MoneyBundle = " .. coins .. " coins (rates "
                            .. perNote .. "/" .. perBundle .. ")")
                    end
                end
            end

            if commit(ledger, result) then
                recorded = recorded + 1
                done[request.id] = true
                if player then
                    Snapshot.capture(player)
                end
            else
                print(LOG .. "CRITICAL: deposit result not written for "
                    .. tostring(request.username) .. " id=" .. tostring(request.id)
                    .. " — will retry next cycle; restoring items if any were removed")

                if holdingCash and player then
                    refund(player, notesTaken, bundlesTaken)
                    Snapshot.capture(player)
                end
            end
        end
    end

    return recorded
end

function KR_Vault.init()
    local perNote, perBundle = rates()
    print(LOG .. "Money deposit system initialized (money=" .. perNote .. " bundle=" .. perBundle .. ")")
end

return KR_Vault
