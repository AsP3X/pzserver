--
-- KR_DeskFriends.lua — Friends page. Incoming requests, the roster, a name box.
--
-- Accept and decline live here so a player who got the overhead ask can
-- answer without leaving the game. The website is the same list.
--

require "ISUI/ISPanel"
require "ISUI/ISButton"
require "ISUI/ISLabel"
require "ISUI/ISScrollingListBox"
require "ISUI/ISTextEntryBox"

local LOG = "[KnoxRelay] "
local CHANNEL = "KnoxRelay"

local state = {
    unread = 0,
    incoming = {},
    outgoing = {},
    friends = {},
    blocked = {},
}
local tab = "requests"
local view = nil

if not (KR_Desk and KR_Desk.Color and KR_Desk.Metric) then
    print(LOG .. "Desk Friends: shell missing, page not registered")
    return
end

local C = KR_Desk.Color
local M = KR_Desk.Metric

local function sendAction(action, fields)
    local player = getSpecificPlayer(0)
    if not player then
        return
    end
    local payload = { action = action }
    if type(fields) == "table" then
        for key, value in pairs(fields) do
            payload[key] = value
        end
    end
    pcall(function()
        sendClientCommand(player, CHANNEL, "friendAction", payload)
    end)
end

local function askState()
    local player = getSpecificPlayer(0)
    if not player then
        return
    end
    pcall(function()
        sendClientCommand(player, CHANNEL, "deskOpen", {})
    end)
end

local function tagged(entry, kind)
    return {
        id = entry.id,
        username = entry.username,
        online = entry.online,
        share_position = entry.share_position,
        their_share_position = entry.their_share_position,
        _kind = kind,
    }
end

local function rowsFor(which)
    if which == "friends" then
        return state.friends or {}
    end
    if which == "blocked" then
        return state.blocked or {}
    end
    local list = {}
    for _, entry in ipairs(state.incoming or {}) do
        list[#list + 1] = tagged(entry, "incoming")
    end
    for _, entry in ipairs(state.outgoing or {}) do
        list[#list + 1] = tagged(entry, "outgoing")
    end
    return list
end

local box = function(...) return KR_Desk.box(...) end

KnoxFriendsView = ISPanel:derive("KnoxFriendsView")

function KnoxFriendsView:initialise()
    ISPanel.initialise(self)
    self.backgroundColor = C.ash
    self.borderColor = C.clear
    self.noticeText = ""
end

function KnoxFriendsView:createChildren()
    self.tabRequests = ISButton:new(0, 0, 100, M.row, "REQUESTS", self, function()
        tab = "requests"
        self:paintTabs()
        self:populate()
        self:setNotice("")
    end)
    self.tabFriends = ISButton:new(0, 0, 100, M.row, "FRIENDS", self, function()
        tab = "friends"
        self:paintTabs()
        self:populate()
        self:setNotice("")
    end)
    self.tabBlocked = ISButton:new(0, 0, 100, M.row, "BLOCKED", self, function()
        tab = "blocked"
        self:paintTabs()
        self:populate()
        self:setNotice("")
    end)
    self.tabRequests:initialise()
    self.tabFriends:initialise()
    self.tabBlocked:initialise()
    self:addChild(self.tabRequests)
    self:addChild(self.tabFriends)
    self:addChild(self.tabBlocked)

    self.list = ISScrollingListBox:new(0, 0, 200, 200)
    self.list:initialise()
    self.list:instantiate()
    self.list.itemheight = KR_Desk.lineHeight() * 2 + 14
    self.list.selected = 0
    self.list.font = UIFont.Small
    self.list.drawBorder = false
    self.list.backgroundColor = C.void
    self.list.borderColor = C.fence
    self.list.doDrawItem = KnoxFriendsView.drawRow
    self.list:setOnMouseDownFunction(self, function()
        self:applyActions()
    end)
    self:addChild(self.list)

    self.nameBox = ISTextEntryBox:new("", 0, 0, 200, M.field)
    self.nameBox:initialise()
    self.nameBox.backgroundColor = C.void
    self.nameBox.borderColor = C.fence
    self.nameBox.font = UIFont.Small
    self:addChild(self.nameBox)

    self.sendBtn = ISButton:new(0, 0, 120, M.row, "SEND REQUEST", self, KnoxFriendsView.onSend)
    KR_Desk.styleButton(self.sendBtn, "primary")
    self.sendBtn:initialise()
    self:addChild(self.sendBtn)

    self.acceptBtn = ISButton:new(0, 0, 90, M.row, "ACCEPT", self, KnoxFriendsView.onAccept)
    self.declineBtn = ISButton:new(0, 0, 90, M.row, "DECLINE", self, KnoxFriendsView.onDecline)
    self.cancelBtn = ISButton:new(0, 0, 90, M.row, "CANCEL", self, KnoxFriendsView.onCancel)
    self.unfriendBtn = ISButton:new(0, 0, 90, M.row, "UNFRIEND", self, KnoxFriendsView.onUnfriend)
    self.blockBtn = ISButton:new(0, 0, 90, M.row, "BLOCK", self, KnoxFriendsView.onBlock)
    self.unblockBtn = ISButton:new(0, 0, 90, M.row, "UNBLOCK", self, KnoxFriendsView.onUnblock)
    self.shareBtn = ISButton:new(0, 0, 120, M.row, "SHARING MAP", self, KnoxFriendsView.onShare)

    for _, button in ipairs({
        self.acceptBtn, self.declineBtn, self.cancelBtn,
        self.unfriendBtn, self.blockBtn, self.unblockBtn, self.shareBtn,
    }) do
        button:initialise()
        KR_Desk.styleButton(button, "ghost")
        self:addChild(button)
    end
    KR_Desk.styleButton(self.acceptBtn, "primary")

    self.notice = ISLabel:new(0, 0, KR_Desk.lineHeight(), "", C.hazard.r, C.hazard.g, C.hazard.b, 1, UIFont.Small, true)
    self.notice:initialise()
    self:addChild(self.notice)

    self:paintTabs()
    self:populate()
    self:relayout()
end

function KnoxFriendsView:paintTabs()
    KR_Desk.styleButton(self.tabRequests, tab == "requests" and "primary" or "ghost")
    KR_Desk.styleButton(self.tabFriends, tab == "friends" and "primary" or "ghost")
    KR_Desk.styleButton(self.tabBlocked, tab == "blocked" and "primary" or "ghost")
    local incoming = #(state.incoming or {})
    if incoming > 0 then
        self.tabRequests:setTitle("REQUESTS " .. tostring(incoming))
    else
        self.tabRequests:setTitle("REQUESTS")
    end
end

function KnoxFriendsView:selectedEntry()
    local row = self.list.items and self.list.items[self.list.selected]
    return row and row.item or nil
end

function KnoxFriendsView:drawRow(y, item, alt)
    local font = UIFont.Small
    local lh = KR_Desk.lineHeight()
    local rowH = lh * 2 + 14
    item.height = rowH

    local entry = item.item
    local w = self:getWidth()
    local selected = self.selected == item.index

    if selected then
        self:drawRect(0, y, w, rowH, 1, C.ember.r, C.ember.g, C.ember.b)
    elseif self.mouseoverselected == item.index then
        self:drawRect(0, y, w, rowH, 1, C.raised.r, C.raised.g, C.raised.b)
    end
    self:drawRect(0, y + rowH - 1, w, 1, 0.6, C.fence.r, C.fence.g, C.fence.b)

    local name = KR_Desk.clip(tostring(item.text or ""), w - 20)
    local titleTint = selected and C.hazard or C.bone
    self:drawText(name, 11, y + 6, titleTint.r, titleTint.g, titleTint.b, 1, font)

    local meta = ""
    if type(entry) == "table" then
        if entry._kind == "incoming" then
            meta = "wants to be friends"
        elseif entry._kind == "outgoing" then
            meta = "request sent"
        elseif entry.online then
            meta = "in game"
        else
            meta = "offline"
        end
    end
    local metaTint = (type(entry) == "table" and entry.online) and C.moss or C.dust
    self:drawText(KR_Desk.clip(meta, w - 20), 11, y + 6 + lh + 2, metaTint.r, metaTint.g, metaTint.b, 1, font)

    return y + rowH
end

function KnoxFriendsView:populate()
    if not self.list then
        return
    end
    local selectedName = nil
    local current = self:selectedEntry()
    if current then
        selectedName = current.username
    end
    self.list:clear()
    for _, entry in ipairs(rowsFor(tab)) do
        self.list:addItem(tostring(entry.username or ""), entry)
        if selectedName and string.lower(tostring(entry.username or "")) == string.lower(selectedName) then
            self.list.selected = self.list.count
        end
    end
    if self.list.selected < 1 and self.list.count > 0 then
        self.list.selected = 1
    end
    KR_Desk.refit(self.list)
    self:applyActions()
end

function KnoxFriendsView:applyActions()
    local entry = self:selectedEntry()
    local incoming = tab == "requests" and entry and entry._kind == "incoming"
    local outgoing = tab == "requests" and entry and entry._kind == "outgoing"
    local friend = tab == "friends" and entry ~= nil
    local blocked = tab == "blocked" and entry ~= nil

    self.acceptBtn:setVisible(incoming == true)
    self.declineBtn:setVisible(incoming == true)
    self.cancelBtn:setVisible(outgoing == true)
    self.unfriendBtn:setVisible(friend == true)
    self.blockBtn:setVisible(friend == true or incoming == true)
    self.shareBtn:setVisible(friend == true)
    self.unblockBtn:setVisible(blocked == true)

    if friend and entry then
        if entry.share_position then
            self.shareBtn:setTitle("SHARING MAP")
            KR_Desk.styleButton(self.shareBtn, "primary")
        else
            self.shareBtn:setTitle("MAP HIDDEN")
            KR_Desk.styleButton(self.shareBtn, "ghost")
        end
    end
end

function KnoxFriendsView:setNotice(text)
    self.noticeText = tostring(text or "")
    if self.notice then
        self.notice:setName(KR_Desk.clip(self.noticeText, self._noticeW or 280))
    end
end

function KnoxFriendsView:onSend()
    local name = self.nameBox:getText() or ""
    name = string.gsub(string.gsub(name, "^%s+", ""), "%s+$", "")
    if name == "" then
        self:setNotice("Type a survivor name.")
        return
    end
    sendAction("request", { target = name })
    self.nameBox:setText("")
    self:setNotice("Asking " .. name .. "...")
    askState()
end

function KnoxFriendsView:onAccept()
    local entry = self:selectedEntry()
    if not entry then
        return
    end
    sendAction("accept", { friendship_id = tostring(entry.id) })
    self:setNotice("Accepted.")
    askState()
end

function KnoxFriendsView:onDecline()
    local entry = self:selectedEntry()
    if not entry then
        return
    end
    sendAction("decline", { friendship_id = tostring(entry.id) })
    self:setNotice("Declined.")
    askState()
end

function KnoxFriendsView:onCancel()
    local entry = self:selectedEntry()
    if not entry then
        return
    end
    sendAction("cancel", { friendship_id = tostring(entry.id) })
    self:setNotice("Request cancelled.")
    askState()
end

function KnoxFriendsView:onUnfriend()
    local entry = self:selectedEntry()
    if not entry then
        return
    end
    sendAction("unfriend", { friendship_id = tostring(entry.id) })
    self:setNotice("Removed.")
    askState()
end

function KnoxFriendsView:onBlock()
    local entry = self:selectedEntry()
    if not entry then
        return
    end
    sendAction("block", { friendship_id = tostring(entry.id) })
    self:setNotice("Blocked.")
    askState()
end

function KnoxFriendsView:onUnblock()
    local entry = self:selectedEntry()
    if not entry then
        return
    end
    sendAction("unblock", { friendship_id = tostring(entry.id) })
    self:setNotice("Unblocked.")
    askState()
end

function KnoxFriendsView:onShare()
    local entry = self:selectedEntry()
    if not entry then
        return
    end
    local nextShare = not entry.share_position
    sendAction("share", { friendship_id = tostring(entry.id), share_position = nextShare })
    entry.share_position = nextShare
    self:applyActions()
    self:setNotice(nextShare and "Sharing your map pin." or "Map pin hidden from them.")
end

function KnoxFriendsView:relayout()
    local w = self:getWidth()
    local h = self:getHeight()
    if w < 40 or h < 40 then
        return
    end

    local pad, gap = M.pad, M.gap
    local innerW = math.max(40, w - pad * 2)
    local tabW = math.floor((innerW - gap * 2) / 3)

    box(self.tabRequests, pad, pad, tabW, M.row)
    box(self.tabFriends, pad + tabW + gap, pad, tabW, M.row)
    box(self.tabBlocked, pad + (tabW + gap) * 2, pad, tabW, M.row)

    local footerH = M.field + M.row + gap * 2 + M.row
    local listY = pad + M.row + gap
    local listH = math.max(64, h - listY - footerH - pad)
    box(self.list, pad, listY, innerW, listH)

    local nameY = listY + listH + gap
    local sendW = 140
    box(self.nameBox, pad, nameY, math.max(80, innerW - sendW - gap), M.field)
    box(self.sendBtn, pad + innerW - sendW, nameY, sendW, M.row)

    local actionY = nameY + M.field + gap
    local btnW = 92
    local x = pad
    box(self.acceptBtn, x, actionY, btnW, M.row)
    box(self.declineBtn, x + btnW + gap, actionY, btnW, M.row)
    box(self.cancelBtn, x, actionY, btnW, M.row)
    box(self.unfriendBtn, x, actionY, btnW, M.row)
    box(self.blockBtn, x + btnW + gap, actionY, btnW, M.row)
    box(self.shareBtn, x + (btnW + gap) * 2, actionY, 130, M.row)
    box(self.unblockBtn, x, actionY, 110, M.row)

    self.notice:setX(pad)
    self.notice:setY(h - pad - KR_Desk.lineHeight())
    self._noticeW = innerW
    self:setNotice(self.noticeText)

    KR_Desk.refit(self.list)
end

function KnoxFriendsView:prerender()
    ISPanel.prerender(self)
    self:applyActions()
end

function KnoxFriendsView:render()
    if not self.list or not self.list:getIsVisible() then
        return
    end
    if self.list.count > 0 then
        return
    end
    local x = self.list:getX() + 12
    local y = self.list:getY() + 14
    local empty = "No friends yet."
    if tab == "requests" then
        empty = "No requests. Right-click a survivor, or type a name below."
    elseif tab == "blocked" then
        empty = "Nobody blocked."
    end
    self:drawText(empty, x, y, C.smoke.r, C.smoke.g, C.smoke.b, 1, UIFont.Small)
end

function KnoxFriendsView:refresh()
    self:paintTabs()
    self:populate()
end

--------------------------------------------------------------------------
-- Page contract
--------------------------------------------------------------------------

local page = {
    id = "friends",
    label = "FRIENDS",
    order = 6,
}

function page.unread()
    return #(state.incoming or {})
end

function page.mount(self, host)
    if not host then
        return
    end
    host:clearChildren()
    askState()
    local w = math.max(120, host:getWidth())
    local h = math.max(120, host:getHeight())
    view = KnoxFriendsView:new(0, 0, w, h)
    view:initialise()
    host:addChild(view)
    view:relayout()
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
else
    print(LOG .. "Desk Friends: shell not loaded yet")
end

local function onServerCommand(module, command, args)
    if module ~= CHANNEL or command ~= "friendsState" then
        return
    end
    if type(args) ~= "table" then
        return
    end
    state.unread = tonumber(args.unread) or 0
    state.incoming = args.incoming or {}
    state.outgoing = args.outgoing or {}
    state.friends = args.friends or {}
    state.blocked = args.blocked or {}
    if view then
        view:refresh()
    end
    if KR_Desk and KR_Desk.refreshRail then
        KR_Desk.refreshRail()
    end
end

Events.OnServerCommand.Add(onServerCommand)

print(LOG .. "Desk Friends page loaded")
