local ESX = exports['es_extended']:getSharedObject()
local lastAlarmId = 0
local polling = false

local function isAllowedJob(xPlayer)
    if not xPlayer or not xPlayer.job then return false end
    return Config.AllowedJobs[xPlayer.job.name] == true
end

local function formatAlarm(alarm)
    if alarm.voralarm then
        return 'VORALARM. VORALARM.'
    end

    local lines = { 'EINSATZ' }
    if alarm.stichwort and alarm.stichwort ~= '' then
        lines[#lines + 1] = 'Stichwort: ' .. alarm.stichwort
    end
    if alarm.plz and alarm.plz ~= '' then
        lines[#lines + 1] = 'PLZ: ' .. alarm.plz
    end
    if alarm.adresse and alarm.adresse ~= '' then
        lines[#lines + 1] = 'Adresse: ' .. alarm.adresse
    end
    if alarm.meldebild and alarm.meldebild ~= '' then
        lines[#lines + 1] = 'Meldebild: ' .. alarm.meldebild
    end
    if alarm.fahrzeuge and alarm.fahrzeuge ~= '' then
        lines[#lines + 1] = 'Fahrzeuge: ' .. alarm.fahrzeuge
    end
    return table.concat(lines, '\n')
end

local function deliverAlarm(alarm)
    local message = formatAlarm(alarm)
    for _, playerId in ipairs(GetPlayers()) do
        local xPlayer = ESX.GetPlayerFromId(tonumber(playerId))
        if isAllowedJob(xPlayer) then
            TriggerClientEvent('esx:showNotification', tonumber(playerId), message, 'error', Config.NotificationDuration)
            if Config.ShowChatMessage then
                TriggerClientEvent('chat:addMessage', tonumber(playerId), {
                    color = { 255, 170, 40 },
                    multiline = true,
                    args = { 'FREIBURG V2 | LEITSTELLE', message }
                })
            end
        end
    end
    print(('[Freiburg V2] Einsatz #%s an berechtigte ESX-Jobs verteilt.'):format(tostring(alarm.id)))
end

local function pollAlarms()
    if polling then return end
    polling = true
    local url = Config.ApiUrl:gsub('/+$', '') .. '/api/fivem/alarms?since=' .. tostring(lastAlarmId)
    PerformHttpRequest(url, function(status, body)
        polling = false
        if status ~= 200 or not body then
            print(('[Freiburg V2] API-Abfrage fehlgeschlagen (HTTP %s).'):format(tostring(status)))
            return
        end

        local ok, data = pcall(json.decode, body)
        if not ok or type(data) ~= 'table' or type(data.alarms) ~= 'table' then
            print('[Freiburg V2] Ungültige Antwort von der Bedarfsmelder-API.')
            return
        end

        for _, alarm in ipairs(data.alarms) do
            if type(alarm.id) == 'number' and alarm.id > lastAlarmId then
                deliverAlarm(alarm)
                lastAlarmId = alarm.id
            end
        end
        if type(data.latestId) == 'number' and data.latestId > lastAlarmId then
            lastAlarmId = data.latestId
        end
    end, 'GET', '', {
        ['Authorization'] = 'Bearer ' .. Config.ApiSecret,
        ['Accept'] = 'application/json'
    })
end

CreateThread(function()
    Wait(5000)
    if not Config.ApiSecret or Config.ApiSecret == '' or Config.ApiSecret == 'HIER_DENSELBEN_GEHEIMSCHLUESSEL_EINTRAGEN' then
        print('^1[Freiburg V2] Bitte Config.ApiSecret setzen!^0')
        return
    end
    print('^2[Freiburg V2] ESX-Bedarfsmelder-Verbindung gestartet.^0')
    while true do
        pollAlarms()
        Wait(Config.PollInterval or 3000)
    end
end)
