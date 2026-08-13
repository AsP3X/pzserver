--
-- KR_Look.lua — how a survivor's head looks, for the web map pin.
--
-- Reads HumanVisual plus whatever is worn on the head. Every getter is
-- behind pcall: a missing method on one build must not take the export down.
--

KR_Look = {}

local HEAD_SLOTS = {
    Hat = true,
    Hat_f = true,
    FullHat = true,
    FullSuitHead = true,
    Mask = true,
    MaskFull = true,
    MaskEyes = true,
}

local function rgbOf(color)
    if not color then
        return nil
    end

    local r, g, b

    if color.getRedFloat then
        local ok, vr, vg, vb = pcall(function()
            return color:getRedFloat(), color:getGreenFloat(), color:getBlueFloat()
        end)
        if ok then
            r, g, b = vr, vg, vb
        end
    end

    if r == nil and color.getR then
        local ok, vr, vg, vb = pcall(function()
            return color:getR(), color:getG(), color:getB()
        end)
        if ok then
            r, g, b = vr, vg, vb
        end
    end

    if r == nil then
        return nil
    end

    if r > 1 or g > 1 or b > 1 then
        r, g, b = r / 255, g / 255, b / 255
    end

    return {
        math.floor(r * 1000 + 0.5) / 1000,
        math.floor(g * 1000 + 0.5) / 1000,
        math.floor(b * 1000 + 0.5) / 1000,
    }
end

local function call(object, method)
    if not object or not object[method] then
        return nil
    end

    local ok, value = pcall(object[method], object)
    if ok and value ~= nil and value ~= "" then
        return value
    end

    return nil
end

local function wornHat(player)
    if not player.getWornItems then
        return nil
    end

    local worn = player:getWornItems()
    if not worn then
        return nil
    end

    for index = 0, worn:size() - 1 do
        local entry = worn:get(index)
        local item = entry
        if entry and entry.getItem then
            item = entry:getItem()
        end
        if item then
            local slot = tostring(call(item, "getBodyLocation") or "")
            if HEAD_SLOTS[slot] then
                return call(item, "getName") or call(item, "getFullType")
            end
        end
    end

    return nil
end

--- Compact description the web UI can paint as a head.
function KR_Look.of(player)
    if not player then
        return nil
    end

    local female = false
    if player.isFemale then
        local ok, value = pcall(player.isFemale, player)
        female = ok and value == true
    end

    local visual = call(player, "getHumanVisual")
    local skin = rgbOf(call(visual, "getSkinColor") or call(visual, "getNaturalSkinColor"))
    local hair = call(visual, "getHairModel") or call(visual, "getNonAttachedHair")
    local hairColor = rgbOf(call(visual, "getHairColor") or call(visual, "getNaturalHairColor"))
    local beard = call(visual, "getBeardModel")
    local beardColor = rgbOf(call(visual, "getBeardColor") or call(visual, "getNaturalBeardColor"))

    if (not hair or hair == "") and player.getDescriptor then
        local descriptor = call(player, "getDescriptor")
        hair = call(descriptor, "getHair") or hair
        if descriptor and descriptor.isFemale then
            local ok, value = pcall(descriptor.isFemale, descriptor)
            if ok then
                female = value == true
            end
        end
    end

    if type(hair) == "string" and (hair == "" or hair == "null") then
        hair = nil
    end
    if type(beard) == "string" and (beard == "" or beard == "null") then
        beard = nil
    end

    return {
        female = female,
        skin = skin,
        hair = hair,
        hair_color = hairColor,
        beard = beard,
        beard_color = beardColor,
        hat = wornHat(player),
    }
end

return KR_Look
