--
-- KR_Catalog.lua — the full list of items the server knows about.
--
-- Written once at boot to Lua/items_catalog.json. The dashboard uses it for
-- item autocomplete and for shop entries, so it has to include modded items,
-- which is why it is read from ScriptManager at runtime rather than shipped
-- as a static file.
--
-- Two icon fields come out of this: icon_name is the sprite the game uses,
-- texture_icon is the raw Icon field, which is what the wiki names its image
-- pages after.
--

local Codec = require("KR_Codec")
local Bridge = require("KR_Bridge")

KR_Catalog = {}

local LOG = "[KnoxRelay] "
local FILE = "items_catalog.json"

--- Pull the texture name off a script, trying both accessor spellings.
local function textureOf(script)
    if script.getIcon then
        local icon = script:getIcon()
        if icon and icon ~= "" then
            return tostring(icon)
        end
    end

    if script.getIconName then
        local icon = script:getIconName()
        if icon and icon ~= "" then
            return tostring(icon)
        end
    end

    return nil
end

--- Export every registered item. Returns how many were written.
function KR_Catalog.export()
    local scripts = ScriptManager.instance
    if not scripts then
        print(LOG .. "ERROR: ScriptManager not available")

        return 0
    end

    local registered = scripts:getAllItems()
    if not registered then
        print(LOG .. "ERROR: getAllItems() returned nil")

        return 0
    end

    local items = {}

    for index = 0, registered:size() - 1 do
        local script = registered:get(index)
        if script then
            local shortName = script:getName() or ""
            if shortName == "" then
                shortName = "Unknown"
            end

            items[#items + 1] = {
                full_type = script:getFullName() or "",
                name = script:getDisplayName() or script:getName() or "Unknown",
                category = tostring(script:getDisplayCategory() or "General"),
                icon_name = "Item_" .. shortName,
                texture_icon = textureOf(script),
            }
        end
    end

    local encoded, body = pcall(Codec.encode, {
        version = 1,
        timestamp = Bridge.worldStamp(true),
        item_count = #items,
        items = items,
    })

    if not encoded then
        print(LOG .. "ERROR encoding item catalog: " .. tostring(body))

        return 0
    end

    if not Bridge.writeText(FILE, body) then
        print(LOG .. "ERROR: cannot open file writer for item catalog")

        return 0
    end

    return #items
end

return KR_Catalog
