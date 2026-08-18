--
-- Tests for the Knox Desk layout — KR_Desk.lua and KR_DeskReports.lua.
--
-- These exist because the desk is resizable and nothing about a resize can be
-- checked by reading the code. The old shell wired
--
--     self.resizeWidget.resizeFunction = KnoxDeskWindow.applySize
--
-- assuming ISResizeWidget calls it as (self, w, h). It does not, so a drag ran
-- a signature the widget never passes, and separately the reply box and the
-- send button were both laid out from the top and landed on the same row on a
-- short window.
--
-- So this file stands up enough of ISUI to hold real geometry, then sweeps the
-- frame across a grid of sizes and asserts the invariants a human would check
-- by dragging the corner: nothing escapes its parent, nothing overlaps
-- anything else, and the rail and the page tile the content area exactly.
--
-- Project Zomboid runs Lua 5.1, so run this with luajit, not luaXX:
--   luajit game-server/tests/kr-desk.test.lua   (exit 0 = all pass)
--

local HERE = (arg and arg[0] or ""):match("^(.*)/[^/]*$") or "."
local CLIENT = HERE .. "/../mods/KnoxRelay/42/media/lua/client/"

local pass, fail = 0, 0
local function ok(desc) pass = pass + 1; print("PASS: " .. desc) end
local function ng(desc, why) fail = fail + 1; print("FAIL: " .. desc .. " — " .. tostring(why)) end
local function check(desc, cond, why) if cond then ok(desc) else ng(desc, why or "assertion failed") end end

--------------------------------------------------------------------------
-- Enough ISUI to hold geometry
--------------------------------------------------------------------------

function require() end

UIFont = { Small = "Small", Medium = "Medium" }

local FONT_H = 14
function getTextManager()
    return {
        getFontFromEnum = function() return nil end,
        getFontHeight = function() return FONT_H end,
        -- Wide enough that clipping actually triggers on long strings.
        MeasureStringX = function(_, _, text) return #tostring(text or "") * 7 end,
    }
end

function getCore()
    return {
        getScreenWidth = function() return 1920 end,
        getScreenHeight = function() return 1080 end,
    }
end

local handlers = {}
Events = setmetatable({}, {
    __index = function(self, name)
        handlers[name] = handlers[name] or {}
        local slot = {
            Add = function(fn) table.insert(handlers[name], fn) end,
            Remove = function(fn)
                for i, existing in ipairs(handlers[name]) do
                    if existing == fn then table.remove(handlers[name], i); break end
                end
            end,
        }
        rawset(self, name, slot)
        return slot
    end,
})

local function fire(name, ...)
    for _, fn in ipairs({ unpack(handlers[name] or {}) }) do fn(...) end
end

function getSpecificPlayer() return { name = "tester" } end

local sent = {}
function sendClientCommand(_, module, command, args)
    sent[#sent + 1] = { module = module, command = command, args = args }
end

--------------------------------------------------------------------------
-- ISUIElement and friends
--------------------------------------------------------------------------

ISUIElement = {}
ISUIElement.Type = "ISUIElement"

function ISUIElement:derive(name)
    local o = {}
    setmetatable(o, self)
    self.__index = self
    o.Type = name
    return o
end

function ISUIElement:new(x, y, w, h)
    local o = setmetatable({}, self)
    self.__index = self
    o.x, o.y, o.width, o.height = x or 0, y or 0, w or 0, h or 0
    o.children = {}
    o.visible = true
    o.parent = nil
    return o
end

function ISUIElement:initialise() self:createChildren() end
function ISUIElement:createChildren() end
function ISUIElement:instantiate() self.javaObject = nil end

function ISUIElement:setX(v) self.x = v end
function ISUIElement:setY(v) self.y = v end
function ISUIElement:setWidth(v) self.width = v end
function ISUIElement:setHeight(v) self.height = v end
function ISUIElement:getX() return self.x end
function ISUIElement:getY() return self.y end
function ISUIElement:getWidth() return self.width end
function ISUIElement:getHeight() return self.height end
function ISUIElement:setVisible(v) self.visible = v and true or false end
function ISUIElement:getIsVisible() return self.visible end
function ISUIElement:isMouseOver() return false end

function ISUIElement:addChild(c) c.parent = self; self.children[#self.children + 1] = c end
function ISUIElement:clearChildren() self.children = {} end
function ISUIElement:addToUIManager() self.inManager = true end
function ISUIElement:removeFromUIManager() self.inManager = false end
function ISUIElement:setAlwaysOnTop() end
function ISUIElement:onResize() end
function ISUIElement:prerender() end
function ISUIElement:render() end

-- Drawing is a no-op, but must not blow up when the layout calls it.
function ISUIElement:drawRect() end
function ISUIElement:drawRectBorder() end
function ISUIElement:drawText() end
function ISUIElement:drawTextCentre() end

ISPanel = ISUIElement:derive("ISPanel")

ISButton = ISPanel:derive("ISButton")
function ISButton:new(x, y, w, h, title, target, onclick)
    local o = ISPanel.new(self, x, y, w, h)
    o.title = title
    o.target = target
    o.onclick = onclick
    return o
end
function ISButton:setTitle(t) self.title = t end

ISLabel = ISUIElement:derive("ISLabel")
function ISLabel:new(x, y, h, name, r, g, b, a, font, left)
    local o = ISUIElement.new(self, x, y, 0, h)
    o.name = name or ""
    return o
end
function ISLabel:setName(n) self.name = n end

ISScrollingListBox = ISPanel:derive("ISScrollingListBox")
function ISScrollingListBox:new(x, y, w, h)
    local o = ISPanel.new(self, x, y, w, h)
    o.items = {}
    o.count = 0
    o.itemheight = 20
    o.selected = 0
    o.scrollHeight = 0
    o.yScroll = 0
    return o
end
function ISScrollingListBox:addItem(text, item)
    self.count = self.count + 1
    local row = { text = text, item = item, index = self.count, height = self.itemheight }
    -- The real widget copies the payload's fields onto the row; onPick reads
    -- item.id and item.unread off it.
    if type(item) == "table" then
        row.id = item.id
        row.unread = item.unread
    end
    self.items[self.count] = row
    self:setScrollHeight(self.count * self.itemheight)
    return row
end
function ISScrollingListBox:clear() self.items = {}; self.count = 0; self:setScrollHeight(0) end
function ISScrollingListBox:setOnMouseDownFunction(target, fn) self.onMouseDownTarget = target; self.onMouseDownFn = fn end
function ISScrollingListBox:setScrollHeight(v) self.scrollHeight = v end
function ISScrollingListBox:getScrollHeight() return self.scrollHeight end
function ISScrollingListBox:updateScrollbars() self.scrollbarsUpdated = (self.scrollbarsUpdated or 0) + 1 end
function ISScrollingListBox:getYScroll() return self.yScroll end
function ISScrollingListBox:setYScroll(v) self.yScroll = v end

ISTextEntryBox = ISPanel:derive("ISTextEntryBox")
function ISTextEntryBox:new(text, x, y, w, h)
    local o = ISPanel.new(self, x, y, w, h)
    o.text = text or ""
    return o
end
function ISTextEntryBox:getText() return self.text end
function ISTextEntryBox:setText(t) self.text = t end
function ISTextEntryBox:setMultipleLine() end
function ISTextEntryBox:setMaxLines() end

ISRichTextPanel = ISPanel:derive("ISRichTextPanel")
function ISRichTextPanel:new(x, y, w, h)
    local o = ISPanel.new(self, x, y, w, h)
    o.text = ""
    o.scrollHeight = 0
    o.yScroll = 0
    return o
end
function ISRichTextPanel:setText(t) self.text = t end
function ISRichTextPanel:paginate()
    self.paginated = (self.paginated or 0) + 1
    -- Roughly: narrower panel, more wrapped lines, taller content.
    local width = math.max(1, self.width - 32)
    self.scrollHeight = math.ceil(#self.text * 7 / width) * FONT_H
end
function ISRichTextPanel:getScrollHeight() return self.scrollHeight end
function ISRichTextPanel:getYScroll() return self.yScroll end
function ISRichTextPanel:setYScroll(v) self.yScroll = v end

ISCollapsableWindow = ISPanel:derive("ISCollapsableWindow")
function ISCollapsableWindow:initialise() ISPanel.initialise(self) end
function ISCollapsableWindow:createChildren()
    -- The real window builds these; the shell must not depend on their layout.
    self.resizeWidget = ISUIElement:new(0, 0, 10, 10)
    self.resizeWidget2 = ISUIElement:new(0, 0, 10, 10)
end
function ISCollapsableWindow:titleBarHeight() return 16 end
function ISCollapsableWindow:resizeWidgetHeight() return 8 end
function ISCollapsableWindow:setTitle(t) self.title = t end
function ISCollapsableWindow:pin() end
function ISCollapsableWindow:onResize() end

--------------------------------------------------------------------------
-- Load the mod
--------------------------------------------------------------------------

assert(loadfile(CLIENT .. "KR_Desk.lua"))()
assert(loadfile(CLIENT .. "KR_DeskReports.lua"))()

check("shell exposes the palette and spacing scale",
    KR_Desk.Color ~= nil and KR_Desk.Metric ~= nil)

--------------------------------------------------------------------------
-- Geometry assertions
--------------------------------------------------------------------------

local function rect(el)
    return { x = el:getX(), y = el:getY(), w = el:getWidth(), h = el:getHeight() }
end

local function overlaps(a, b)
    return a.x < b.x + b.w and b.x < a.x + a.w
       and a.y < b.y + b.h and b.y < a.y + a.h
end

local function inside(child, parentW, parentH)
    local r = rect(child)
    return r.x >= 0 and r.y >= 0 and r.x + r.w <= parentW and r.y + r.h <= parentH
end

local function describe(name, el)
    local r = rect(el)
    return string.format("%s=(%d,%d %dx%d)", name, r.x, r.y, r.w, r.h)
end

--------------------------------------------------------------------------
-- Open the desk and give it tickets
--------------------------------------------------------------------------

KR_Desk.show()
local win = KR_Desk.instance()
check("desk opened", win ~= nil)
check("reports page registered and got a nav button",
    #win.railButtons == 1 and win.railButtons[1].title == "REPORTS",
    "rail buttons=" .. #win.railButtons)

local function feed(count)
    local reports = {}
    for i = 1, count do
        reports[i] = {
            id = i,
            subject = "Ticket number " .. i .. " with a deliberately long subject line",
            status = ({ "open", "investigating", "resolved", "rejected" })[(i % 4) + 1],
            accused = "SomePlayerWithALongName" .. i,
            unread = (i % 3 == 0),
            messages = {
                { role = "player", body = "Original complaint text for ticket " .. i },
                { role = "staff", body = "Staff answer for ticket " .. i },
            },
        }
    end
    fire("OnServerCommand", "KnoxRelay", "deskInbox",
        { unread = count, updated_at = "2026-08-18T10:00:00", reports = reports })
end

feed(12)

local view = win.host.children[1]
check("reports view mounted into the host", view ~= nil and view.Type == "KnoxReportsView")
check("tickets reached the list", view and view.list.count == 12,
    view and ("count=" .. tostring(view.list.count)))

--------------------------------------------------------------------------
-- The sweep
--------------------------------------------------------------------------

--- Drive the frame to a size the way the game does: write width/height, then
--- let prerender notice and relay out.
local function resizeTo(w, h)
    win:setWidth(w)
    win:setHeight(h)
    win:prerender()
end

local MIN_W, MIN_H = KR_Desk.MIN_WIDTH, KR_Desk.MIN_HEIGHT
local TH, RH = 16, 8

local sizes = {}
for w = MIN_W, 1700, 53 do
    for h = MIN_H, 1150, 47 do
        sizes[#sizes + 1] = { w, h }
    end
end
-- The exact minimum and a few awkward aspect ratios get an explicit visit.
local corners = { { MIN_W, MIN_H }, { MIN_W, 1150 }, { 1700, MIN_H }, { 560, 421 }, { 561, 420 } }
for _, s in ipairs(corners) do sizes[#sizes + 1] = s end

local function sweep(label, prepare, widgets)
    local badTile, badInside, badOverlap, badNotice = nil, nil, nil, nil

    for _, size in ipairs(sizes) do
        local w, h = size[1], size[2]
        resizeTo(w, h)
        if prepare then prepare() end

        local innerH = h - TH - RH
        local rail, host = win.rail, win.host

        -- 1. Rail and host tile the content row with no gap and no overlap.
        if not badTile then
            local okTile = rail:getX() == 0
                and host:getX() == rail:getWidth()
                and rail:getWidth() + host:getWidth() == w
                and rail:getY() == TH and host:getY() == TH
                and rail:getHeight() == innerH and host:getHeight() == innerH
            if not okTile then
                badTile = string.format("%dx%d: %s %s (innerH=%d)",
                    w, h, describe("rail", rail), describe("host", host), innerH)
            end
        end

        -- 2. Every visible widget stays inside the page.
        if not badInside then
            for name, el in pairs(widgets()) do
                if el:getIsVisible() and not inside(el, view:getWidth(), view:getHeight()) then
                    badInside = string.format("%dx%d: %s escapes view %dx%d",
                        w, h, describe(name, el), view:getWidth(), view:getHeight())
                    break
                end
            end
        end

        -- 3. No two visible widgets share a pixel.
        if not badOverlap then
            local list = {}
            for name, el in pairs(widgets()) do
                if el:getIsVisible() then list[#list + 1] = { name = name, el = el } end
            end
            for i = 1, #list do
                for j = i + 1, #list do
                    if overlaps(rect(list[i].el), rect(list[j].el)) then
                        badOverlap = string.format("%dx%d: %s over %s",
                            w, h, describe(list[i].name, list[i].el), describe(list[j].name, list[j].el))
                        break
                    end
                end
                if badOverlap then break end
            end
        end

        -- 4. The status label's reserved room ends before the action button.
        if not badNotice then
            local btn = view.sendBtn:getIsVisible() and view.sendBtn or view.fileBtn
            local room = view._noticeW or 0
            if view.notice:getX() + room > btn:getX() + 0.5 then
                badNotice = string.format("%dx%d: notice x=%d w=%d runs into %s",
                    w, h, view.notice:getX(), room, describe("button", btn))
            end
        end
    end

    check(label .. ": rail and page tile the content area", badTile == nil, badTile)
    check(label .. ": every widget stays inside the page", badInside == nil, badInside)
    check(label .. ": no two widgets overlap", badOverlap == nil, badOverlap)
    check(label .. ": status text never runs into the action button", badNotice == nil, badNotice)
end

-- Browse mode.
sweep("browse", nil, function()
    return {
        list = view.list, newBtn = view.newBtn,
        thread = view.thread, reply = view.reply, sendBtn = view.sendBtn,
    }
end)

-- Compose mode, report kind (the widest form — it has the WHO field).
view:onNew()
sweep("compose/report", nil, function()
    return {
        backBtn = view.backBtn, kindReport = view.kindReport, kindSupport = view.kindSupport,
        accused = view.accused, subject = view.subject, body = view.body, fileBtn = view.fileBtn,
    }
end)

-- Compose mode, support kind (no WHO field).
view:onKindSupport()
sweep("compose/support", nil, function()
    return {
        backBtn = view.backBtn, kindReport = view.kindReport, kindSupport = view.kindSupport,
        subject = view.subject, body = view.body, fileBtn = view.fileBtn,
    }
end)

view:onBack()

--------------------------------------------------------------------------
-- Targeted checks
--------------------------------------------------------------------------

resizeTo(1200, 800)
check("wide desk puts the thread beside the list",
    view.thread:getX() > view.list:getX() + view.list:getWidth() - 1,
    describe("list", view.list) .. " " .. describe("thread", view.thread))

resizeTo(MIN_W, 900)
check("narrow desk stacks the thread under the list",
    view.thread:getY() > view.list:getY() + view.list:getHeight() - 1,
    describe("list", view.list) .. " " .. describe("thread", view.thread))

-- Scroll state has to be re-derived from the new size, or the list scrolls
-- against bounds it had when it was created.
resizeTo(1400, 1000)
local tallScroll = view.list.scrollHeight
local bars = view.list.scrollbarsUpdated or 0
resizeTo(MIN_W, MIN_H)
check("list scrollbars refresh on resize", (view.list.scrollbarsUpdated or 0) > bars,
    "updates before=" .. bars .. " after=" .. tostring(view.list.scrollbarsUpdated))
check("list scroll extent tracks the row count",
    view.list.scrollHeight == view.list.count * view.list.itemheight,
    "scrollHeight=" .. tostring(view.list.scrollHeight))

-- Rich text has to re-wrap, and must not stay scrolled past its own end.
resizeTo(1400, 1000)
local wideExtent = view.thread.scrollHeight
resizeTo(MIN_W, MIN_H)
check("thread re-wraps when the column narrows", view.thread.scrollHeight >= wideExtent,
    "wide=" .. tostring(wideExtent) .. " narrow=" .. tostring(view.thread.scrollHeight))

view.thread:setYScroll(-99999)
KR_Desk.refit(view.thread)
check("thread scroll is clamped to its content",
    view.thread:getYScroll() >= math.min(0, view.thread:getHeight() - view.thread:getScrollHeight()),
    "yScroll=" .. tostring(view.thread:getYScroll()))

-- Collapsing must not leave the page hanging below the title bar.
resizeTo(900, TH)
check("collapsed frame hides the rail", not win.rail:getIsVisible())
check("collapsed frame hides the page", not win.host:getIsVisible())
resizeTo(900, 600)
check("restoring the frame brings the page back", win.host:getIsVisible())

-- An empty inbox still has to lay out.
feed(0)
resizeTo(MIN_W, MIN_H)
check("empty inbox lays out", view.list:getHeight() > 0 and view.list.count == 0)
feed(3)

--------------------------------------------------------------------------
-- Rail
--------------------------------------------------------------------------

check("rail width is clamped on a narrow frame", KR_Desk.railWidth(MIN_W) <= 168)
check("rail width grows with the frame", KR_Desk.railWidth(1600) > KR_Desk.railWidth(700))
check("rail never starves the page", KR_Desk.railWidth(400) <= 400 - 220 + 1)

-- Many pages must not spill out of the rail.
for i = 1, 14 do
    KR_Desk.register({ id = "filler" .. i, label = "PAGE " .. i, order = 100 + i })
end
resizeTo(900, MIN_H)
win:rebuildRail()
local spilled = nil
for _, button in ipairs(win.railButtons) do
    if button:getIsVisible() and not inside(button, win.rail:getWidth(), win.rail:getHeight()) then
        spilled = describe("nav", button) .. " rail=" .. describe("rail", win.rail)
        break
    end
end
check("nav buttons stay inside the rail when many pages register", spilled == nil, spilled)

--------------------------------------------------------------------------

print(string.format("\n%d passed, %d failed", pass, fail))
os.exit(fail == 0 and 0 or 1)
