# Freiburg V2 – ESX-Bedarfsmelder

## Installation

1. Kopiere den Ordner `fivem-esx` in deinen FiveM-Ordner `resources/[local]/`.
2. Benenne ihn bei Bedarf in `freiburg_bedarfsmelder` um.
3. Öffne `config.lua` und trage bei `Config.ApiSecret` denselben geheimen Schlüssel ein, den du in Railway als Variable `FIVEM_API_SECRET` hinterlegst.
4. Ergänze in deiner `server.cfg`:
   `ensure freiburg_bedarfsmelder`
5. Stelle sicher, dass ESX Legacy gestartet ist, bevor die Resource startet.

## Railway

Im Railway-Projekt des Bedarfsmelders unter Variables die Variable `FIVEM_API_SECRET` mit einem langen, zufälligen Geheimnis anlegen. Verwende exakt denselben Wert in der lokalen FiveM-Datei `config.lua`. Den Schlüssel niemals in ein öffentliches GitHub-Repository hochladen.

## Jobs

Standardmäßig werden nur Spieler mit diesen ESX-Jobnamen benachrichtigt:
- `ambulance`
- `fire`
- `feuerwehr`
- `rettungsdienst`

Passe `Config.AllowedJobs` an deine tatsächlichen Jobnamen an.

## Verhalten

- Discord `/alarm` übermittelt den Einsatz an Feuerwehr und Rettungsdienst in FiveM.
- Discord `/voralarm` zeigt ausschließlich „VORALARM. VORALARM.“ an.
- Die Resource fragt Railway alle 3 Sekunden nach neuen Meldungen.
- API-Abfrage erfolgt serverseitig mit Bearer-Schlüssel; der Schlüssel wird nicht an Clients übertragen.
