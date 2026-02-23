# StreamDeck Remote

Touch-freundlicher Launcher (Web UI + Node.js Server) fuer Windows-Setups.
Das Projekt kombiniert Profile, Unterseiten und serverseitig persistente Tiles, um Programme, Ordner, URLs, Protokolle und Spezialaktionen schnell zu starten.

## Was das Programm kann
- Profile mit Unterseiten (z. B. `work/main`, `work/dev`, `wow/addons`).
- Tiles fuer:
  - `app` (EXE/LNK/BAT/CMD/COM)
  - `folder`
  - `url` (http/https)
  - `protocol` (z. B. `discord://`)
  - `action` (vordefinierte Server-Aktionen)
- Custom-Tiles anlegen, bearbeiten, loeschen.
- Favoriten, zuletzt genutzt, lokale Ausblendung von Tiles.
- Programmsuche + automatische Aufloesung von Programmnamen.
- Launcher-Autodetect (abschaltbar per Env).
- Dateibasierte Logs inkl. Rotation + API zum Abrufen der letzten Zeilen.
- Sicherheitsbasis: Token-Auth (`X-Token`), Request-ID, Rate-Limit, Security-Header.

## Architektur in einem Satz
- `server.js`: API + Launch-Logik + Config/Logging.
- `public/StreamDeck.html`: komplette UI (HTML/CSS/JS).
- `config.json`: Laufzeitkonfiguration (lokal erzeugt, nicht versioniert).

## Voraussetzungen
- Node.js 18+ (empfohlen: 20 LTS)
- Windows fuer volle Launcher-/Dialog-Funktionen
- npm

## Schnellstart (Dev)
1. Repo klonen:
```bash
git clone https://github.com/InsideOut92/streamdeck_remote.git
cd streamdeck_remote
```
2. Abhaengigkeiten installieren:
```bash
npm ci
```
3. Optional Beispielconfig kopieren:
```powershell
Copy-Item config.example.json config.json
```
Hinweis: Wenn `token` in `config.json` ungueltig ist (z. B. `CHANGE_ME`), erzeugt der Server beim Start automatisch einen sicheren Token und schreibt ihn zurueck.

4. Server starten:
```bash
npm start
```
5. UI oeffnen:
`http://127.0.0.1:8787/StreamDeck.html`

6. Token setzen:
- In der UI auf `Einstellungen`
- Token aus `config.json` eintragen und speichern

## Von Clone zur EXE (Windows)
1. Projekt klonen und `npm ci` ausfuehren (siehe oben).
2. Build starten:
```bash
npm run build:win
```
3. Ergebnis:
`dist/streamdeck_remote.exe`
4. EXE starten.
5. Konfigurationsdatei liegt im EXE-Betrieb unter:
`%APPDATA%/StreamDeckRemote/config.json`
6. UI im Browser aufrufen:
`http://127.0.0.1:8787/StreamDeck.html`

## Wichtige npm-Skripte
- `npm start`: Server starten
- `npm run dev`: Alias fuer `start`
- `npm test`: API-Integrationstest
- `npm run build:win`: Windows-EXE bauen

## Konfiguration
### Wo liegt die Config?
- Dev (wenn vorhanden): `./config.json`
- EXE: `%APPDATA%/StreamDeckRemote/config.json`

### Relevante Felder
- `host`, `port`
- `token`
- `workspaceDir`
- `rateLimit.windowMs`, `rateLimit.max`
- `wow.processName`, `wow.folders.*`
- `logging.enabled`, `logging.dir`, `logging.maxFiles`, `logging.level` (`ERROR|WARN|INFO|DEBUG`)
- `launchers.*` (serverseitige App-Pfade)

### Umgebungvariablen
- `STREAMDECK_CONFIG_PATH`:
  - expliziter Pfad zur Config-Datei
- `STREAMDECK_DRY_RUN=1`:
  - startet im sicheren Testmodus (externe Prozesse werden nicht wirklich gestartet)
- `STREAMDECK_DISABLE_AUTODETECT=1`:
  - deaktiviert Launcher-Autodetect
- `STREAMDECK_LOG_LEVEL=ERROR|WARN|INFO|DEBUG`:
  - optionales Laufzeit-Override fuer das aktive Log-Level (ueberschreibt `logging.level`)

## API (Kurzuebersicht)
- `GET /api/health`
- `GET /api/status`
- `GET /api/bootstrap`
- `GET /api/settings`
- `POST /api/settings/*` (launcher, wow, logging, autodetect, browse)
- `GET /api/programs`
- `POST /api/programs/resolve`
- `GET /api/logs/recent`
- `GET /api/tiles/:id`
- `POST /api/tiles/upsert`
- `POST /api/tiles/delete`
- `POST /api/run`

Alle API-Calls (ausser statische Dateien) erwarten Token via Header:
`X-Token: <dein-token>`

## Logs und Debugging
- Dev-Logs: `./logs/server-YYYY-MM-DD.log`
- EXE-Logs: `%APPDATA%/StreamDeckRemote/logs/server-YYYY-MM-DD.log`
- Nur Fehler loggen:
  - `config.json` -> `"logging": { "level": "ERROR" }`
  - oder beim Start: `set STREAMDECK_LOG_LEVEL=ERROR`
- Request-Korrelation:
  - Jede API-Response enthaelt `X-Request-Id`
- Live-Log-Auszug:
  - `GET /api/logs/recent?lines=200`

## Troubleshooting
- `401 unauthorized`:
  - Token fehlt/falsch. In Einstellungen neu setzen.
- `404` auf neuen Endpunkten (z. B. `/api/tiles/:id`):
  - alter Serverprozess laeuft noch. Server komplett neu starten, dann Browser hart neu laden (`Ctrl+F5`).
- `Browse` nicht verfuegbar:
  - kein interaktiver Desktop/keine Berechtigung. Pfad manuell eintragen.
- Tile startet nicht:
  - Pfad pruefen, ggf. in `Einstellungen -> Launcher` korrigieren.
- Programmname wird nicht aufgeloest:
  - exakten Dateipfad verwenden oder Programmsuche in der UI nutzen.

## Dokumentation
- API-Referenz:
  - `docs/API_REFERENCE.md`
- Lernpfad (Schritt-fuer-Schritt zum Nachbauen):
  - `docs/LEHRPLAN_MANUELL_NACHSCHREIBEN.md`
- Diese Doku ist bewusst in kleinen, aufeinander aufbauenden Schritten gehalten, damit Schueler das Projekt ohne KI nachbauen koennen.
