# Bedarfsmelder DC

Discord-Bedarfsmelder mit vollständigem Alarmton, deutscher Sprachdurchsage, Slash-Befehl `/alarm` und geschütztem Leitstellen-Webhook.

## Railway-Variablen
`DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `VOICE_CHANNEL_ID`, `ALARM_WEBHOOK_SECRET`. Optional: `ALARM_AUDIO_URL` (direkte MP3-URL). Ohne URL spielt der Bot `assets/alarm.mp3` ab.

## Alarmdatei
Die vollständige MP3-Datei muss unter `assets/alarm.mp3` liegen oder als direkte MP3-URL über `ALARM_AUDIO_URL` erreichbar sein.

## Webhook
POST an `/api/alarm`, Header `Authorization: Bearer DEIN_SCHLUESSEL`, JSON-Beispiel:
```json
{"stichwort":"B2 Gebäudebrand","plz":"79098","adresse":"Musterstraße 1, Freiburg","meldebild":"Rauch aus Dachgeschoss","fahrzeuge":["ELW 1","HLF 20","DLK 23"]}
```

Bot-Berechtigungen: View Channels, Connect, Speak. Scopes: `bot` und `applications.commands`.
