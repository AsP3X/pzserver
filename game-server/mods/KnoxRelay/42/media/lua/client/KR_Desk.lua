--
-- KR_Desk.lua — Knox Relay window shell.
--
-- Pages register. This file only owns the frame, the left rail, and a
-- content hole. No page names except the default first page.
--

require "ISUI/ISCollapsableWindow"
require "ISUI/ISPanel"
require "ISUI/ISButton"

KR_Desk = KR_Desk or {}

local LOG = "[KnoxRelay] "
local pages = {}
local instance = nil
local activeId = nil
local mounted = nil

KR_Desk.Color = {
    void   = { r = 0.027, g = 0.031, b = 0.024, a = 1 },
    ash    = { r = 0.047, g = 0.059, b = 0.047, a = 1 },
    raised = { r = 0.071, g = 0.086, b = 0.071, a = 1 },
    fence  = { r = 0.114, g = 0.137, b = 0.110, a = 1 },
    bone   = { r = 0.910, g = 0.902, b = 0.867, a = 1 },
    smoke  = { r = 0.604, g = 0.627, b = 0.576, a = 1 },
    dust   = { r = 0.404, g = 0.431, b = 0.384, a = 1 },
    hazard = { r = 0.949, g = 0.635, b = 0.047, a = 1 },
    moss   = { r = 0.545, g = 0.690, b = 0.290, a = 1 },
    blood  = { r = 0.753, g = 0.224, b = 0.169, a = 1 },
}

local RAIL = 128
local WIDTH = 860
local HEIGHT = 560
local MIN_W = 620
local MIN_H = 460

KR_Desk.RAIL = RAIL
KR_Desk.MIN_WIDTH = MIN_W
KR_Desk.MIN_HEIGHT = MIN_H

local function sortedPages()
    local list = {}
    for _, page in pairs(pages) do
        list[#list + 1] = page
    end
    table.sort(list, function(a, b)
        local ao = tonumber(a.order) or 100
        local bo = tonumber(b.order) or 100
        if ao == bo then
            return tostring(a.id) < tostring(b.id)
        end
        return ao < bo
    end)
    return list
end

function KR_Desk.register(page)
    if type(page) ~= "table" or not page.id then
        print(LOG .. "Desk: refusing a page with no id")
        return
    end
    pages[page.id] = page
    print(LOG .. "Desk: registered page '" .. tostring(page.id) .. "'")
end

function KR_Desk.unreadTotal()
    local total = 0
    for _, page in pairs(pages) do
        if type(page.unread) == "function" then
            local ok, count = pcall(page.unread)
            if ok and type(count) == "number" then
                total = total + count
            end
        end
    end
    return total
end

function KR_Desk.isOpen()
    return instance ~= nil and instance:getIsVisible()
end

function KR_Desk.instance()
    return instance
end

KnoxDeskWindow = ISCollapsableWindow:derive("KnoxDeskWindow")

function KnoxDeskWindow:initialise()
    ISCollapsableWindow.initialise(self)
    self.pin = true
    self.resizable = true
    self.minimumWidth = MIN_W
    self.minimumHeight = MIN_H
end

function KnoxDeskWindow:createChildren()
    ISCollapsableWindow.createChildren(self)

    -- No left+right / top+bottom anchors. Those stretch the hole over the rail.
    self.rail = ISPanel:new(0, 20, RAIL, 100)
    self.rail:initialise()
    self.rail.backgroundColor = KR_Desk.Color.void
    self.rail.borderColor = KR_Desk.Color.fence
    self.rail.keepOnScreen = false
    self.rail.anchorLeft = true
    self.rail.anchorRight = false
    self.rail.anchorTop = true
    self.rail.anchorBottom = false
    self:addChild(self.rail)

    self.host = ISPanel:new(RAIL, 20, 100, 100)
    self.host:initialise()
    self.host.backgroundColor = KR_Desk.Color.ash
    self.host.borderColor = KR_Desk.Color.fence
    self.host.keepOnScreen = false
    self.host.anchorLeft = true
    self.host.anchorRight = false
    self.host.anchorTop = true
    self.host.anchorBottom = false
    self:addChild(self.host)

    self.railButtons = {}
    if self.resizeWidget then
        self.resizeWidget.resizeFunction = KnoxDeskWindow.applySize
    end
    if self.resizeWidget2 then
        self.resizeWidget2.resizeFunction = KnoxDeskWindow.applySize
    end
    self:placeChrome()
    self:rebuildRail()
end

function KnoxDeskWindow:clampSize()
    local w = self:getWidth()
    local h = self:getHeight()
    if w < MIN_W then
        self:setWidth(MIN_W)
        w = MIN_W
    end
    if h < MIN_H then
        self:setHeight(MIN_H)
        h = MIN_H
    end
    return w, h
end

function KnoxDeskWindow:applySize(w, h)
    if w < MIN_W then
        w = MIN_W
    end
    if h < MIN_H then
        h = MIN_H
    end
    self:setWidth(w)
    self:setHeight(h)
    self:placeChrome()
    if mounted and type(mounted.layout) == "function" then
        pcall(mounted.layout, mounted, self.host)
    end
end

function KnoxDeskWindow:placeChrome()
    local w, h = self:clampSize()
    local th = self:titleBarHeight()
    local rh = 8
    if self.resizeWidgetHeight then
        rh = self:resizeWidgetHeight()
    end
    local innerH = math.max(80, h - th - rh)

    if self.rail then
        self.rail.keepOnScreen = false
        self.rail:setX(0)
        self.rail:setY(th)
        self.rail:setWidth(RAIL)
        self.rail:setHeight(innerH)
    end
    if self.host then
        self.host.keepOnScreen = false
        self.host:setX(RAIL)
        self.host:setY(th)
        self.host:setWidth(math.max(80, w - RAIL))
        self.host:setHeight(innerH)
        if self.host.javaObject then
            self.host.javaObject:setX(RAIL)
            self.host.javaObject:setY(th)
            self.host.javaObject:setWidth(math.max(80, w - RAIL))
            self.host.javaObject:setHeight(innerH)
        end
    end
end

function KnoxDeskWindow:prerender()
    local w = self:getWidth()
    local h = self:getHeight()
    if w ~= self._laidW or h ~= self._laidH then
        self._laidW = w
        self._laidH = h
        self:placeChrome()
        if mounted and type(mounted.layout) == "function" then
            pcall(mounted.layout, mounted, self.host)
        end
    end

    local th = self:titleBarHeight()
    local void = KR_Desk.Color.void
    local ash = KR_Desk.Color.ash
    local fence = KR_Desk.Color.fence
    local hazard = KR_Desk.Color.hazard
    local bone = KR_Desk.Color.bone

    self:drawRect(0, 0, self.width, self.height, 0.97, void.r, void.g, void.b)
    self:drawRect(0, 0, self.width, th, 1, ash.r, ash.g, ash.b)
    self:drawRect(0, th - 1, self.width, 1, 1, hazard.r, hazard.g, hazard.b)
    self:drawRectBorder(0, 0, self.width, self.height, 1, fence.r, fence.g, fence.b)

    if self.title then
        self:drawTextCentre(self.title, self.width / 2, 2, bone.r, bone.g, bone.b, 1, UIFont.Small)
    end
end

function KnoxDeskWindow:rebuildRail()
    if not self.rail then
        return
    end

    self.rail:clearChildren()
    self.railButtons = {}

    local y = 16
    for _, page in ipairs(sortedPages()) do
        local unread = 0
        if type(page.unread) == "function" then
            local ok, count = pcall(page.unread)
            if ok and type(count) == "number" then
                unread = count
            end
        end

        local label = tostring(page.label or page.id)
        if unread > 0 then
            label = label .. "  " .. tostring(unread)
        end

        local selected = page.id == activeId
        local id = page.id
        local button = ISButton:new(10, y, RAIL - 20, 28, label, self, function()
            KR_Desk.show(id)
        end)
        -- Nav item, not an action. A yellow box here sat on NEW REPORT.
        button.backgroundColor = selected and KR_Desk.Color.raised or KR_Desk.Color.void
        button.backgroundColorMouseOver = KR_Desk.Color.raised
        button.borderColor = { r = 0, g = 0, b = 0, a = 0 }
        button.textColor = selected and KR_Desk.Color.hazard or KR_Desk.Color.smoke
        if unread > 0 then
            button.textColor = KR_Desk.Color.hazard
        end
        button:initialise()
        self.rail:addChild(button)
        self.railButtons[#self.railButtons + 1] = button
        y = y + 34
    end
end

function KnoxDeskWindow:onResize()
    ISCollapsableWindow.onResize(self)
    self:placeChrome()
    if mounted and type(mounted.layout) == "function" then
        pcall(mounted.layout, mounted, self.host)
    end
end

function KnoxDeskWindow:close()
    KR_Desk.hide()
end

local function defaultPageId()
    local list = sortedPages()
    if list[1] then
        return list[1].id
    end
    return nil
end

local function unmountCurrent()
    if mounted and type(mounted.unmount) == "function" then
        pcall(mounted.unmount, mounted)
    end
    mounted = nil
    if instance and instance.host then
        instance.host:clearChildren()
    end
end

function KR_Desk.show(pageId)
    if not instance then
        local x = math.max(20, (getCore():getScreenWidth() - WIDTH) / 2)
        local y = math.max(20, (getCore():getScreenHeight() - HEIGHT) / 2)
        instance = KnoxDeskWindow:new(x, y, WIDTH, HEIGHT)
        instance:setTitle("KNOX DESK")
        instance:initialise()
        instance:addToUIManager()
        instance:setVisible(true)
        instance.pin = true
        pcall(function() instance:pin() end)
        instance:placeChrome()
    else
        instance:setVisible(true)
        instance:addToUIManager()
        instance:placeChrome()
    end

    pageId = pageId or activeId or defaultPageId()
    if not pageId or not pages[pageId] then
        instance:rebuildRail()
        return
    end

    if not (mounted and mounted.id == pageId) then
        unmountCurrent()
        activeId = pageId
        mounted = pages[pageId]
        if instance.host and type(mounted.mount) == "function" then
            local ok, err = pcall(mounted.mount, mounted, instance.host)
            if not ok then
                print(LOG .. "Desk: page '" .. tostring(pageId) .. "' failed to mount: " .. tostring(err))
            end
        end
    end

    instance:rebuildRail()
    if mounted and type(mounted.layout) == "function" then
        pcall(mounted.layout, mounted, instance.host)
    end
end

function KR_Desk.hide()
    unmountCurrent()
    if instance then
        instance:setVisible(false)
        instance:removeFromUIManager()
    end
end

function KR_Desk.toggle()
    if KR_Desk.isOpen() then
        KR_Desk.hide()
    else
        KR_Desk.show()
    end
end

function KR_Desk.refreshRail()
    if instance then
        instance:rebuildRail()
    end
end

function KR_Desk.refresh()
    KR_Desk.refreshRail()
    if mounted and type(mounted.refresh) == "function" then
        pcall(mounted.refresh, mounted)
    end
end

print(LOG .. "Desk shell loaded")
