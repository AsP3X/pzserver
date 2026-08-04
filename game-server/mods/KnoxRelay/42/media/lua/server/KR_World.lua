--
-- KR_World.lua — in-game clock, season, weather and scheduled world events.
--
-- Written to Lua/game_state.json so the dashboard can show the server's date,
-- time, sky and what the world is about to do to everyone, without needing a
-- player online. Exported once at boot too, because a paused server never
-- reaches the periodic tick.
--
-- Every engine call goes through pcall: the climate manager in particular is
-- not wired up during early startup, and a nil dereference here would take
-- down the whole event handler.
--

local Codec = require("KR_Codec")
local Bridge = require("KR_Bridge")

KR_World = {}

local LOG = "[KnoxRelay] "
local FILE = "game_state.json"

local MONTH_LENGTHS = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }

--- Meteorological seasons: Mar-May spring, Jun-Aug summer, Sep-Nov autumn,
--- Dec-Feb winter. `month` is 1-based.
local function seasonOf(month)
    if month >= 3 and month <= 5 then
        return "spring"
    end
    if month >= 6 and month <= 8 then
        return "summer"
    end
    if month >= 9 and month <= 11 then
        return "autumn"
    end

    return "winter"
end

--- Call `reader`, substituting `fallback` when the engine is not ready.
local function ask(reader, fallback)
    local ok, value = pcall(reader)
    if ok then
        return value
    end

    return fallback
end

local function round(value, scale)
    return math.floor(value * scale + 0.5) / scale
end

--- Which single word best describes the sky right now.
local function skyCondition(rain, fog, snow, night)
    if snow > 0.1 then
        return "snow"
    end
    if rain > 0.5 then
        return "heavy_rain"
    end
    if rain > 0.1 then
        return "rain"
    end
    if fog > 0.3 then
        return "fog"
    end
    if night then
        return "night"
    end

    return "clear"
end

--- The apocalypse's own calendar, in days. Copied from the vanilla weather
--- channel (ISWeatherChannel.AddPowerNotice): world age plus the head start
--- the sandbox began with, which is what the shutoff days are measured against.
local function apocalypseDay()
    local clock = getGameTime()
    local sandbox = getSandboxOptions()

    if not clock or not sandbox then
        return nil
    end

    local age = ask(function() return clock:getWorldAgeHours() end, nil)
    local sinceApo = ask(function() return sandbox:getTimeSinceApo() end, nil)

    if not age or not sinceApo then
        return nil
    end

    return age / 24 + (sinceApo - 1) * 30
end

--- Utilities the world is about to lose, and when.
---
--- A shutoff day of zero means the sandbox never had that utility running, so
--- there is nothing to count down to; a day already past reports as cut.
local function utility(day, shutoffDay)
    if not shutoffDay or shutoffDay <= 0 then
        return { status = "off", days_remaining = nil, shutoff_day = nil }
    end

    if day == nil then
        return { status = "unknown", days_remaining = nil, shutoff_day = shutoffDay }
    end

    if day >= shutoffDay then
        return { status = "off", days_remaining = 0, shutoff_day = shutoffDay }
    end

    return {
        status = "on",
        days_remaining = round(shutoffDay - day, 10),
        shutoff_day = shutoffDay,
    }
end

--- Events players would want warning of: the power and water going out, and
--- the helicopter that drags every zombie in the county across the map.
local function events()
    local clock = getGameTime()
    local sandbox = getSandboxOptions()

    if not clock or not sandbox then
        return nil
    end

    local day = apocalypseDay()
    local feed = {
        day = day and round(day, 10) or nil,
        electricity = utility(day, ask(function() return sandbox:getElecShutModifier() end, nil)),
        water = utility(day, ask(function() return sandbox:getWaterShutModifier() end, nil)),
    }

    local nights = ask(function() return clock:getNightsSurvived() end, nil)
    local firstFlight = ask(function() return clock:getHelicopterDay1() end, nil)

    if nights ~= nil and firstFlight ~= nil and firstFlight > 0 then
        feed.helicopter = {
            day = firstFlight,
            days_away = firstFlight - nights,
            today = firstFlight == nights,
        }
    end

    return feed
end

--- Write the current world state. Returns true when the file was written.
function KR_World.export()
    local clock = getGameTime()
    if not clock then
        return false
    end

    local year = ask(function() return clock:getYear() end, 0)
    local hour = ask(function() return clock:getHour() end, 0)
    local minute = ask(function() return clock:getMinutes() end, 0)

    -- The engine counts months and days from zero; everything downstream
    -- expects human numbering.
    local gotMonth, month = pcall(function() return clock:getMonth() end)
    month = gotMonth and (month + 1) or 1

    local gotDay, day = pcall(function() return clock:getDay() end)
    day = gotDay and (day + 1) or 1

    local night = false
    local gotNight, darkness = pcall(function() return clock:getNight() end)
    if gotNight and darkness then
        night = darkness > 0.5
    end

    local dayOfYear = day
    for index = 1, month - 1 do
        dayOfYear = dayOfYear + (MONTH_LENGTHS[index] or 30)
    end

    local state = {
        time = {
            year = year,
            month = month,
            day = day,
            hour = hour,
            minute = minute,
            day_of_year = dayOfYear,
            is_night = night,
            formatted = string.format("%02d:%02d", hour, minute),
            date = string.format("%04d-%02d-%02d", year, month, day),
        },
        season = seasonOf(month),
    }

    local gotClimate, climate = pcall(getClimateManager)
    if gotClimate and climate then
        local temperature = ask(function() return climate:getTemperature() end, 0)
        local rain = ask(function() return climate:getRainIntensity() end, 0)
        local fog = ask(function() return climate:getFogIntensity() end, 0)
        local wind = ask(function() return climate:getWindIntensity() end, 0)
        local snow = ask(function() return climate:getSnowIntensity() end, 0)

        state.weather = {
            temperature = round(temperature, 10),
            rain_intensity = round(rain, 100),
            fog_intensity = round(fog, 100),
            wind_intensity = round(wind, 100),
            snow_intensity = round(snow, 100),
            is_raining = rain > 0.1,
            is_foggy = fog > 0.2,
            is_snowing = snow > 0.1,
            condition = skyCondition(rain, fog, snow, night),
        }
    end

    state.events = events()

    local gotVersion, version = pcall(function() return getCore():getVersion() end)
    if gotVersion and version then
        state.game_version = tostring(version)
    end

    state.mod_version = Bridge.VERSION

    local gotTime, epoch = pcall(os.time)
    if gotTime then
        state.exported_at = os.date("!%Y-%m-%dT%H:%M:%SZ", epoch)
    else
        state.exported_at = "unknown"
    end

    local encoded, body = pcall(Codec.encode, state)
    if not encoded then
        print(LOG .. "GameState: JSON encode error: " .. tostring(body))

        return false
    end

    return Bridge.writeText(FILE, body)
end

return KR_World
