--
-- KR_DeskHud.lua — permanent button that opens the Knox Desk.
--
-- Knows nothing about Reports. The badge is KR_Desk.unreadTotal().
--

require "ISUI/ISPanel"
require "ISUI/ISButton"

local LOG = "[KnoxRelay] "

KnoxHudButton = ISPanel:derive("KnoxHudButton")

function KnoxHudButton:initialise()
    ISPanel.initialise(self)
end

function KnoxHudButton:createChildren()
    self.button = ISButton:new(0, 0, self.width, self.height, "KR", self, function()
        if KR_Desk then
            KR_Desk.toggle()
        end
    end)
    self.button.backgroundColor = { r = 0.027, g = 0.031, b = 0.024, a = 0.92 }
    self.button.borderColor = { r = 0.949, g = 0.635, b = 0.047, a = 1 }
    self.button.textColor = { r = 0.949, g = 0.635, b = 0.047, a = 1 }
    self.button:initialise()
    self:addChild(self.button)
end

function KnoxHudButton:prerender()
    ISPanel.prerender(self)

    local unread = 0
    if KR_Desk and KR_Desk.unreadTotal then
        local ok, count = pcall(KR_Desk.unreadTotal)
        if ok and type(count) == "number" then
            unread = count
        end
    end

    if self.button then
        if unread > 0 then
            self.button:setTitle("KR " .. tostring(unread))
            self.button.borderColor = { r = 0.949, g = 0.635, b = 0.047, a = 1 }
        else
            self.button:setTitle("KR")
            self.button.borderColor = { r = 0.114, g = 0.137, b = 0.110, a = 1 }
        end
    end

    local core = getCore()
    if core then
        self:setX(core:getScreenWidth() - self.width - 16)
        self:setY(core:getScreenHeight() - self.height - 90)
    end
end

local hud = nil

local function pruneHud()
    pcall(function()
        if not UIManager or not UIManager.getUI then
            return
        end
        local ui = UIManager.getUI()
        if not ui or type(ui.size) ~= "function" then
            return
        end
        for index = ui:size() - 1, 0, -1 do
            local el = ui:get(index)
            if el and el.Type == "KnoxHudButton" and type(el.removeFromUIManager) == "function" then
                el:removeFromUIManager()
            end
        end
    end)
    hud = nil
end

local function ensureHud()
    if hud then
        return
    end

    pruneHud()

    local ok, err = pcall(function()
        hud = KnoxHudButton:new(0, 0, 56, 32)
        hud:initialise()
        hud:addToUIManager()
        hud:setAlwaysOnTop(true)
    end)

    if not ok then
        print(LOG .. "Desk HUD could not start: " .. tostring(err))
        hud = nil
    end
end

Events.OnCreatePlayer.Add(function()
    ensureHud()
end)

Events.OnGameStart.Add(function()
    ensureHud()
end)

do
    local version = "?"
    if type(KR_Bridge) == "table" and KR_Bridge.VERSION then
        version = tostring(KR_Bridge.VERSION)
    elseif KR_Desk and KR_Desk.version then
        version = KR_Desk.version()
    end
    print(LOG .. "Desk HUD loaded v" .. version)
end
