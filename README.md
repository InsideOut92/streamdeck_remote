# streamdeck_remote

## Ziel
HTML/Node App fuer Touch-Displays, um Apps und Workflows aehnlich einem Stream Deck zu starten.

## Start
```bash
npm start
```

Dann im Browser oeffnen:
`http://<dein-host>:8787/StreamDeck.html`

## Token
Der Server erwartet einen Header `X-Token`.
Die UI speichert den Token lokal im Browser (Dialog `Einstellungen`).

## Neu in dieser Version
- Dynamische Launcher-Konfiguration im Server (`launchers`), inklusive Auto-Erkennung.
- Profile mit Unterseiten (`pages`) und serverseitig verwaltete Tiles.
- Settings-API fuer Launcher, WoW-Ordner und WoW-Prozessname.
- Datei-/Ordner-Auswahl direkt aus der App (`/api/settings/browse`).
- Auto-Programmicons (Icon-Extraktion aus EXE/LNK) oder eigene Icons.
- Custom Tiles werden serverseitig gespeichert (`/api/tiles/upsert`).

## Build fuer Windows (EXE)
```bash
npm run build:win
```
Ergebnis:
`dist/streamdeck_remote.exe`

Hinweis: Der Build nutzt `pkg` via `npx`.

## Konfigurationsdatei
- Beim lokalen Entwicklungsbetrieb: `./config.json` im Projekt.
- Im gepackten EXE-Betrieb: `%APPDATA%/StreamDeckRemote/config.json`.

Damit koennen Nutzer eigene Pfade ohne Quellcode-Anpassung setzen.
