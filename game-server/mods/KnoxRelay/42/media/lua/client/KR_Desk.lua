--
-- KR_Desk.lua — Knox Relay window shell and the shared UI kit.
--
-- Pages register. This file only owns the frame, the left rail, and a
-- content hole. No page names except the default first page.
--
-- It also carries the palette, the spacing scale and the geometry helpers,
-- because a second file holding them would have to load *before* the pages
-- and PZ walks media/lua/client alphabetically: KR_Desk sorts ahead of
-- KR_DeskHud and KR_DeskReports, a KR_Theme would not.
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
    ember  = { r = 0.231, g = 0.157, b = 0.020, a = 1 },
    clear  = { r = 0, g = 0, b = 0, a = 0 },
}

-- One spacing scale for the whole mod. Pages read these instead of inventing
-- their own numbers, which is what let the old reply box and the send button
-- land on the same row.
KR_Desk.Metric = {
    pad     = 12,
    gap     = 8,
    tight   = 4,
    row     = 28,
    rowTall = 32,
    label   = 16,
    field   = 26,
}

local WIDTH = 900
local HEIGHT = 580
local MIN_W = 560
local MIN_H = 420

-- The rail tracks window width instead of sitting at a fixed 128, so a narrow
-- desk does not hand a fifth of itself to six words of navigation.
local RAIL_MIN = 104
local RAIL_MAX = 168
local RAIL_SHARE = 0.17

KR_Desk.MIN_WIDTH = MIN_W
KR_Desk.MIN_HEIGHT = MIN_H
KR_Desk.WIDTH = WIDTH
KR_Desk.HEIGHT = HEIGHT

--- Fixed desk size, shrunk only when the screen cannot hold WIDTH x HEIGHT.
local function openGeometry()
    local screenW, screenH = 1280, 720
    pcall(function()
        screenW = getCore():getScreenWidth()
        screenH = getCore():getScreenHeight()
    end)

    local w = WIDTH
    local h = HEIGHT
    if screenW - 80 < w then
        w = math.max(MIN_W, screenW - 80)
    end
    if screenH - 120 < h then
        h = math.max(MIN_H, screenH - 120)
    end
    local x = math.max(10, math.floor((screenW - w) / 2))
    local y = math.max(10, math.floor((screenH - h) / 2))

    return x, y, w, h
end

--------------------------------------------------------------------------
-- Geometry helpers, shared with the pages
--------------------------------------------------------------------------

--- Place an element and keep its Java peer in step.
---
--- ISUIElement:setWidth already forwards to javaObject, but ISScrollingListBox
--- and ISTextEntryBox instantiate a peer that some builds do not re-read until
--- it is written directly. Doing both is cheap and removes a class of "the box
--- moved but the text did not" bugs.
function KR_Desk.box(el, x, y, w, h)
    if not el then
        return
    end
    x = math.floor(x + 0.5)
    y = math.floor(y + 0.5)
    w = math.max(1, math.floor(w + 0.5))
    h = math.max(1, math.floor(h + 0.5))

    el:setX(x)
    el:setY(y)
    el:setWidth(w)
    el:setHeight(h)

    pcall(function()
        local peer = el.javaObject
        if peer then
            peer:setX(x)
            peer:setY(y)
            peer:setWidth(w)
            peer:setHeight(h)
        end
    end)

    KR_Desk.refit(el)
end

--- Stop vanilla from stretching or shoving a widget we place by hand.
---
--- ISUIElement defaults keepOnScreen on, and a scrolling list that also
--- anchors right+bottom will grow with its parent and paint over the
--- widgets we laid out next to it. Pages call this once at create time.
function KR_Desk.lockWidget(el)
    if not el then
        return
    end
    el.keepOnScreen = false
    el.anchorLeft = true
    el.anchorRight = false
    el.anchorTop = true
    el.anchorBottom = false
end

--- Re-derive whatever a widget caches from its own size.
---
--- setWidth/setHeight are plain field writes in ISUIElement — they do not run
--- onResize — so a scrolling list keeps the scrollbar it sized on creation and
--- a rich text panel keeps line breaks measured against the old width. Every
--- call is guarded because which of these exist varies across builds.
function KR_Desk.refit(el)
    if not el then
        return
    end

    if el.items and el.itemheight then
        pcall(function() el:setScrollHeight(#el.items * el.itemheight) end)
    end
    pcall(function() el:updateScrollbars() end)
    pcall(function() el:paginate() end)

    -- Shrinking can leave the view scrolled past the end, which reads as an
    -- empty widget until the player scrolls back up.
    pcall(function()
        local extent = el:getScrollHeight() or 0
        local visible = el:getHeight() or 0
        local top = el:getYScroll() or 0
        local floorY = math.min(0, visible - extent)
        if top < floorY then
            el:setYScroll(floorY)
        elseif top > 0 then
            el:setYScroll(0)
        end
    end)
end

--- Buttons come in three flavours and nothing else.
function KR_Desk.styleButton(button, kind)
    if not button then
        return
    end
    local C = KR_Desk.Color

    if kind == "primary" then
        button.backgroundColor = C.void
        button.backgroundColorMouseOver = C.ember
        button.borderColor = C.hazard
        button.textColor = C.hazard
    elseif kind == "nav" then
        button.backgroundColor = C.clear
        button.backgroundColorMouseOver = C.raised
        button.borderColor = C.clear
        button.textColor = C.smoke
    else
        button.backgroundColor = C.void
        button.backgroundColorMouseOver = C.raised
        button.borderColor = C.fence
        button.textColor = C.bone
    end
end

--- Height of one line in the small font, floored so a missing text manager
--- (headless test, early boot) cannot produce a zero-height row.
function KR_Desk.lineHeight()
    local height = 0
    pcall(function()
        local tm = getTextManager()
        local font = tm:getFontFromEnum(UIFont.Small)
        if font and font.getLineHeight then
            height = font:getLineHeight()
        else
            height = tm:getFontHeight(UIFont.Small)
        end
    end)
    if not height or height < 14 then
        height = 14
    end
    return height
end

function KR_Desk.measure(text, fallback)
    local width = nil
    pcall(function()
        width = getTextManager():MeasureStringX(UIFont.Small, tostring(text or ""))
    end)
    if not width or width < 1 then
        width = fallback or (#tostring(text or "") * 7)
    end
    return width
end

--- Trim to fit, with an ellipsis, so a long subject cannot run under the
--- status pill next to it.
function KR_Desk.clip(text, maxWidth)
    text = tostring(text or "")
    if maxWidth < 12 then
        return ""
    end
    if KR_Desk.measure(text) <= maxWidth then
        return text
    end
    while #text > 1 and KR_Desk.measure(text .. "...") > maxWidth do
        text = string.sub(text, 1, #text - 1)
    end
    return text .. "..."
end

--------------------------------------------------------------------------
-- Page registry
--------------------------------------------------------------------------

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

local function pageUnread(page)
    if type(page.unread) ~= "function" then
        return 0
    end
    local ok, count = pcall(page.unread)
    if ok and type(count) == "number" then
        return count
    end
    return 0
end

function KR_Desk.unreadTotal()
    local total = 0
    for _, page in pairs(pages) do
        total = total + pageUnread(page)
    end
    return total
end

function KR_Desk.isOpen()
    return instance ~= nil and instance:getIsVisible()
end

function KR_Desk.instance()
    return instance
end

--------------------------------------------------------------------------
-- Rail navigation button
--------------------------------------------------------------------------

-- ISButton draws a label in a box. The rail wants an active marker and an
-- unread count that does not shove the label around, so it draws its own.
KnoxNavButton = ISButton:derive("KnoxNavButton")

function KnoxNavButton:render()
    local C = KR_Desk.Color
    local w = self:getWidth()
    local h = self:getHeight()
    local hovered = self:isMouseOver()

    if self.knoxActive then
        self:drawRect(0, 0, w, h, 1, C.raised.r, C.raised.g, C.raised.b)
        self:drawRect(0, 0, 3, h, 1, C.hazard.r, C.hazard.g, C.hazard.b)
    elseif hovered then
        self:drawRect(0, 0, w, h, 1, C.ash.r, C.ash.g, C.ash.b)
    end

    local tint = self.knoxActive and C.hazard or (hovered and C.bone or C.smoke)
    local textY = math.floor((h - KR_Desk.lineHeight()) / 2)

    local badge = self.knoxUnread or 0
    local room = w - 14
    if badge > 0 then
        room = room - 26
    end

    self:drawText(KR_Desk.clip(self.title or "", room), 11, textY, tint.r, tint.g, tint.b, 1, UIFont.Small)

    if badge > 0 then
        local label = badge > 99 and "99+" or tostring(badge)
        local pillW = KR_Desk.measure(label, 14) + 10
        local pillX = w - pillW - 8
        local pillH = KR_Desk.lineHeight() + 2
        local pillY = math.floor((h - pillH) / 2)
        self:drawRect(pillX, pillY, pillW, pillH, 1, C.hazard.r, C.hazard.g, C.hazard.b)
        self:drawText(label, pillX + 5, pillY + 1, C.void.r, C.void.g, C.void.b, 1, UIFont.Small)
    end
end

--------------------------------------------------------------------------
-- The window
--------------------------------------------------------------------------

KnoxDeskWindow = ISCollapsableWindow:derive("KnoxDeskWindow")

function KnoxDeskWindow:initialise()
    -- Lock before the parent builds children: vanilla :new defaults
    -- resizable true, and createChildren only skips the grip if this is
    -- already false.
    self.pin = true
    self.resizable = false
    -- Floor only. The live size is WIDTH x HEIGHT, or MIN_* on a tiny screen.
    -- Pinning minimumWidth to WIDTH fought openGeometry() on 800px displays.
    self.minimumWidth = MIN_W
    self.minimumHeight = MIN_H
    ISCollapsableWindow.initialise(self)
    self.resizable = false
end

function KnoxDeskWindow:createChildren()
    ISCollapsableWindow.createChildren(self)

    -- No left+right / top+bottom anchors. Those stretch the hole over the rail.
    -- Everything here is placed by hand in placeChrome.
    self.rail = ISPanel:new(0, 20, RAIL_MIN, 100)
    self.rail:initialise()
    self.rail.backgroundColor = KR_Desk.Color.void
    self.rail.borderColor = KR_Desk.Color.clear
    KR_Desk.lockWidget(self.rail)
    self:addChild(self.rail)

    self.host = ISPanel:new(RAIL_MIN, 20, 100, 100)
    self.host:initialise()
    self.host.backgroundColor = KR_Desk.Color.ash
    self.host.borderColor = KR_Desk.Color.clear
    KR_Desk.lockWidget(self.host)
    self:addChild(self.host)

    self.railButtons = {}
    self:hideResizeGrip()
    self:placeChrome()
    self:rebuildRail()
end

function KnoxDeskWindow:hideResizeGrip()
    self.resizable = false
    local function hideGrip(grip)
        if not grip then
            return
        end
        grip:setVisible(false)
        pcall(function() grip:setCapture(false) end)
        -- Invisible grips still eat clicks on some B42 builds.
        KR_Desk.box(grip, -40, -40, 1, 1)
    end
    hideGrip(self.resizeWidget)
    hideGrip(self.resizeWidget2)
end

--- Vanilla still calls this after a layout.ini restore. Stay locked.
function KnoxDeskWindow:setResizable(_value)
    self.resizable = false
    self:hideResizeGrip()
end

--- B42 writes the last dragged size into layout.ini and restores it on
--- addToUIManager. Ignore width/height; the desk is not player-sized.
function KnoxDeskWindow:RestoreLayout(_name, layout)
    if type(layout) == "table" then
        local x = tonumber(layout.x)
        local y = tonumber(layout.y)
        if x and y then
            self:setX(x)
            self:setY(y)
        end
        if tostring(layout.pin) == "true" then
            self.pin = true
            pcall(function() self:pin() end)
        end
    end
    self:applyLockedSize()
    self:placeChrome()
end

function KnoxDeskWindow:SaveLayout(_name, layout)
    if type(layout) ~= "table" then
        return
    end
    layout.x = tostring(math.floor(self:getX() or 0))
    layout.y = tostring(math.floor(self:getY() or 0))
    layout.width = tostring(WIDTH)
    layout.height = tostring(HEIGHT)
    layout.pin = "true"
end

--- Snap the frame to WIDTH x HEIGHT (or the shrunk openGeometry on a
--- small screen). Tests set `_layoutUnlocked` so they can still sweep sizes.
function KnoxDeskWindow:applyLockedSize()
    if self._layoutUnlocked then
        return false
    end
    local _x, _y, w, h = openGeometry()
    local changed = false
    if self:getWidth() ~= w then
        self:setWidth(w)
        changed = true
    end
    if self:getHeight() ~= h then
        self:setHeight(h)
        changed = true
    end
    pcall(function()
        local peer = self.javaObject
        if peer then
            peer:setWidth(w)
            peer:setHeight(h)
        end
    end)
    return changed
end

--- Rail width for a given frame width. Free function so the layout tests can
--- ask for it without standing up a window.
function KR_Desk.railWidth(w)
    local rail = math.floor(w * RAIL_SHARE)
    if rail < RAIL_MIN then
        rail = RAIL_MIN
    end
    if rail > RAIL_MAX then
        rail = RAIL_MAX
    end
    -- Never let the rail take so much that the page has nothing left.
    if rail > w - 220 then
        rail = math.max(72, w - 220)
    end
    return rail
end

--- Size the rail and the content hole to the current frame.
---
--- This never writes the window's own width or height. The old version called
--- clampSize() here, so a prerender could push back against the resize widget
--- mid-drag and the frame stuttered.
function KnoxDeskWindow:placeChrome()
    local w = self:getWidth()
    local h = self:getHeight()

    local th = 16
    pcall(function() th = self:titleBarHeight() end)
    local rh = 0
    if self.resizable then
        rh = 8
        pcall(function() rh = self:resizeWidgetHeight() end)
    end

    local innerH = h - th - rh
    local rail = KR_Desk.railWidth(w)

    -- Collapsed, or dragged smaller than one row: there is no content area, so
    -- take it off screen rather than letting it hang below the title bar.
    if innerH < 40 then
        if self.rail then
            self.rail:setVisible(false)
        end
        if self.host then
            self.host:setVisible(false)
        end
        self._chromeW, self._chromeH = w, h
        return
    end

    if self.rail then
        self.rail:setVisible(true)
        self.rail.keepOnScreen = false
        KR_Desk.box(self.rail, 0, th, rail, innerH)
    end
    if self.host then
        self.host:setVisible(true)
        self.host.keepOnScreen = false
        KR_Desk.box(self.host, rail, th, w - rail, innerH)
    end

    self:layoutRail()
    self._chromeW, self._chromeH = w, h
end

--- Fit the nav buttons to the rail, shrinking rows before letting them spill.
function KnoxDeskWindow:layoutRail()
    if not self.rail or not self.railButtons then
        return
    end

    local count = #self.railButtons
    if count == 0 then
        return
    end

    local railW = self.rail:getWidth()
    local railH = self.rail:getHeight()
    local top = 34
    local gap = 4
    local rowH = KR_Desk.Metric.rowTall

    local available = railH - top - KR_Desk.Metric.gap
    local needed = count * rowH + (count - 1) * gap
    if needed > available then
        rowH = math.floor((available - (count - 1) * gap) / count)
        if rowH < 20 then
            rowH = 20
        end
    end

    local y = top
    for _, button in ipairs(self.railButtons) do
        KR_Desk.box(button, 6, y, math.max(40, railW - 12), rowH)
        button:setVisible(y + rowH <= railH)
        y = y + rowH + gap
    end
end

function KnoxDeskWindow:prerender()
    local sizeChanged = self:applyLockedSize()
    local w = self:getWidth()
    local h = self:getHeight()
    if sizeChanged or w ~= self._chromeW or h ~= self._chromeH then
        self:placeChrome()
        self:layoutPage()
    end

    local th = 16
    pcall(function() th = self:titleBarHeight() end)

    local C = KR_Desk.Color
    self:drawRect(0, 0, self.width, self.height, 0.97, C.void.r, C.void.g, C.void.b)
    self:drawRect(0, 0, self.width, th, 1, C.ash.r, C.ash.g, C.ash.b)
    self:drawRect(0, th - 1, self.width, 1, 1, C.hazard.r, C.hazard.g, C.hazard.b)

    -- Hairline between rail and page, drawn by the frame so neither panel needs
    -- a border that would double up along the shared edge.
    if self.host and self.host:getIsVisible() then
        self:drawRect(self.host:getX(), th, 1, self.host:getHeight(), 1, C.fence.r, C.fence.g, C.fence.b)
    end

    self:drawRectBorder(0, 0, self.width, self.height, 1, C.fence.r, C.fence.g, C.fence.b)

    if self.title then
        self:drawTextCentre(self.title, self.width / 2, 2, C.bone.r, C.bone.g, C.bone.b, 1, UIFont.Small)
    end
end

function KnoxDeskWindow:rebuildRail()
    if not self.rail then
        return
    end

    self.rail:clearChildren()
    self.railButtons = {}

    for _, page in ipairs(sortedPages()) do
        local id = page.id
        local button = KnoxNavButton:new(6, 0, 40, KR_Desk.Metric.rowTall,
            string.upper(tostring(page.label or page.id)), self, function()
                KR_Desk.show(id)
            end)
        KR_Desk.styleButton(button, "nav")
        button.knoxActive = (id == activeId)
        button.knoxUnread = pageUnread(page)
        button:initialise()
        self.rail:addChild(button)
        self.railButtons[#self.railButtons + 1] = button
    end

    self:layoutRail()
end

function KnoxDeskWindow:layoutPage()
    if mounted and type(mounted.layout) == "function" and self.host then
        pcall(mounted.layout, mounted, self.host)
    end
end

function KnoxDeskWindow:onResize()
    ISCollapsableWindow.onResize(self)
    self:placeChrome()
    self:layoutPage()
end

function KnoxDeskWindow:close()
    KR_Desk.hide()
end

--------------------------------------------------------------------------
-- Open / close
--------------------------------------------------------------------------

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
        local x, y, w, h = openGeometry()
        instance = KnoxDeskWindow:new(x, y, w, h)
        instance:setTitle("KNOX DESK")
        instance:initialise()
        instance:addToUIManager()
        instance:setVisible(true)
        instance.pin = true
        pcall(function() instance:pin() end)
    else
        instance:setVisible(true)
        instance:addToUIManager()
    end
    -- RestoreLayout runs during addToUIManager and can write a saved drag
    -- size over the constructor. Snap after that, then size the hole.
    instance:applyLockedSize()
    instance:hideResizeGrip()
    instance:placeChrome()

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
    instance:layoutPage()
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
