--
-- KR_DeskInbox.lua — panel notices: sold listings, held vault returns, etc.
--
-- Reports stay on their own page. This one is a list the player can clear.
--

require "ISUI/ISPanel"
require "ISUI/ISButton"
require "ISUI/ISLabel"
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

local function box(el, x, y, w, h)
    KR_Desk.box(el, x, y, w, h)
end

KnoxInboxView = ISPanel:derive("KnoxInboxView")

function KnoxInboxView:initialise()
    ISPanel.initialise(self)
    self.backgroundColor = C.ash
    self.borderColor = C.clear
    self.keepOnScreen = false
end

function KnoxInboxView:createChildren()
    self.heading = ISLabel:new(0, 0, M.label, "FROM THE RELAY", 1, 1, 1, 1, UIFont.Small, true)
    self.heading:initialise()
    self.heading:setColor(C.dust.r, C.dust.g, C.dust.b, 1)
    self:addChild(self.heading)

    self.list = ISScrollingListBox:new(0, 0, 100, 100)
    self.list:initialise()
    self.list.backgroundColor = C.void
    self.list.borderColor = C.fence
    self.list.itemheight = M.rowTall + 8
    self.list.drawBorder = true
    self.list.doDrawItem = KnoxInboxView.drawRow
    self:addChild(self.list)

    self.body = ISRichTextPanel:new(0, 0, 100, 80)
    self.body:initialise()
    self.body.backgroundColor = C.void
    self.body.borderColor = C.fence
    self.body.marginLeft = M.pad
    self.body.marginRight = M.pad
    self.body.marginTop = M.tight
    self.body.autosetheight = false
    self.body.clip = true
    self:addChild(self.body)

    self.clear = ISButton:new(0, 0, 120, M.row, "MARK READ", self, function()
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
    KR_Desk.styleButton(self.clear, "primary")
    self:addChild(self.clear)
end

function KnoxInboxView.drawRow(list, y, item, alt)
    local notice = item.item
    local w = list:getWidth()
    local h = list.itemheight
    if list.selected == item.index then
        list:drawRect(0, y, w, h, 1, C.raised.r, C.raised.g, C.raised.b)
    elseif alt then
        list:drawRect(0, y, w, h, 1, C.ash.r, C.ash.g, C.ash.b)
    end
    local tint = notice.unread and C.hazard or C.bone
    list:drawText(KR_Desk.clip(notice.title or "", w - 16), 8, y + 6, tint.r, tint.g, tint.b, 1, UIFont.Small)
    list:drawText(KR_Desk.clip(notice.kind or "", w - 16), 8, y + 20, C.dust.r, C.dust.g, C.dust.b, 1, UIFont.Small)
    return y + h
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
end

function KnoxInboxView:showBody()
    local row = self.list.items and self.list.items[self.list.selected]
    local notice = row and row.item
    local text = " <SIZE:small> No notices. "
    if notice then
        text = " <SIZE:small> " .. tostring(notice.body or "")
    end
    self.body:setText(text)
    self.body:paginate()
end

function KnoxInboxView:relayout()
    local w = math.max(120, self:getWidth())
    local h = math.max(120, self:getHeight())
    local pad = M.pad
    local listH = math.floor((h - M.row - M.label - pad * 3) * 0.45)
    box(self.heading, pad, pad, w - pad * 2, M.label)
    box(self.list, pad, pad + M.label + M.tight, w - pad * 2, listH)
    local bodyY = pad + M.label + M.tight + listH + M.gap
    local bodyH = h - bodyY - M.row - pad * 2
    box(self.body, pad, bodyY, w - pad * 2, math.max(40, bodyH))
    box(self.clear, pad, h - pad - M.row, 140, M.row)
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
    self:showBody()
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
    local w = math.max(120, host:getWidth())
    local h = math.max(120, host:getHeight())
    view = KnoxInboxView:new(0, 0, w, h)
    view:initialise()
    host:addChild(view)
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
