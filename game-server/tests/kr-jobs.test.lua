--
-- Tests for KR_Jobs, the typed panel_jobs.json / panel_results.json channel.
--
-- Project Zomboid runs Lua 5.1, so run this with luajit:
--   luajit game-server/tests/kr-jobs.test.lua   (exit 0 = all pass)
--

local HERE = (arg and arg[0] or ""):match("^(.*[/\\])[^/\\]*$") or "./"
local MODS = HERE .. "../mods/KnoxRelay/42/media/lua/server/"

local pass, fail = 0, 0
local function ok(desc) pass = pass + 1; print("PASS: " .. desc) end
local function ng(desc, why) fail = fail + 1; print("FAIL: " .. desc .. " — " .. tostring(why)) end
local function check(desc, cond, why) if cond then ok(desc) else ng(desc, why or "assertion failed") end end

local Codec = assert(loadfile(MODS .. "KR_Codec.lua"))()
package.preload["KR_Codec"] = function() return Codec end

local disk = {}
package.preload["KR_Bridge"] = function()
    return {
        VERSION = "1.25",
        FEATURES = { "panel_jobs" },
        wallStamp = function() return "2026-08-28T12:00:00" end,
        writeJson = function(path, payload)
            disk[path] = Codec.encode(payload)
            return true
        end,
        readJson = function(path)
            if not disk[path] then
                return nil
            end
            local parsed, result = pcall(Codec.decode, disk[path])
            if not parsed then
                return nil
            end
            return result
        end,
    }
end

local captured = {}
local online = {}
package.preload["KR_Roster"] = function()
    return {
        sameName = function(a, b)
            return type(a) == "string" and type(b) == "string" and string.lower(a) == string.lower(b)
        end,
        find = function(username)
            for name, player in pairs(online) do
                if string.lower(name) == string.lower(username or "") then
                    return player
                end
            end
            return nil
        end,
    }
end

package.preload["KR_Snapshot"] = function()
    return {
        capture = function(player)
            captured[#captured + 1] = player.username
            return true
        end,
    }
end

local Jobs = assert(loadfile(MODS .. "KR_Jobs.lua"))()

--------------------------------------------------------------------------

online.Rook = { username = "Rook" }
disk["panel_jobs.json"] = Codec.encode({
    version = 1,
    jobs = {
        { id = "job-1", kind = "snapshot", username = "rook" },
    },
})

check("drains a snapshot job for a case-mismatched name", Jobs.drain() == 1)
check("captured the in-game player", captured[1] == "Rook")

local results = Codec.decode(disk["panel_results.json"])
check("wrote an ok result keyed by id", results.results[1].id == "job-1" and results.results[1].ok == true)

local leftover = Codec.decode(disk["panel_jobs.json"])
check("clears a served job from the inbox", leftover.jobs and #leftover.jobs == 0)

captured = {}
disk["panel_jobs.json"] = Codec.encode({
    version = 1,
    jobs = {
        { id = "job-2", kind = "snapshot", username = "ghost" },
    },
})
disk["panel_results.json"] = nil

check("defers a snapshot when the player is offline", Jobs.drain() == 0)
leftover = Codec.decode(disk["panel_jobs.json"])
check("keeps the deferred job", leftover.jobs and leftover.jobs[1].id == "job-2")
check("writes no result yet", disk["panel_results.json"] == nil)

disk["panel_jobs.json"] = Codec.encode({
    version = 1,
    jobs = {
        { id = "job-3", kind = "notice", username = "Rook", title = "Sold", body = "Axe" },
    },
})
check("acks a notice job without needing the player online", Jobs.drain() == 1)
results = Codec.decode(disk["panel_results.json"])
local last = results.results[#results.results]
check("notice result is ok", last.id == "job-3" and last.ok == true)

print("----------------------------------------")
print("Passed: " .. pass .. ", Failed: " .. fail)
if fail > 0 then os.exit(1) end
