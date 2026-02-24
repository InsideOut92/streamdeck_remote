local PREFIX = "|cff22d3ee[SDNav]|r"

local function msg(text)
  DEFAULT_CHAT_FRAME:AddMessage(PREFIX .. " " .. tostring(text or ""))
end

local function parseCoord(value)
  if not value then return nil end
  local normalized = tostring(value):gsub(",", ".")
  local num = tonumber(normalized)
  if not num then return nil end
  if num < 0 or num > 100 then return nil end
  return num
end

local function clearWaypoint()
  if C_Map and C_Map.ClearUserWaypoint then
    C_Map.ClearUserWaypoint()
  end
  if C_SuperTrack and C_SuperTrack.SetSuperTrackedUserWaypoint then
    C_SuperTrack.SetSuperTrackedUserWaypoint(false)
  end
  msg("User waypoint wurde entfernt.")
end

local function setWaypointOnCurrentMap(xPercent, yPercent, label)
  if not C_Map or not C_Map.GetBestMapForUnit or not C_Map.SetUserWaypoint then
    msg("Map API nicht verfuegbar.")
    return
  end

  local mapID = C_Map.GetBestMapForUnit("player")
  if not mapID then
    msg("Konnte aktuelle Map nicht bestimmen.")
    return
  end

  if not UiMapPoint or not UiMapPoint.CreateFromCoordinates then
    msg("UiMapPoint API fehlt.")
    return
  end

  local point = UiMapPoint.CreateFromCoordinates(mapID, xPercent / 100, yPercent / 100)
  if not point then
    msg("Waypoint konnte nicht erstellt werden.")
    return
  end

  C_Map.SetUserWaypoint(point)
  if C_SuperTrack and C_SuperTrack.SetSuperTrackedUserWaypoint then
    C_SuperTrack.SetSuperTrackedUserWaypoint(true)
  end

  if label and label ~= "" then
    msg(string.format("Waypoint gesetzt: %.1f / %.1f (%s)", xPercent, yPercent, label))
  else
    msg(string.format("Waypoint gesetzt: %.1f / %.1f", xPercent, yPercent))
  end
end

SLASH_STREAMDECKNAV1 = "/sdnav"
SlashCmdList.STREAMDECKNAV = function(message)
  local text = tostring(message or ""):match("^%s*(.-)%s*$")
  if text == "" or text == "help" then
    msg("Nutzung: /sdnav <x> <y> [label]")
    msg("Beispiel: /sdnav 45.6 32.1 Questziel")
    msg("Entfernen: /sdnav clear")
    return
  end

  if text == "clear" then
    clearWaypoint()
    return
  end

  local xRaw, yRaw, label = text:match("^(%S+)%s+(%S+)%s*(.-)%s*$")
  if not xRaw or not yRaw then
    msg("Ungueltig. Nutze: /sdnav <x> <y> [label]")
    return
  end

  local x = parseCoord(xRaw)
  local y = parseCoord(yRaw)
  if not x or not y then
    msg("Koordinaten muessen zwischen 0 und 100 liegen.")
    return
  end

  setWaypointOnCurrentMap(x, y, label)
end
