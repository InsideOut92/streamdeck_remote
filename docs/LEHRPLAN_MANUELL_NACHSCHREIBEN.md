# Lehrplan: StreamDeck Remote Manuell Nachschreiben

Diese Anleitung ist fuer Schueler gedacht.
Ziel: Das Projekt **ohne KI** in kleinen Schritten selbst aufbauen, verstehen und erweitern.

Wichtig:
- Jeder Schritt ist bewusst klein.
- Erst wenn ein Schritt laeuft, kommt der naechste.
- Nach jedem Schritt wird getestet.

---

## 0. Lernziele

Nach diesem Lehrplan kannst du:
- einen Node.js Server mit Express schreiben,
- eine einfache API sichern (Token + Rate Limit),
- eine Weboberflaeche fuer Tiles bauen,
- Programme/Ordner/URLs aus der UI starten,
- Konfiguration und Logs professionell verwalten,
- aus dem Projekt eine Windows-EXE bauen.

---

## 1. Projekt-Setup (kleinster Start)

### 1.1 Ordnerstruktur
Lege an:

```text
streamdeck_remote/
  package.json
  server.js
  public/
    StreamDeck.html
```

### 1.2 npm initialisieren

```bash
npm init -y
npm install express
```

### 1.3 Minimaler Server
`server.js`:

```js
const express = require("express");
const path = require("path");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.listen(8787, "127.0.0.1", () => {
  console.log("Server laeuft: http://127.0.0.1:8787/StreamDeck.html");
});
```

### 1.4 Minimale HTML-Datei
`public/StreamDeck.html`:

```html
<!doctype html>
<html>
  <body>
    <h1>StreamDeck Remote</h1>
    <p>Hello from HTML</p>
  </body>
</html>
```

### 1.5 Test

```bash
node server.js
```

Browser: `http://127.0.0.1:8787/StreamDeck.html`

Wenn das klappt: erst dann weiter.

---

## 2. Erste API bauen

### 2.1 JSON Body aktivieren

```js
app.use(express.json());
```

### 2.2 Health-Endpunkt

```js
app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});
```

### 2.3 Test mit Browser/Insomnia/curl
`GET /api/health` muss JSON liefern.

---

## 3. Token-Authentifizierung

Jetzt machst du aus "offen" ein kontrolliertes System.

### 3.1 Token speichern
Lege `config.json` an:

```json
{
  "token": "DEIN_LANGER_TOKEN",
  "host": "127.0.0.1",
  "port": 8787
}
```

### 3.2 Middleware `requireToken`

```js
function requireToken(req, res, next) {
  const token = req.header("x-token") || "";
  if (!token) return res.status(401).json({ ok: false, error: "missing token" });
  if (token !== config.token) return res.status(401).json({ ok: false, error: "token mismatch" });
  next();
}
```

### 3.3 API schuetzen

```js
app.get("/api/health", requireToken, (req, res) => {
  res.json({ ok: true });
});
```

### 3.4 Test
- ohne Token => 401
- mit Token => 200

---

## 4. Datenmodell fuer Tiles

Jetzt definierst du die Kernidee.

### 4.1 Tile-Typen
Empfohlen:
- `action`
- `app`
- `folder`
- `url`
- `protocol`

### 4.2 Beispiel-Tiles

```js
const tiles = [
  { id: "terminal", label: "Terminal", type: "action", action: "terminal" },
  { id: "workspace", label: "Projekt", type: "folder", target: "C:\\Projects" }
];
```

### 4.3 Bootstrap-Endpunkt

```js
app.get("/api/bootstrap", requireToken, (req, res) => {
  res.json({ ok: true, tiles });
});
```

---

## 5. Tile-Ausfuehrung (Backend)

### 5.1 Run-Endpunkt

```js
app.post("/api/run", requireToken, (req, res) => {
  const tileId = String(req.body?.tileId || "").trim();
  const tile = tiles.find((t) => t.id === tileId);
  if (!tile) return res.status(404).json({ ok: false, error: "tile not found" });

  // spaeter echte Ausfuehrung
  return res.json({ ok: true, tileId: tile.id });
});
```

### 5.2 Echte Ausfuehrung
Danach erst mit `child_process.spawn` starten:
- `action`: bekannte Befehle
- `app`: EXE
- `folder`: Explorer
- `url/protocol`: ueber `cmd /c start`

Sicherheitsregel:
- keine unvalidierten Shell-Strings in `exec` geben.
- lieber `spawn`/`execFile` mit separaten Argumenten.

---

## 6. Frontend: Tiles rendern

### 6.1 Daten laden

```js
const data = await fetch("/api/bootstrap", { headers: { "X-Token": token } }).then(r => r.json());
```

### 6.2 Buttons bauen
Fuer jedes Tile einen Button erstellen.

### 6.3 Klick auf Tile

```js
await fetch("/api/run", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Token": token },
  body: JSON.stringify({ tileId })
});
```

### 6.4 UX-Basics
- Ladeanzeige beim Klick
- Fehlermeldung als Toast
- Letzte Nutzung lokal speichern (`localStorage`)

---

## 7. Profile und Seiten

Jetzt wird das System skalierbar.

### 7.1 Struktur

```json
{
  "profiles": [
    { "id": "work", "label": "Work", "pages": [{ "id": "main", "label": "Main" }] },
    { "id": "wow", "label": "WoW", "pages": [{ "id": "main", "label": "Main" }] }
  ]
}
```

Jedes Tile bekommt:
- `profile`
- `page`

### 7.2 UI-Tabs
- Profil-Tabs rendern
- Seiten-Tabs je Profil rendern
- Tiles entsprechend filtern

---

## 8. Persistenz: config.json richtig machen

### 8.1 Warum wichtig?
Ohne Persistenz gehen Nutzerdaten verloren.

### 8.2 Gute Praxis
- JSON robust laden (`try/catch`)
- Defaults mergen
- atomisch speichern (temp file + rename)
- Backup-Datei schreiben (`config.json.bak`)

### 8.3 Pflicht-Endpunkte
- `POST /api/tiles/upsert`
- `POST /api/tiles/delete`
- `GET /api/tiles/:id` (fuer Edit-Dialog)

---

## 9. Sicherheit und Stabilitaet

### 9.1 Mindest-Sicherheitsmassnahmen
- `X-Token` Pflicht
- Rate Limit
- Security Header (CSP, X-Frame-Options, etc.)
- Eingabevalidierung (Laenge, Null-Byte, erlaubte Typen)

### 9.2 Stabilitaet
- zentrales Logging
- `X-Request-Id` in jeder API-Response
- globaler Error-Handler
- sauberes Shutdown bei SIGINT/SIGTERM

### 9.3 Testmodus
Fuehre `STREAMDECK_DRY_RUN=1` ein:
- API bleibt nutzbar
- externe Programme werden **nicht** wirklich gestartet
- ideal fuer Tests und CI

---

## 10. Programmsuche und Komfort

### 10.1 Programmsuche
- typische Windows-Verzeichnisse scannen
- Ergebnisse cachen
- Name -> Pfad aufloesen (`/api/programs/resolve`)

### 10.2 Komfortfunktionen
- automatische Icons aus EXE/LNK
- Datei-/Ordner-Browse
- Launcher-Autodetect
- editierbare Custom-Tiles

---

## 11. Tests (verpflichtend)

### 11.1 Was testen?
Mindestens:
- Auth (`401` ohne Token)
- `GET /api/health`
- `POST /api/tiles/upsert`
- `GET /api/tiles/:id`
- `POST /api/run` (im Dry-Run)
- `POST /api/tiles/delete`

### 11.2 Tooling
- Node Built-in Test Runner (`node:test`)
- Integrationstest startet echten Serverprozess mit Temp-Config

---

## 12. EXE Build

### 12.1 Warum?
User sollen das Tool ohne Node-Installation starten koennen.

### 12.2 Script

```bash
npm run build:win
```

Ergebnis:
- `dist/streamdeck_remote.exe`

### 12.3 Nach dem Build testen
- EXE starten
- Config in `%APPDATA%/StreamDeckRemote/config.json` pruefen
- Token setzen
- mindestens ein Tile erstellen und ausfuehren

---

## 13. Release-Checkliste

Vor einem Release immer:
1. `npm ci`
2. `npm test`
3. UI Smoke-Test (Add/Edit/Delete/Run)
4. Build-Test `npm run build:win`
5. README auf aktuelle Kommandos pruefen

---

## 14. Uebungen fuer Schueler

### Uebung A (einfach)
- Fuege einen neuen Action-Typ `calculator` hinzu.

### Uebung B (mittel)
- Implementiere "Tile klonen" im Kontextmenue.

### Uebung C (mittel)
- Fuege einen Export/Import-Button fuer Config hinzu.

### Uebung D (fortgeschritten)
- Schreibe einen Test, der einen fehlerhaften JSON-Body an die API sendet und `400` erwartet.

---

## 15. Didaktischer Hinweis

Wenn das Projekt zu gross wirkt:
- Schritt 1-6 reichen fuer eine lauffaehige Basis.
- Schritt 7-10 sind Erweiterungen.
- Schritt 11-13 machen das Projekt "professionell".

So bleibt der Einstieg leicht, und die Komplexitaet steigt kontrolliert.
