--
-- KR_Jobs.lua — typed jobs from the panel, one file in each direction.
--
-- The panel writes panel_jobs.json. This module drains it on the real-time
-- pulse and appends panel_results.json keyed by id, so a waiter on the other
-- side does not have to guess whether a username falling off export_requests
-- meant "done" or "lost".
--
-- kinds:
--   snapshot  write a fresh inventory file for that player
--   notice    no-op here; the panel writes notices into the Desk inbox itself
--

local Bridge = require("KR_Bridge")
local Roster = require("KR_Roster")
local Snapshot = require("KR_Snapshot")

KR_Jobs = {}

local LOG = "[KnoxRelay] "
local JOBS = "panel_jobs.json"
local RESULTS = "panel_results.json"
local RESULT_LIMIT = 200

local function loadJobs()
    local file = Bridge.readJson(JOBS)
    if type(file) ~= "table" or type(file.jobs) ~= "table" then
        return { version = 1, jobs = {} }
    end
    return file
end

local function loadResults()
    local file = Bridge.readJson(RESULTS)
    if type(file) ~= "table" or type(file.results) ~= "table" then
        return { version = 1, results = {} }
    end
    return file
end

local function saveResults(file)
    file.version = 1
    file.updated_at = Bridge.wallStamp()
    while file.results and #file.results > RESULT_LIMIT do
        table.remove(file.results, 1)
    end
    return Bridge.writeJson(RESULTS, file)
end

local function alreadyDone(results, id)
    if not id then
        return false
    end
    for _, row in ipairs(results.results) do
        if row.id == id then
            return true
        end
    end
    return false
end

local function runSnapshot(job)
    local username = job.username
    if type(username) ~= "string" or username == "" then
        return { ok = false, message = "snapshot job missing username", defer = false }
    end

    local player = Roster.find(username)
    if not player then
        return { ok = false, message = "player not online", defer = true }
    end

    if KR_Snapshot.capture(player) then
        return { ok = true, message = nil, defer = false }
    end

    return { ok = false, message = "snapshot write failed", defer = false }
end

--- Drain the inbox. Returns how many jobs produced a result this pass.
function KR_Jobs.drain()
    local inbox = loadJobs()
    if #inbox.jobs == 0 then
        return 0
    end

    local results = loadResults()
    local leftover = {}
    local handled = 0

    for _, job in ipairs(inbox.jobs) do
        if type(job) ~= "table" or alreadyDone(results, job.id) then
            -- skip
        else
            local kind = tostring(job.kind or "")
            local outcome
            if kind == "snapshot" then
                outcome = runSnapshot(job)
            elseif kind == "notice" then
                -- The panel owns Desk notices; acknowledging the job is enough.
                outcome = { ok = true, message = nil, defer = false }
            else
                outcome = { ok = false, message = "unknown job kind: " .. kind, defer = false }
            end

            if outcome.defer then
                leftover[#leftover + 1] = job
            else
                results.results[#results.results + 1] = {
                    id = job.id,
                    kind = kind,
                    username = job.username,
                    ok = outcome.ok and true or false,
                    message = outcome.message,
                    processed_at = Bridge.wallStamp(),
                }
                handled = handled + 1
            end
        end
    end

    if handled > 0 then
        saveResults(results)
        if handled > 0 then
            print(LOG .. "Panel jobs: " .. handled .. " result(s)")
        end
    end

    Bridge.writeJson(JOBS, {
        version = 1,
        updated_at = Bridge.wallStamp(),
        jobs = leftover,
    })

    return handled
end

return KR_Jobs
