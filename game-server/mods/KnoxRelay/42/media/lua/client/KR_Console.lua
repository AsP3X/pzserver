--
-- KR_Console.lua — the /account chat command, client side.
--
-- The chat box is the only place a player can type at the server, so the
-- command has to be caught here and forwarded. This file does no deciding: it
-- notices the text, sends a command, and shows whatever comes back. The server
-- takes the username from its own player object, so a doctored client can only
-- ask on its own behalf.
--
-- The answer is deliberately not put into a chat channel. A six-character code
-- is worth an account to whoever reads it, and chat is echoed into the server
-- log. It goes on screen in front of the one player instead, twice over: a
-- halo note that is hard to miss and a line above the character that lingers.
--
-- Everything the UI touches is wrapped, because a chat hook that raises takes
-- the player's chat box down with it.
--

local LOG = "[KnoxRelay] "
local CHANNEL = "KnoxRelay"
local COMMAND = "/account"

print(LOG .. "Lua file loaded — /account command is active")

--------------------------------------------------------------------------
-- Showing the player something
--------------------------------------------------------------------------

local function haloNote(text, red, green, blue)
    local player = getSpecificPlayer(0)
    if not player then
        return
    end

    pcall(function()
        player:setHaloNote(text, red, green, blue, 400)
    end)
end

local function overhead(text, red, green, blue)
    local player = getSpecificPlayer(0)
    if not player then
        return
    end

    pcall(function()
        player:addLineChatElement(text, red / 255, green / 255, blue / 255)
    end)
end

--- Say something only this player can see, on screen and in the client log.
local function notify(text, red, green, blue)
    print(LOG .. text)
    haloNote(text, red, green, blue)
    overhead(text, red, green, blue)
end

--------------------------------------------------------------------------
-- The answer
--------------------------------------------------------------------------

local function showReply(args)
    local status = args and args.status or "error"

    if status == "issued" then
        notify("Registration code: " .. tostring(args.code), 255, 176, 0)

        if args.expires_at then
            overhead("Enter it on the website. Valid until " .. tostring(args.expires_at), 200, 200, 200)
        end

        overhead("Nobody else can see this. Do not paste it in chat.", 200, 200, 200)

        return
    end

    if status == "already_registered" then
        notify("This character already has an account — sign in instead.", 200, 200, 200)

        return
    end

    if status == "no_answer" then
        notify("The website did not answer. Try /account register again in a moment.", 255, 90, 90)

        return
    end

    notify("Registration failed. Try /account register again in a moment.", 255, 90, 90)
end

local function onServerCommand(module, command, args)
    if module ~= CHANNEL or command ~= "accountReply" then
        return
    end

    showReply(args)
end

--------------------------------------------------------------------------
-- The command
--------------------------------------------------------------------------

local function squeeze(text)
    if not text then
        return ""
    end

    return (string.gsub(string.gsub(text, "^%s+", ""), "%s+$", ""))
end

--- Handle the text, or return false to let the game have it.
local function consume(text)
    local trimmed = squeeze(text)
    local lowered = string.lower(trimmed)

    if lowered ~= COMMAND and string.sub(lowered, 1, #COMMAND + 1) ~= COMMAND .. " " then
        return false
    end

    local argument = squeeze(string.sub(trimmed, #COMMAND + 1))

    if string.lower(argument) == "register" then
        local player = getSpecificPlayer(0)
        if not player then
            return true
        end

        notify("Asking the website for a registration code...", 200, 200, 200)
        pcall(function()
            sendClientCommand(player, CHANNEL, "accountRegister", {})
        end)

        return true
    end

    -- A bare /account, or anything else after it, gets the usage rather than
    -- being passed through to the game as an unknown command.
    notify("Usage: /account register", 200, 200, 200)

    return true
end

--------------------------------------------------------------------------
-- Hooking the chat box
--------------------------------------------------------------------------

--- ISChat owns the text entry, so the command has to be taken off it before
--- the vanilla handler decides it is an unknown slash command. Hooked rather
--- than replaced: everything this file does not recognise falls straight
--- through to the original.
local function hookChat()
    if not ISChat or not ISChat.onCommandEntered then
        print(LOG .. "WARNING: ISChat unavailable — /account will not work")

        return false
    end

    local vanilla = ISChat.onCommandEntered

    ISChat.onCommandEntered = function(self)
        local instance = ISChat.instance
        local entry = instance and instance.textEntry
        local text = entry and entry:getInternalText() or ""

        local mine = false
        local checked = pcall(function()
            mine = consume(text)
        end)

        if not checked or not mine then
            return vanilla(self)
        end

        -- Ours. Clear the box the way the vanilla handler would have, so the
        -- player is not left staring at their own command.
        pcall(function()
            entry:clear()
            instance:unfocus()
            instance:logChatCommand(text)
        end)
    end

    return true
end

Events.OnServerCommand.Add(onServerCommand)

-- The chat UI is not built at file load, so the hook waits for the game to be
-- up. OnGameStart fires once the player and the HUD exist.
Events.OnGameStart.Add(function()
    if hookChat() then
        print(LOG .. "/account command registered on the chat box")
    end
end)
