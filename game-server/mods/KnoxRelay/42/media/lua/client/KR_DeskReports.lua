--
-- KR_DeskReports.lua — Reports page. Registers with the Desk; owns its widgets.
--
-- Layout rule for this file: solve bottom-up. Everything with a fixed height
-- (the action row, the reply box) is pinned to the bottom edge first, and the
-- one flexible widget above it absorbs whatever is left. Laying out top-down
-- was what let the send button walk off the panel on a short window, and what
-- put the status label on the same row as the button.
--

require "ISUI/ISPanel"
require "ISUI/ISButton"
require "ISUI/ISLabel"
require "ISUI/ISScrollingListBox"
require "ISUI/ISTextEntryBox"
require "ISUI/ISRichTextPanel"

local LOG = "[KnoxRelay] "
local CHANNEL = "KnoxRelay"

local inbox = { unread = 0, reports = {}, updated_at = "" }
local selectedId = nil
local mode = "browse"
local composeKind = "report"
local view = nil

-- The shell owns the palette, the spacing scale and the geometry helpers. PZ
-- walks this directory alphabetically so KR_Desk is always in place first; if
-- it somehow is not, bail out rather than paint the page black on black.
if not (KR_Desk and KR_Desk.Color and KR_Desk.Metric) then
    print(LOG .. "Desk Reports: shell missing, page not registered")
    return
end

local C = KR_Desk.Color
local M = KR_Desk.Metric

-- Below this the two columns stop making sense and the page stacks.
local STACK_AT = 250
local MIN_THREAD = 70
local MIN_LIST = 64
local MIN_REPLY = 44

local function findReport(id)
    for _, report in ipairs(inbox.reports or {}) do
        if tonumber(report.id) == tonumber(id) then
            return report
        end
    end
    return nil
end

local function unreadCount()
    local count = 0
    for _, report in ipairs(inbox.reports or {}) do
        if report.unread then
            count = count + 1
        end
    end
    return count
end

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
        sendClientCommand(player, CHANNEL, "deskAction", payload)
    end)
end

local function askInbox()
    local player = getSpecificPlayer(0)
    if not player then
        return
    end
    pcall(function()
        sendClientCommand(player, CHANNEL, "deskOpen", {})
    end)
end

local function escapeRich(text)
    text = tostring(text or "")
    text = string.gsub(text, "<", " ")
    text = string.gsub(text, ">", " ")
    text = string.gsub(text, "\r\n", " <LINE> ")
    text = string.gsub(text, "\n", " <LINE> ")
    return text
end

local function statusRgb(status)
    if status == "rejected" then
        return C.blood
    end
    if status == "resolved" then
        return C.moss
    end
    if status == "investigating" then
        return C.hazard
    end
    return C.smoke
end

local function threadText(report)
    if not report then
        return " <RGB:0.40,0.43,0.38> Nothing selected. <LINE> <LINE> Pick a ticket on the left, or start a new one with NEW REPORT. "
    end

    local bits = {}
    bits[#bits + 1] = " <H2> " .. escapeRich(report.subject or "")
    bits[#bits + 1] = " <LINE> <RGB:0.95,0.64,0.05> " .. string.upper(tostring(report.status or "open"))
    if report.accused and report.accused ~= "" then
        bits[#bits + 1] = " <RGB:0.40,0.43,0.38>  ·  about " .. escapeRich(report.accused)
    end
    bits[#bits + 1] = " <LINE> <LINE> "

    local messages = report.messages
    if type(messages) ~= "table" or #messages == 0 then
        bits[#bits + 1] = " <RGB:0.91,0.90,0.87> " .. escapeRich(report.body or "")
        return table.concat(bits)
    end

    for _, message in ipairs(messages) do
        if message.role == "staff" then
            bits[#bits + 1] = " <RGB:0.95,0.64,0.05> TEAM <LINE> "
        else
            bits[#bits + 1] = " <RGB:0.55,0.69,0.29> YOU <LINE> "
        end
        bits[#bits + 1] = " <RGB:0.91,0.90,0.87> " .. escapeRich(message.body or "") .. " <LINE> <LINE> "
    end

    return table.concat(bits)
end

local box = function(...) return KR_Desk.box(...) end

KnoxReportsView = ISPanel:derive("KnoxReportsView")

function KnoxReportsView:initialise()
    ISPanel.initialise(self)
    self.backgroundColor = C.ash
    self.borderColor = C.clear
    self.noticeText = ""
end

--------------------------------------------------------------------------
-- Sizing primitives
--------------------------------------------------------------------------

function KnoxReportsView.lineHeight()
    return KR_Desk.lineHeight()
end

function KnoxReportsView.rowHeight()
    -- Two lines per ticket: subject, then status and who it is about.
    return KR_Desk.lineHeight() * 2 + 14
end

function KnoxReportsView.captionHeight()
    return KR_Desk.lineHeight() + M.tight
end

--- Preferred reply height, before the layout takes any of it back.
function KnoxReportsView.replyHeight()
    local height = KR_Desk.lineHeight() * 4 + 20
    if height < 76 then
        height = 76
    end
    if height > 150 then
        height = 150
    end
    return height
end

function KnoxReportsView.makeMultiline(el, maxLines)
    if not el then
        return
    end
    pcall(function()
        if el.setMultipleLine then
            el:setMultipleLine(true)
        elseif el.javaObject and el.javaObject.setMultipleLine then
            el.javaObject:setMultipleLine(true)
        end
        if el.setMaxLines then
            el:setMaxLines(maxLines or 8)
        elseif el.javaObject and el.javaObject.setMaxLines then
            el.javaObject:setMaxLines(maxLines or 8)
        end
    end)
end

--------------------------------------------------------------------------
-- Widgets
--------------------------------------------------------------------------

function KnoxReportsView:createChildren()
    self.newBtn = ISButton:new(0, 0, 120, M.row, "+ NEW REPORT", self, KnoxReportsView.onNew)
    KR_Desk.styleButton(self.newBtn, "primary")
    self.newBtn:initialise()
    self:addChild(self.newBtn)

    self.backBtn = ISButton:new(0, 0, 80, M.row, "< BACK", self, KnoxReportsView.onBack)
    KR_Desk.styleButton(self.backBtn, "ghost")
    self.backBtn:initialise()
    self:addChild(self.backBtn)

    self.notice = ISLabel:new(0, 0, KR_Desk.lineHeight(), "", C.hazard.r, C.hazard.g, C.hazard.b, 1, UIFont.Small, true)
    self.notice:initialise()
    self:addChild(self.notice)

    self.list = ISScrollingListBox:new(0, 0, 200, 200)
    self.list:initialise()
    self.list:instantiate()
    self.list.itemheight = KnoxReportsView.rowHeight()
    self.list.selected = 0
    self.list.font = UIFont.Small
    self.list.drawBorder = false
    self.list.backgroundColor = C.void
    self.list.borderColor = C.fence
    self.list.textColor = C.bone
    self.list.selectedTextColor = C.hazard
    self.list.selectionColor = C.ember
    self.list.doDrawItem = KnoxReportsView.drawTicket
    self.list:setOnMouseDownFunction(self, KnoxReportsView.onPick)
    self:addChild(self.list)

    self.thread = ISRichTextPanel:new(0, 0, 200, 200)
    self.thread:initialise()
    self.thread.background = true
    self.thread.backgroundColor = C.void
    self.thread.borderColor = C.fence
    self.thread.autosetheight = false
    self.thread.clip = true
    self.thread.marginLeft = 14
    self.thread.marginRight = 18
    self.thread.marginTop = 10
    self.thread.marginBottom = 10
    self:addChild(self.thread)

    self.reply = ISTextEntryBox:new("", 0, 0, 200, KnoxReportsView.replyHeight())
    self.reply:initialise()
    self.reply:instantiate()
    self.reply.backgroundColor = C.void
    self.reply.borderColor = C.fence
    self.reply.font = UIFont.Small
    self:addChild(self.reply)
    KnoxReportsView.makeMultiline(self.reply, 8)

    self.sendBtn = ISButton:new(0, 0, 84, M.row, "SEND", self, KnoxReportsView.onSend)
    KR_Desk.styleButton(self.sendBtn, "primary")
    self.sendBtn:initialise()
    self:addChild(self.sendBtn)

    self.kindReport = ISButton:new(0, 0, 100, M.row, "REPORT", self, KnoxReportsView.onKindReport)
    self.kindSupport = ISButton:new(0, 0, 100, M.row, "SUPPORT", self, KnoxReportsView.onKindSupport)
    self.kindReport:initialise()
    self.kindSupport:initialise()
    self:addChild(self.kindReport)
    self:addChild(self.kindSupport)

    self.accusedLbl = ISLabel:new(0, 0, M.label, "WHO", C.dust.r, C.dust.g, C.dust.b, 1, UIFont.Small, true)
    self.subjectLbl = ISLabel:new(0, 0, M.label, "SUBJECT", C.dust.r, C.dust.g, C.dust.b, 1, UIFont.Small, true)
    self.bodyLbl = ISLabel:new(0, 0, M.label, "WHAT HAPPENED", C.dust.r, C.dust.g, C.dust.b, 1, UIFont.Small, true)
    self.accusedLbl:initialise()
    self.subjectLbl:initialise()
    self.bodyLbl:initialise()
    self:addChild(self.accusedLbl)
    self:addChild(self.subjectLbl)
    self:addChild(self.bodyLbl)

    self.accused = ISTextEntryBox:new("", 0, 0, 200, M.field)
    self.subject = ISTextEntryBox:new("", 0, 0, 200, M.field)
    self.body = ISTextEntryBox:new("", 0, 0, 200, 80)
    self.accused:initialise()
    self.subject:initialise()
    self.body:initialise()
    self.body:instantiate()
    for _, entry in ipairs({ self.accused, self.subject, self.body }) do
        entry.backgroundColor = C.void
        entry.borderColor = C.fence
        entry.font = UIFont.Small
    end
    self:addChild(self.accused)
    self:addChild(self.subject)
    self:addChild(self.body)
    KnoxReportsView.makeMultiline(self.body, 10)

    self.fileBtn = ISButton:new(0, 0, 150, M.row, "FILE REPORT", self, KnoxReportsView.onFile)
    KR_Desk.styleButton(self.fileBtn, "primary")
    self.fileBtn:initialise()
    self:addChild(self.fileBtn)

    self:relayout()
    self:applyMode()
    self:populate()
    self:showThread()
end

--------------------------------------------------------------------------
-- Layout
--------------------------------------------------------------------------

--- Place the status label and the action button on one row without ever
--- letting them touch: the button owns the right edge, the label gets the rest.
function KnoxReportsView:footerRow(x, y, w, button, buttonW)
    local gap = M.gap
    local btnW = math.min(buttonW, math.max(52, w - 60))
    box(button, x + w - btnW, y, btnW, M.row)

    local noticeW = w - btnW - gap
    self.notice:setX(x)
    self.notice:setY(y + math.floor((M.row - KR_Desk.lineHeight()) / 2))
    self._noticeW = math.max(20, noticeW)
    self:paintNotice()
end

function KnoxReportsView:relayout()
    local w = self:getWidth()
    local h = self:getHeight()
    if w < 40 or h < 40 then
        return
    end

    if mode == "compose" then
        self:layoutCompose(w, h)
    else
        self:layoutBrowse(w, h)
    end

    self:syncListRows()
    KR_Desk.refit(self.list)
    KR_Desk.refit(self.thread)
end

function KnoxReportsView:layoutCompose(w, h)
    local pad, gap = M.pad, M.gap
    local innerW = math.max(40, w - pad * 2)
    local capH = KnoxReportsView.captionHeight()

    -- Top-down for the header, because those rows are fixed and few.
    local y = pad
    box(self.backBtn, pad, y, 84, M.row)
    y = y + M.row + gap

    local kindW = math.min(120, math.floor((innerW - gap) / 2))
    box(self.kindReport, pad, y, kindW, M.row)
    box(self.kindSupport, pad + kindW + gap, y, kindW, M.row)
    y = y + M.row + gap

    if composeKind == "report" then
        self.accusedLbl:setX(pad)
        self.accusedLbl:setY(y)
        y = y + capH
        box(self.accused, pad, y, innerW, M.field)
        y = y + M.field + gap
    end

    self.subjectLbl:setX(pad)
    self.subjectLbl:setY(y)
    y = y + capH
    box(self.subject, pad, y, innerW, M.field)
    y = y + M.field + gap

    self.bodyLbl:setX(pad)
    self.bodyLbl:setY(y)
    y = y + capH

    -- Bottom-up from here: the action row is pinned, the body takes the rest.
    local footerY = h - pad - M.row
    local bodyH = footerY - gap - y
    if bodyH < 48 then
        bodyH = 48
    end
    box(self.body, pad, y, innerW, bodyH)
    KnoxReportsView.makeMultiline(self.body, 10)

    self:footerRow(pad, math.max(y + bodyH + gap, footerY), innerW, self.fileBtn, 150)
end

function KnoxReportsView:layoutBrowse(w, h)
    local pad, gap = M.pad, M.gap
    local innerW = math.max(40, w - pad * 2)
    local capH = KnoxReportsView.captionHeight()

    local listW = math.floor(innerW * 0.34)
    if listW < 190 then
        listW = 190
    end
    if listW > 300 then
        listW = 300
    end
    local threadW = innerW - listW - gap
    local stacked = threadW < STACK_AT

    local top = pad + capH
    local bottom = h - pad

    if not stacked then
        -- Left column: caption, list, new-report button pinned to the bottom.
        local listBtnY = bottom - M.row
        local listH = math.max(MIN_LIST, listBtnY - gap - top)
        box(self.list, pad, top, listW, listH)
        box(self.newBtn, pad, listBtnY, listW, M.row)

        -- Right column: caption, thread, reply, action row.
        local threadX = pad + listW + gap
        self:stackThread(threadX, top, threadW, bottom)
        return
    end

    -- Stacked: one column, list on top with a fixed share, thread below.
    listW = innerW
    threadW = innerW

    local footerY = bottom - M.row
    local replyH = KnoxReportsView.replyHeight()

    -- Give the list about a third of the free run, but never so much that the
    -- thread drops under its floor.
    local free = footerY - gap - top
    local listH = math.floor((free - M.row - capH - replyH - gap * 3) * 0.34)
    if listH < MIN_LIST then
        listH = MIN_LIST
    end

    local listBtnY = top + listH + gap
    local threadCapY = listBtnY + M.row + gap
    local threadTop = threadCapY + capH
    local threadBottom = footerY

    -- If the thread cannot fit under that split, take the difference back off
    -- the list before touching the reply box.
    local replyY = threadBottom - gap - replyH
    local threadH = replyY - gap - threadTop
    if threadH < MIN_THREAD then
        local deficit = MIN_THREAD - threadH
        listH = math.max(MIN_LIST, listH - deficit)
        listBtnY = top + listH + gap
        threadCapY = listBtnY + M.row + gap
        threadTop = threadCapY + capH
        threadH = replyY - gap - threadTop
    end
    -- Still short: the window is genuinely tiny, so shrink the reply box.
    if threadH < MIN_THREAD then
        replyH = math.max(MIN_REPLY, replyH - (MIN_THREAD - threadH))
        replyY = threadBottom - gap - replyH
        threadH = math.max(24, replyY - gap - threadTop)
    end

    box(self.list, pad, top, listW, listH)
    box(self.newBtn, pad, listBtnY, listW, M.row)
    self._threadCapY = threadCapY
    box(self.thread, pad, threadTop, threadW, threadH)
    box(self.reply, pad, replyY, threadW, replyH)
    KnoxReportsView.makeMultiline(self.reply, 8)
    self:footerRow(pad, footerY, threadW, self.sendBtn, 84)
end

--- Thread + reply + action row inside one column running to `bottom`.
function KnoxReportsView:stackThread(x, top, w, bottom)
    local gap = M.gap
    local footerY = bottom - M.row
    local replyH = KnoxReportsView.replyHeight()
    local replyY = footerY - gap - replyH
    local threadH = replyY - gap - top

    if threadH < MIN_THREAD then
        replyH = math.max(MIN_REPLY, replyH - (MIN_THREAD - threadH))
        replyY = footerY - gap - replyH
        threadH = math.max(24, replyY - gap - top)
    end

    self._threadCapY = top - KnoxReportsView.captionHeight()
    box(self.thread, x, top, w, threadH)
    box(self.reply, x, replyY, w, replyH)
    KnoxReportsView.makeMultiline(self.reply, 8)
    self:footerRow(x, footerY, w, self.sendBtn, 84)
end

--------------------------------------------------------------------------
-- Painting
--------------------------------------------------------------------------

function KnoxReportsView:prerender()
    ISPanel.prerender(self)

    if mode == "compose" then
        return
    end

    -- Column captions, drawn rather than held as ISLabels so they cost nothing
    -- to move and cannot drift out of step with the widgets they head.
    local capY = math.max(0, self._threadCapY or M.pad)
    if self.list and self.list:getIsVisible() then
        self:drawText("TICKETS", self.list:getX(), M.pad, C.dust.r, C.dust.g, C.dust.b, 1, UIFont.Small)
    end
    if self.thread and self.thread:getIsVisible() then
        self:drawText("CONVERSATION", self.thread:getX(), capY, C.dust.r, C.dust.g, C.dust.b, 1, UIFont.Small)
    end
end

--- Foreground pass. The empty-state sits *inside* the list's own rect, and the
--- list paints an opaque background of its own, so drawing this in prerender
--- put it underneath. render() runs after children.
function KnoxReportsView:render()
    if mode == "compose" or not self.list or not self.list:getIsVisible() then
        return
    end
    if #(inbox.reports or {}) > 0 then
        return
    end

    local x = self.list:getX() + 12
    local y = self.list:getY() + 14
    self:drawText("No tickets yet.", x, y, C.smoke.r, C.smoke.g, C.smoke.b, 1, UIFont.Small)
    self:drawText("Use NEW REPORT below.", x, y + KR_Desk.lineHeight() + 3,
        C.dust.r, C.dust.g, C.dust.b, 1, UIFont.Small)
end

--- One ticket row: subject on the first line, status pill and target below.
function KnoxReportsView:drawTicket(y, item, alt)
    local font = UIFont.Small
    local lh = KR_Desk.lineHeight()
    local rowH = lh * 2 + 14
    item.height = rowH

    local report = item.item
    local w = self:getWidth()
    local selected = self.selected == item.index

    if selected then
        self:drawRect(0, y, w, rowH, 1, C.ember.r, C.ember.g, C.ember.b)
    elseif self.mouseoverselected == item.index then
        self:drawRect(0, y, w, rowH, 1, C.raised.r, C.raised.g, C.raised.b)
    end

    local unread = type(report) == "table" and report.unread
    if unread then
        self:drawRect(0, y, 3, rowH, 1, C.hazard.r, C.hazard.g, C.hazard.b)
    end
    self:drawRect(0, y + rowH - 1, w, 1, 0.6, C.fence.r, C.fence.g, C.fence.b)

    local rightPad = 10
    pcall(function()
        if self.vscroll and self.vscroll:getIsVisible() then
            rightPad = rightPad + (self.vscroll:getWidth() or 13)
        end
    end)

    local textX = 11
    local titleTint = selected and C.hazard or C.bone
    local title = KR_Desk.clip(tostring(item.text or ""), w - textX - rightPad)
    self:drawText(title, textX, y + 6, titleTint.r, titleTint.g, titleTint.b, 1, font)

    local status = type(report) == "table" and string.lower(tostring(report.status or "open")) or "open"
    local tint = statusRgb(status)
    local label = string.upper(status)
    local pillW = KR_Desk.measure(label, 40) + 10
    local pillY = y + 6 + lh + 2
    self:drawRect(textX, pillY, pillW, lh + 1, 0.22, tint.r, tint.g, tint.b)
    self:drawText(label, textX + 5, pillY, tint.r, tint.g, tint.b, 1, font)

    local accused = type(report) == "table" and report.accused or nil
    if accused and accused ~= "" then
        local metaX = textX + pillW + 8
        local room = w - metaX - rightPad
        if room > 24 then
            self:drawText(KR_Desk.clip("about " .. tostring(accused), room), metaX, pillY,
                C.dust.r, C.dust.g, C.dust.b, 1, font)
        end
    end

    return y + rowH
end

function KnoxReportsView:syncListRows()
    if not self.list then
        return
    end
    local rowH = KnoxReportsView.rowHeight()
    self.list.itemheight = rowH
    local items = self.list.items
    if type(items) ~= "table" then
        return
    end
    for _, item in ipairs(items) do
        item.height = rowH
    end
end

function KnoxReportsView:paintNotice()
    if not self.notice then
        return
    end
    local room = self._noticeW or 200
    self.notice:setName(KR_Desk.clip(self.noticeText or "", room))
end

function KnoxReportsView:setNotice(text)
    self.noticeText = tostring(text or "")
    self:paintNotice()
end

--------------------------------------------------------------------------
-- Behaviour
--------------------------------------------------------------------------

function KnoxReportsView:onPick(item)
    if type(item) ~= "table" or not item.id then
        return
    end
    selectedId = item.id
    if item.unread then
        sendAction("read", { report_id = item.id })
        item.unread = false
    end
    self:showThread()
    if KR_Desk and KR_Desk.refreshRail then
        KR_Desk.refreshRail()
    end
end

function KnoxReportsView:onNew()
    mode = "compose"
    composeKind = "report"
    self:applyMode()
    self:setNotice("")
end

function KnoxReportsView:onBack()
    mode = "browse"
    self:applyMode()
    self:setNotice("")
end

function KnoxReportsView:onKindReport()
    composeKind = "report"
    self:applyMode()
end

function KnoxReportsView:onKindSupport()
    composeKind = "support"
    self:applyMode()
end

function KnoxReportsView:paintKind()
    KR_Desk.styleButton(self.kindReport, composeKind == "report" and "primary" or "ghost")
    KR_Desk.styleButton(self.kindSupport, composeKind == "support" and "primary" or "ghost")
end

function KnoxReportsView:onSend()
    local text = self.reply:getText()
    if not selectedId then
        self:setNotice("Pick a ticket first.")
        return
    end
    if not text or text == "" then
        self:setNotice("Write a reply first.")
        return
    end
    sendAction("reply", { report_id = selectedId, body = text })
    self.reply:setText("")
    self:setNotice("Sent.")
end

function KnoxReportsView:onFile()
    local subject = self.subject:getText() or ""
    local body = self.body:getText() or ""
    local accused = self.accused:getText() or ""
    if subject == "" or body == "" then
        self:setNotice("Subject and details are required.")
        return
    end
    if composeKind == "report" and accused == "" then
        self:setNotice("Say who you are reporting.")
        return
    end
    sendAction("create", {
        kind = composeKind,
        subject = subject,
        body = body,
        accused = accused,
    })
    self.subject:setText("")
    self.body:setText("")
    self.accused:setText("")
    mode = "browse"
    self:applyMode()
    self:setNotice("Report sent. It will appear in a moment.")
    askInbox()
end

function KnoxReportsView:applyMode()
    local compose = mode == "compose"
    self.newBtn:setVisible(not compose)
    self.list:setVisible(not compose)
    self.thread:setVisible(not compose)
    self.reply:setVisible(not compose)
    self.sendBtn:setVisible(not compose)

    self.backBtn:setVisible(compose)
    self.kindReport:setVisible(compose)
    self.kindSupport:setVisible(compose)
    self.subjectLbl:setVisible(compose)
    self.subject:setVisible(compose)
    self.bodyLbl:setVisible(compose)
    self.body:setVisible(compose)
    self.fileBtn:setVisible(compose)
    self.accusedLbl:setVisible(compose and composeKind == "report")
    self.accused:setVisible(compose and composeKind == "report")
    if compose then
        self:paintKind()
    end
    self:relayout()
end

function KnoxReportsView:populate()
    if not self.list then
        return
    end
    self.list:clear()
    for _, report in ipairs(inbox.reports or {}) do
        local title = tostring(report.subject or ("#" .. tostring(report.id)))
        self.list:addItem(title, report)
        if selectedId and tonumber(report.id) == tonumber(selectedId) then
            self.list.selected = self.list.count
        end
    end
    if (not selectedId) and inbox.reports and inbox.reports[1] then
        selectedId = inbox.reports[1].id
        self.list.selected = 1
    end
    self:syncListRows()
    KR_Desk.refit(self.list)
end

function KnoxReportsView:showThread()
    if not self.thread then
        return
    end
    self.thread:setText(threadText(findReport(selectedId)))
    KR_Desk.refit(self.thread)
end

function KnoxReportsView:refresh()
    self:populate()
    self:showThread()
end

--------------------------------------------------------------------------
-- Page contract
--------------------------------------------------------------------------

local page = {
    id = "reports",
    label = "REPORTS",
    order = 10,
}

function page.unread()
    return unreadCount()
end

function page.mount(self, host)
    if not host then
        return
    end
    host:clearChildren()
    askInbox()

    local w = math.max(120, host:getWidth())
    local h = math.max(120, host:getHeight())

    view = KnoxReportsView:new(0, 0, w, h)
    view:initialise()
    host:addChild(view)
    view:relayout()
    view:applyMode()
    view:populate()
    view:showThread()
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
    print(LOG .. "Desk Reports: shell not loaded yet")
end

local function onServerCommand(module, command, args)
    if module ~= CHANNEL or command ~= "deskInbox" then
        return
    end
    if type(args) ~= "table" then
        return
    end
    inbox.unread = tonumber(args.unread) or 0
    inbox.updated_at = tostring(args.updated_at or "")
    inbox.reports = args.reports or {}
    if view then
        view:refresh()
    end
    if KR_Desk and KR_Desk.refreshRail then
        KR_Desk.refreshRail()
    end
end

Events.OnServerCommand.Add(onServerCommand)

print(LOG .. "Desk Reports page loaded")
