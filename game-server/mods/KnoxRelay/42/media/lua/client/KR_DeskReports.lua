--
-- KR_DeskReports.lua — Reports page. Registers with the Desk; owns its widgets.
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

local C = {
    void   = { r = 0.027, g = 0.031, b = 0.024, a = 1 },
    ash    = { r = 0.047, g = 0.059, b = 0.047, a = 1 },
    raised = { r = 0.071, g = 0.086, b = 0.071, a = 1 },
    fence  = { r = 0.114, g = 0.137, b = 0.110, a = 1 },
    bone   = { r = 0.910, g = 0.902, b = 0.867, a = 1 },
    hazard = { r = 0.949, g = 0.635, b = 0.047, a = 1 },
    moss   = { r = 0.545, g = 0.690, b = 0.290, a = 1 },
    blood  = { r = 0.753, g = 0.224, b = 0.169, a = 1 },
    smoke  = { r = 0.604, g = 0.627, b = 0.576, a = 1 },
}

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
        return " <RGB:0.40,0.43,0.38> No ticket selected. <LINE> File a new one with NEW REPORT, or pick a ticket on the left. "
    end

    local bits = {}
    bits[#bits + 1] = " <H2> " .. escapeRich(report.subject or "")
    bits[#bits + 1] = " <LINE> <RGB:0.95,0.64,0.05> " .. string.upper(tostring(report.status or "open"))
    bits[#bits + 1] = " <LINE> "
    if report.accused and report.accused ~= "" then
        bits[#bits + 1] = " <RGB:0.40,0.43,0.38> about " .. escapeRich(report.accused) .. " <LINE> "
    end
    bits[#bits + 1] = " <LINE> "

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

local function styleButton(button, border, text)
    button.backgroundColor = C.void
    button.backgroundColorMouseOver = C.raised
    button.borderColor = border
    button.textColor = text
end

KnoxReportsView = ISPanel:derive("KnoxReportsView")

function KnoxReportsView:initialise()
    ISPanel.initialise(self)
    self.backgroundColor = C.ash
    self.borderColor = C.fence
end

function KnoxReportsView:createChildren()
    self.newBtn = ISButton:new(0, 0, 220, 26, "+ NEW REPORT", self, KnoxReportsView.onNew)
    styleButton(self.newBtn, C.hazard, C.hazard)
    self.newBtn:initialise()
    self:addChild(self.newBtn)

    self.backBtn = ISButton:new(0, 0, 72, 22, "BACK", self, KnoxReportsView.onBack)
    styleButton(self.backBtn, C.fence, C.bone)
    self.backBtn:initialise()
    self:addChild(self.backBtn)

    self.notice = ISLabel:new(0, 0, 20, "", 0.95, 0.64, 0.05, 1, UIFont.Small, true)
    self.notice:initialise()
    self:addChild(self.notice)

    self.list = ISScrollingListBox:new(0, 0, 200, 200)
    self.list:initialise()
    self.list:instantiate()
    self.list.itemheight = KnoxReportsView.rowHeight()
    self.list.selected = 0
    self.list.font = UIFont.Small
    self.list.drawBorder = true
    self.list.backgroundColor = C.void
    self.list.borderColor = C.fence
    self.list.textColor = C.bone
    self.list.selectedTextColor = C.hazard
    self.list.selectionColor = { r = 0.23, g = 0.16, b = 0.02, a = 1 }
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
    self.thread.marginLeft = 12
    self.thread.marginRight = 16
    self.thread.marginTop = 8
    self.thread.marginBottom = 8
    self:addChild(self.thread)

    self.reply = ISTextEntryBox:new("", 0, 0, 200, KnoxReportsView.replyHeight())
    self.reply:initialise()
    self.reply:instantiate()
    self.reply.backgroundColor = C.void
    self.reply.borderColor = C.fence
    self.reply.font = UIFont.Small
    self:addChild(self.reply)
    KnoxReportsView.makeMultiline(self.reply, 8)

    self.sendBtn = ISButton:new(0, 0, 80, 28, "SEND", self, KnoxReportsView.onSend)
    styleButton(self.sendBtn, C.hazard, C.hazard)
    self.sendBtn:initialise()
    self:addChild(self.sendBtn)

    self.kindReport = ISButton:new(0, 0, 100, 26, "REPORT", self, KnoxReportsView.onKindReport)
    self.kindSupport = ISButton:new(0, 0, 100, 26, "SUPPORT", self, KnoxReportsView.onKindSupport)
    styleButton(self.kindReport, C.hazard, C.hazard)
    styleButton(self.kindSupport, C.fence, C.bone)
    self.kindReport:initialise()
    self.kindSupport:initialise()
    self:addChild(self.kindReport)
    self:addChild(self.kindSupport)

    self.accusedLbl = ISLabel:new(0, 0, 16, "WHO", 0.60, 0.63, 0.58, 1, UIFont.Small, true)
    self.subjectLbl = ISLabel:new(0, 0, 16, "SUBJECT", 0.60, 0.63, 0.58, 1, UIFont.Small, true)
    self.bodyLbl = ISLabel:new(0, 0, 16, "WHAT HAPPENED", 0.60, 0.63, 0.58, 1, UIFont.Small, true)
    self.accusedLbl:initialise()
    self.subjectLbl:initialise()
    self.bodyLbl:initialise()
    self:addChild(self.accusedLbl)
    self:addChild(self.subjectLbl)
    self:addChild(self.bodyLbl)

    self.accused = ISTextEntryBox:new("", 0, 0, 200, 26)
    self.subject = ISTextEntryBox:new("", 0, 0, 200, 26)
    self.body = ISTextEntryBox:new("", 0, 0, 200, 80)
    self.accused:initialise()
    self.subject:initialise()
    self.body:initialise()
    self.body:instantiate()
    self.body.font = UIFont.Small
    self:addChild(self.accused)
    self:addChild(self.subject)
    self:addChild(self.body)
    KnoxReportsView.makeMultiline(self.body, 10)

    self.fileBtn = ISButton:new(0, 0, 140, 28, "FILE REPORT", self, KnoxReportsView.onFile)
    styleButton(self.fileBtn, C.hazard, C.hazard)
    self.fileBtn:initialise()
    self:addChild(self.fileBtn)

    self:relayout()
    self:applyMode()
    self:populate()
    self:showThread()
end

local function box(el, x, y, w, h)
    if not el then
        return
    end
    if w < 1 then
        w = 1
    end
    if h < 1 then
        h = 1
    end
    el:setX(x)
    el:setY(y)
    el:setWidth(w)
    el:setHeight(h)
    pcall(function()
        if el.javaObject then
            el.javaObject:setX(x)
            el.javaObject:setY(y)
            el.javaObject:setWidth(w)
            el.javaObject:setHeight(h)
        end
    end)
end

function KnoxReportsView:relayout()
    local w = self:getWidth()
    local h = self:getHeight()
    if w < 40 or h < 40 then
        return
    end

    local pad = 10
    local gap = 8
    local toolH = 26
    local sendW = 80
    local sendH = 28
    local replyH = KnoxReportsView.replyHeight()
    local composerH = replyH + gap + sendH
    local innerW = math.max(40, w - pad * 2)
    local compose = mode == "compose"

    -- Compose is a single column that always fits the hole.
    if compose then
        local y = pad
        box(self.backBtn, pad, y, 80, toolH)
        self.notice:setX(pad + 88)
        self.notice:setY(y + 4)
        y = y + toolH + gap

        local kindW = math.min(110, math.floor((innerW - gap) / 2))
        box(self.kindReport, pad, y, kindW, toolH)
        box(self.kindSupport, pad + kindW + gap, y, kindW, toolH)
        y = y + toolH + gap

        local fieldH = 26
        local accusedH = 0
        if composeKind == "report" then
            self.accusedLbl:setX(pad)
            self.accusedLbl:setY(y)
            y = y + 16
            box(self.accused, pad, y, innerW, fieldH)
            y = y + fieldH + gap
            accusedH = 16 + fieldH + gap
        end

        self.subjectLbl:setX(pad)
        self.subjectLbl:setY(y)
        y = y + 16
        box(self.subject, pad, y, innerW, fieldH)
        y = y + fieldH + gap

        self.bodyLbl:setX(pad)
        self.bodyLbl:setY(y)
        y = y + 16

        local fileH = 28
        local bodyH = h - y - pad - fileH - gap
        if bodyH < 60 then
            bodyH = 60
        end
        box(self.body, pad, y, innerW, bodyH)
        KnoxReportsView.makeMultiline(self.body, 10)
        box(self.fileBtn, pad, y + bodyH + gap, math.min(160, innerW), fileH)
        return
    end

    -- Browse: side-by-side when there is room, otherwise stacked.
    local listW = math.floor(innerW * 0.34)
    if listW < 180 then
        listW = 180
    end
    if listW > 280 then
        listW = 280
    end
    local threadW = innerW - listW - gap
    local stacked = threadW < 200
    if stacked then
        listW = innerW
        threadW = innerW
    end

    local listX = pad
    local listY = pad
    local usableH = h - pad * 2

    if stacked then
        local listH = math.floor((usableH - toolH - composerH - gap * 3) * 0.36)
        if listH < 80 then
            listH = 80
        end
        local threadH = usableH - listH - toolH - composerH - gap * 3
        if threadH < 80 then
            threadH = 80
            listH = math.max(70, usableH - threadH - toolH - composerH - gap * 3)
        end

        box(self.list, listX, listY, listW, listH)
        box(self.newBtn, listX, listY + listH + gap, listW, toolH)

        local threadY = listY + listH + gap + toolH + gap
        local replyY = threadY + threadH + gap
        box(self.thread, listX, threadY, threadW, threadH)
        box(self.reply, listX, replyY, threadW, replyH)
        KnoxReportsView.makeMultiline(self.reply, 8)
        box(self.sendBtn, listX + threadW - sendW, replyY + replyH + gap, sendW, sendH)
        self.notice:setX(listX)
        self.notice:setY(replyY + replyH + gap + 4)
    else
        local listH = usableH - toolH - gap
        box(self.list, listX, listY, listW, listH)
        box(self.newBtn, listX, listY + listH + gap, listW, toolH)

        local threadX = listX + listW + gap
        local threadH = usableH - composerH - gap
        local replyY = pad + threadH + gap
        box(self.thread, threadX, pad, threadW, threadH)
        box(self.reply, threadX, replyY, threadW, replyH)
        KnoxReportsView.makeMultiline(self.reply, 8)
        box(self.sendBtn, threadX + threadW - sendW, replyY + replyH + gap, sendW, sendH)
        self.notice:setX(threadX)
        self.notice:setY(replyY + replyH + gap + 4)
    end

    box(self.backBtn, pad, pad, 80, toolH)
    self:syncListRows()
    pcall(function() self.thread:paginate() end)
end

function KnoxReportsView.lineHeight()
    local height = 16
    pcall(function()
        local tm = getTextManager()
        local font = tm:getFontFromEnum(UIFont.Small)
        if font and font.getLineHeight then
            height = font:getLineHeight()
        else
            height = tm:getFontHeight(UIFont.Small)
        end
    end)
    if height < 16 then
        height = 16
    end
    return height
end

function KnoxReportsView.fontHeight()
    return KnoxReportsView.lineHeight()
end

function KnoxReportsView.rowHeight()
    return KnoxReportsView.lineHeight() + 16
end

function KnoxReportsView.replyHeight()
    local height = KnoxReportsView.lineHeight() * 6 + 28
    if height < 120 then
        height = 120
    end
    if height > 200 then
        height = 200
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

function KnoxReportsView:drawTicket(y, item, alt)
    local font = UIFont.Small
    local lh = KnoxReportsView.lineHeight()
    local padY = 8
    local rowH = lh + padY * 2
    item.height = rowH

    local report = item.item
    if self.selected == item.index then
        self:drawRect(0, y, self:getWidth(), rowH, 1, 0.23, 0.16, 0.02)
    end
    self:drawRectBorder(0, y, self:getWidth(), rowH, 0.7, 0.11, 0.14, 0.11)

    if type(report) == "table" and report.unread then
        self:drawRect(0, y, 3, rowH, 1, 0.95, 0.64, 0.05)
    end

    local status = type(report) == "table" and string.upper(tostring(report.status or "open")) or ""
    local statusW = 48
    pcall(function()
        statusW = getTextManager():MeasureStringX(font, status)
    end)
    if statusW < 24 then
        statusW = 24
    end

    local rightPad = 12
    if self.vscroll and self.vscroll.getIsVisible and self.vscroll:getIsVisible() then
        rightPad = rightPad + (self.vscroll:getWidth() or 13)
    end
    local statusX = self:getWidth() - rightPad - statusW
    if statusX < 40 then
        statusX = 40
    end

    local title = tostring(item.text or "")
    local maxW = statusX - 16
    if maxW < 20 then
        maxW = 20
    end
    pcall(function()
        while getTextManager():MeasureStringX(font, title) > maxW and #title > 4 do
            title = string.sub(title, 1, #title - 4) .. "..."
        end
    end)

    local textY = y + padY
    self:drawText(title, 10, textY, 0.91, 0.90, 0.87, 1, font)
    local rgb = statusRgb(type(report) == "table" and tostring(report.status or "open") or "")
    self:drawText(status, statusX, textY, rgb.r, rgb.g, rgb.b, 1, font)

    return y + rowH
end

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
    self:paintKind()
    self:applyMode()
end

function KnoxReportsView:onKindSupport()
    composeKind = "support"
    self:paintKind()
    self:applyMode()
end

function KnoxReportsView:paintKind()
    styleButton(self.kindReport, composeKind == "report" and C.hazard or C.fence, composeKind == "report" and C.hazard or C.bone)
    styleButton(self.kindSupport, composeKind == "support" and C.hazard or C.fence, composeKind == "support" and C.hazard or C.bone)
end

function KnoxReportsView:onSend()
    local text = self.reply:getText()
    if not selectedId or not text or text == "" then
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

function KnoxReportsView:setNotice(text)
    self.notice:setName(tostring(text or ""))
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
end

function KnoxReportsView:showThread()
    if not self.thread then
        return
    end
    self.thread:setText(threadText(findReport(selectedId)))
    pcall(function() self.thread:paginate() end)
end

function KnoxReportsView:refresh()
    self:populate()
    self:showThread()
end

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

    local w = host:getWidth()
    local h = host:getHeight()
    if w < 40 then
        w = 600
    end
    if h < 40 then
        h = 400
    end

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
    view:setX(0)
    view:setY(0)
    view:setWidth(host:getWidth())
    view:setHeight(host:getHeight())
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
