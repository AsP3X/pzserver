return function(mapUI)
local mapAPI = mapUI.javaObject:getAPIv3()
local symbolsAPI = mapAPI:getSymbolsAPIv2()
local symbol
symbol = symbolsAPI:addUntranslatedText("MapLabel_SaltRiver", "text-water-nofade", 12511, 6734)
symbol:setScale(0.666)
symbol = symbolsAPI:addUntranslatedText("MapLabel_Muldraugh", "text-town", 10600, 9800)
symbol:setScale(2.0)
end
