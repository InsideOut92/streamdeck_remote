# Release Checklist

Diese Checkliste ist fuer den finalen Freigabe-Lauf gedacht.

## 1. Code & Tests
1. `npm ci`
2. `npm test`
3. Optional: manueller UI-Smoketest (Tile anlegen/bearbeiten/starten/loeschen)

## 2. Build & EXE-Validierung
1. `npm run build:win`
2. `npm run smoke:exe`
3. Pruefen, ob `dist/streamdeck_remote.exe` aktuell ist (Zeitstempel/Hash)

## 3. Security & Config
1. `config.example.json` enthaelt keine sensiblen lokalen Pfade
2. Token ist nicht im Repository committed
3. Logging-Level fuer Release-Default sinnvoll (`INFO` oder `ERROR` je nach Bedarf)

## 4. Dokumentation
1. README-Befehle stimmen mit `package.json` ueberein
2. API-Doku (`docs/API_REFERENCE.md`) deckt neue Endpunkte/Felder ab
3. Changelog/Release Notes (falls verwendet) aktualisieren

## 5. GitHub
1. CI laeuft auf dem Ziel-Commit grün
2. Branch ist sauber (`git status`)
3. Tag/Release erst erstellen, wenn alle Punkte oben erledigt sind
