--
-- KR_DeskInbox.lua — panel notices: sold listings, held vault returns, etc.
--
-- Reports stay on their own page. This one is a list the player can clear.
-- Layout matches Reports: captions are drawn, the action row is pinned, and
-- the list/body split the leftover. A 45% top-down split plus paginate-every-
-- frame is what stacked MARK READ on top of the body.
--

require "ISUI/ISPanel"
require "ISUI/ISButton"
require "ISUI/ISScrollingListBox"
require "ISUI/ISRichTextPanel"

local LOG = "[KnoxRelay] "
local CHANNEL = "KnoxRelay"

local notices = {}
local view = nil

if not (KR_Desk and KR_Desk.Color and KR_Desk.Metric) then
    print(LOG .. "Desk Inbox: shell missing, page not registered")
    return
end

local C = KR_Desk.Color
local M = KR_Desk.Metric

local STACK_AT = 250
local MIN_LIST = 64
local MIN_BODY = 70

local function unreadCount()
    local count = 0
    for _, notice in ipairs(notices) do
        if notice.unread then
            count = count + 1
        end
    end
    return count
end

local function ack(id)
    local player = getSpecificPlayer(0)
    if not player then
        return
    end
    pcall(function()
        sendClientCommand(player, CHANNEL, "deskAction", {
            action = "notice_ack",
            body = tostring(id or ""),
        })
    end)
end

local box = function(...) return KR_Desk.box(...) end

local function captionHeight()
    return KR_Desk.lineHeight() + M.tight
end

KnoxInboxView = ISPanel:derive("KnoxInboxView")

function KnoxInboxView:initialise()
    ISPanel.initialise(self)
    self.backgroundColor = C.ash
    self.borderColor = C.clear
    KR_Desk.lockWidget(self)
end

function KnoxInboxView:createChildren()
    self.list = ISScrollingListBox:new(0, 0, 200, 200)
    self.list:initialise()
    self.list:instantiate()
    KR_Desk.lockWidget(self.list)
    self.list.backgroundColor = C.void
    self.list.borderColor = C.fence
    self.list.itemheight = KR_Desk.lineHeight() * 2 + 14
    self.list.selected = 0
    self.list.font = UIFont.Small
    self.list.drawBorder = false
    self.list.doDrawItem = KnoxInboxView.drawRow
    self.list:setOnMouseDownFunction(self, KnoxInboxView.onPick)
    self:addChild(self.list)

    self.body = ISRichTextPanel:new(0, 0, 200, 200)
    self.body:initialise()
    KR_Desk.lockWidget(self.body)
    self.body.background = true
    self.body.backgroundColor = C.void
    self.body.borderColor = C.fence
    self.body.marginLeft = 14
    self.body.marginRight = 18
    self.body.marginTop = 10
    self.body.marginBottom = 10
    self.body.autosetheight = false
    self.body.clip = true
    self:addChild(self.body)

    self.clear = ISButton:new(0, 0, 140, M.row, "MARK READ", self, function()
        local row = self.list.items and self.list.items[self.list.selected]
        if row and row.item and row.item.id then
            ack(row.item.id)
            row.item.unread = false
            self:populate()
            self:showBody()
            if KR_Desk and KR_Desk.refreshRail then
                KR_Desk.refreshRail()
            end
        end
    end)
    self.clear:initialise()
    KR_Desk.lockWidget(self.clear)
    KR_Desk.styleButton(self.clear, "primary")
    self:addChild(self.clear)
end

function KnoxInboxView.drawRow(list, y, item, alt)
    local notice = item.item
    local w = list:getWidth()
    local h = list.itemheight
    if list.selected == item.index then
        list:drawRect(0, y, w, h, 1, C.ember.r, C.ember.g, C.ember.b)
    elseif alt then
        list:drawRect(0, y, w, h, 1, C.ash.r, C.ash.g, C.ash.b)
    end
    if notice and notice.unread then
        list:drawRect(0, y, 3, h, 1, C.hazard.r, C.hazard.g, C.hazard.b)
    end
    list:drawRect(0, y + h - 1, w, 1, 0.6, C.fence.r, C.fence.g, C.fence.b)
    local tint = (notice and notice.unread) and C.hazard or C.bone
    if list.selected == item.index then
        tint = C.hazard
    end
    list:drawText(KR_Desk.clip(notice and notice.title or "", w - 16), 8, y + 6, tint.r, tint.g, tint.b, 1, UIFont.Small)
    list:drawText(KR_Desk.clip(notice and notice.kind or "", w - 16), 8, y + 20, C.dust.r, C.dust.g, C.dust.b, 1, UIFont.Small)
    return y + h
end

function KnoxInboxView:onPick(_item)
    self:showBody()
end

function KnoxInboxView:populate()
    local selected = self.list.selected
    self.list:clear()
    for _, notice in ipairs(notices) do
        self.list:addItem(notice.title or "notice", notice)
    end
    if selected and selected >= 1 and selected <= #self.list.items then
        self.list.selected = selected
    elseif #self.list.items > 0 then
        self.list.selected = 1
    end
    KR_Desk.refit(self.list)
end

function KnoxInboxView:showBody()
    local row = self.list.items and self.list.items[self.list.selected]
    local notice = row and row.item
    local text = " <SIZE:small> <RGB:0.40,0.43,0.38> No notices. "
    if notice then
        text = " <SIZE:small> " .. tostring(notice.body or "")
    end
    if text == self._bodyText then
        return
    end
    self._bodyText = text
    self._shownSelected = self.list.selected
    self.body:setText(text)
    KR_Desk.refit(self.body)
end

function KnoxInboxView:relayout()
    local w = self:getWidth()
    local h = self:getHeight()
    if w < 40 or h < 40 then
        return
    end

    local pad, gap = M.pad, M.gap
    local innerW = math.max(40, w - pad * 2)
    local capH = captionHeight()
    local top = pad + capH
    local bottom = h - pad
    local footerY = bottom - M.row

    local listW = math.floor(innerW * 0.34)
    if listW < 190 then
        listW = 190
    end
    if listW > 300 then
        listW = 300
    end
    local bodyW = innerW - listW - gap
    local stacked = bodyW < STACK_AT

    if not stacked then
        local listH = math.max(MIN_LIST, bottom - top)
        box(self.list, pad, top, listW, listH)
        local bodyH = math.max(MIN_BODY, footerY - gap - top)
        box(self.body, pad + listW + gap, top, bodyW, bodyH)
        local btnW = math.min(140, bodyW)
        box(self.clear, pad + listW + gap + bodyW - btnW, footerY, btnW, M.row)
        self._listCapY = pad
        self._bodyCapY = pad
        KR_Desk.refit(self.list)
        KR_Desk.refit(self.body)
        return
    end

    -- One column: list on top with a fixed share, body then MARK READ below.
    listW = innerW
    bodyW = innerW

    local free = footerY - gap - top
    local listH = math.floor((free - capH - gap) * 0.42)
    if listH < MIN_LIST then
        listH = MIN_LIST
    end

    local bodyCapY = top + listH + gap
    local bodyY = bodyCapY + capH
    local bodyH = footerY - gap - bodyY
    if bodyH < MIN_BODY then
        local deficit = MIN_BODY - bodyH
        listH = math.max(24, listH - deficit)
        bodyCapY = top + listH + gap
        bodyY = bodyCapY + capH
        bodyH = footerY - gap - bodyY
    end
    if bodyH < 24 then
        bodyH = 24
        local listBottom = footerY - gap - bodyH - capH - gap
        listH = math.max(24, listBottom - top)
        bodyCapY = top + listH + gap
        bodyY = bodyCapY + capH
        bodyH = math.max(24, footerY - gap - bodyY)
    end

    box(self.list, pad, top, listW, listH)
    box(self.body, pad, bodyY, bodyW, bodyH)
    local btnW = math.min(140, bodyW)
    box(self.clear, pad + bodyW - btnW, footerY, btnW, M.row)
    self._listCapY = pad
    self._bodyCapY = bodyCapY

    KR_Desk.refit(self.list)
    KR_Desk.refit(self.body)
end

function KnoxInboxView:refresh()
    self:populate()
    self:showBody()
    self:relayout()
end

function KnoxInboxView:prerender()
    ISPanel.prerender(self)

    local sel = self.list and self.list.selected or 0
    if sel ~= self._shownSelected then
        self:showBody()
    end

    local listCapY = math.max(0, self._listCapY or M.pad)
    local bodyCapY = math.max(0, self._bodyCapY or M.pad)
    if self.list and self.list:getIsVisible() then
        self:drawText("NOTICES", self.list:getX(), listCapY, C.dust.r, C.dust.g, C.dust.b, 1, UIFont.Small)
    end
    if self.body and self.body:getIsVisible() then
        self:drawText("MESSAGE", self.body:getX(), bodyCapY, C.dust.r, C.dust.g, C.dust.b, 1, UIFont.Small)
    end
end

function KnoxInboxView:render()
    if not self.list or not self.list:getIsVisible() then
        return
    end
    if self.list.count and self.list.count > 0 then
        return
    end
    local x = self.list:getX() + 12
    local y = self.list:getY() + 14
    self:drawText("No notices.", x, y, C.smoke.r, C.smoke.g, C.smoke.b, 1, UIFont.Small)
end

local page = {
    id = "inbox",
    label = "INBOX",
    order = 5,
}

function page.unread()
    return unreadCount()
end

function page.mount(self, host)
    if not host then
        return
    end
    host:clearChildren()
    local player = getSpecificPlayer(0)
    if player then
        pcall(function()
            sendClientCommand(player, CHANNEL, "deskOpen", {})
        end)
    end
    local w = math.max(40, host:getWidth())
    local h = math.max(40, host:getHeight())
    view = KnoxInboxView:new(0, 0, w, h)
    view:initialise()
    host:addChild(view)
    box(view, 0, 0, host:getWidth(), host:getHeight())
    view:refresh()
end

function page.unmount()
    view = nil
end

function page.refresh()
    if view then
        view:refresh()
    end
end

function page.layout(self, host)
    if not view or not host then
        return
    end
    box(view, 0, 0, host:getWidth(), host:getHeight())
    view:relayout()
end

if KR_Desk and KR_Desk.register then
    KR_Desk.register(page)
end

local function onServerCommand(module, command, args)
    if module ~= CHANNEL or command ~= "deskInbox" then
        return
    end
    if type(args) ~= "table" then
        return
    end
    notices = args.notices or {}
    if view then
        view:refresh()
    end
    if KR_Desk and KR_Desk.refreshRail then
        KR_Desk.refreshRail()
    end
end

Events.OnServerCommand.Add(onServerCommand)

print(LOG .. "Desk Inbox page loaded")
