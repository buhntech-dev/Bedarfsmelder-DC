Config = {}

-- Railway-API des Freiburg-V2-Bedarfsmelders
Config.ApiUrl = 'https://bedarfsmelder-dc-production.up.railway.app'
-- Muss mit FIVEM_API_SECRET in Railway übereinstimmen.
Config.ApiSecret = 'HIER_DENSELBEN_GEHEIMSCHLUESSEL_EINTRAGEN'

-- Nur Spieler mit einem dieser ESX-Jobs erhalten Einsatzmeldungen.
Config.AllowedJobs = {
    ambulance = true,
    fire = true,
    feuerwehr = true,
    rettungsdienst = true
}

Config.PollInterval = 3000
Config.NotificationDuration = 12000
Config.ShowChatMessage = true
