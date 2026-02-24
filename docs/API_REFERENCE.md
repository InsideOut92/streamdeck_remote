# API Reference

Base URL (default): `http://127.0.0.1:8787`

All API routes require:
- Header: `X-Token: <token>`
- Content-Type JSON for POST routes

## Common Response Fields
- `ok`: boolean
- `error`: string (on failure)
- `X-Request-Id` response header for log correlation
- Rate-limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, optional `Retry-After`

## GET /api/health
Health + feature flags.

Example response:

```json
{
  "ok": true,
  "uptime": 12.34,
  "ts": 1760000000000,
  "version": "1.1.0",
  "build": "2026-02-22T12:00:00.000Z",
  "features": {
    "logsRecent": true,
    "settingsLogging": true,
    "settingsImportExport": true,
    "systemMetrics": true,
    "wowAddonsManager": true,
    "wowNavigator": true,
    "questAssistant": true,
    "questAssistantLive": false,
    "curseforgeControl": true,
    "audioMixer": true,
    "programResolve": true,
    "tileDetails": true,
    "diagnostics": true,
    "runHistory": true,
    "tileRecommendations": true,
    "liveStream": true,
    "dryRun": false,
    "launcherAutodetect": true
  }
}
```

## GET /api/status
Current WoW process status.

## GET /api/audio/mixer
Returns current audio mixer snapshot.

Response contains:
- `available`: whether mixer controls are available on current host
- `platform`: host platform
- `sessions[]`: list of active audio sessions
  - `pid`, `sessionKey`, `processName`, `displayName`, `state`
  - `volumePercent`, `muted`, `hasWindow`
- `spotify`: nullable compact Spotify session object (when detected)
  - includes `pid` and `sessionKey`

## POST /api/audio/session/volume
Set session volume by process id or session key.

Request:

```json
{ "pid": 1234, "volumePercent": 65 }
```

Alternative for browser/virtual sessions without stable PID:

```json
{ "sessionKey": "inst::<...>", "volumePercent": 65 }
```

## POST /api/audio/session/mute
Set session mute state by process id or session key.

Request:

```json
{ "pid": 1234, "muted": true }
```

Alternative:

```json
{ "sessionKey": "inst::<...>", "muted": true }
```

## POST /api/audio/session/playpause
Send Play/Pause to target process (falls back to global media key).

Request:

```json
{ "pid": 1234 }
```

## POST /api/audio/spotify/open
Open Spotify via protocol handler (`spotify:`).

## GET /api/wow/navigator/status
Returns WoW navigator status and AddOn capabilities.

Response contains:
- `wowRunning`, `processName`
- `addonsAvailable`, `addonsBaseDir`, `addonsCount`
- `isTomTomInstalled`, `isQuestieInstalled`, `isStreamDeckNavigatorInstalled`
- `aiLive` (whether live OpenAI integration is active)

## POST /api/wow/assistant
Quest helper endpoint (cheat-free recommendations + waypoint commands).

Request:

```json
{
  "question": "Ich bin level 24 in Redridge, wo finde ich Orcs?",
  "context": {
    "characterName": "Arthas",
    "className": "Paladin",
    "faction": "Alliance",
    "level": 24,
    "zone": "Redridge Mountains",
    "expansion": "Classic",
    "objective": "Wanted: Lieutenant Fangore"
  }
}
```

Response contains:
- `provider` (`openai` or `local-fallback`)
- `answer`, `safety`
- `nextSteps[]` with `title`, `details`
- `waypoints[]` with:
  - `zone`, `x`, `y`, `note`
  - `tomtomCommand`
  - `streamDeckNavigatorCommand` (for `/sdnav`)

## GET /api/curseforge/status
Returns CurseForge launcher + process state.

Response contains:
- `configuredPath`: configured launcher path from settings
- `executablePath`: resolved existing `CurseForge.exe` path (if found)
- `installed`: whether an executable path is available
- `running`: whether CurseForge process is currently running
- `processName`: matched process image name (`CurseForge.exe` or empty)

## POST /api/curseforge/start
Start CurseForge via resolved executable path.

## POST /api/curseforge/stop
Stop CurseForge process (`taskkill` on Windows).

## POST /api/curseforge/restart
Stop + start CurseForge.

## GET /api/system/metrics
Live system metrics for performance overlay.

Response contains:
- `cpu.usagePercent`, `cpu.cores`
- `memory.totalBytes`, `memory.usedBytes`, `memory.freeBytes`, `memory.usagePercent`
- `network.rxBytesPerSec`, `network.txBytesPerSec`, `network.rxTotalBytes`, `network.txTotalBytes`
- `system.hostname`, `system.platform`, `system.release`, `system.arch`, `system.uptimeSec`
- `process.pid`, `process.uptimeSec`, `process.rssBytes`, `process.heapUsedBytes`

## GET /api/wow/addons
List WoW AddOns from configured `wow.folders.addons`.

Response contains:
- `baseDir`: resolved AddOns directory
- `items[]`: `{ key, folder, name, title, enabled }`

## POST /api/wow/addons/toggle
Enable/disable one AddOn by renaming folder (`.disabled` suffix).

Request:

```json
{ "key": "Questie", "enabled": false }
```

## POST /api/wow/addons/open-folder
Open configured AddOns directory in Explorer.

## GET /api/actions
List of supported legacy action names.

## GET /api/bootstrap
Primary UI payload.
Returns profiles, client-visible tiles, wow status, version/build/features.

## GET /api/settings
Returns editable server settings for UI.
Includes launchers, wow settings, logging settings and AI status.

AI section (`ai`) contains:
- `provider` (`openai`)
- `model`
- `hasApiKey` (boolean)
- `source` (`none|config|env`)
- `keyManagedByEnv` (boolean)

No raw API key is returned by this endpoint.

## GET /api/settings/ai
Returns only AI assistant settings/status.

Response:

```json
{
  "ok": true,
  "ai": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "hasApiKey": true,
    "source": "config",
    "keyManagedByEnv": false
  },
  "ts": 1760000000000
}
```

## POST /api/settings/ai
Update AI assistant settings.

Request:

```json
{
  "model": "gpt-4o-mini",
  "openAiApiKey": "sk-...",
  "verify": true
}
```

Notes:
- `openAiApiKey` is optional. If omitted, only model is updated.
- Set `openAiApiKey` to empty string to remove stored key.
- If `verify` is not `false`, a provided non-empty key is verified against OpenAI before save.
- If key is supplied by environment variable, this route returns `409`.
- Raw key is never returned in response.

## POST /api/settings/launcher
Set launcher path.

Request:

```json
{ "id": "vscode", "path": "C:\\Tools\\Code.exe" }
```

## POST /api/settings/wow-folder
Set one WoW folder.

Request:

```json
{ "key": "addons", "path": "C:\\...\\AddOns" }
```

## POST /api/settings/wow-process
Set WoW process image name.

Request:

```json
{ "processName": "WowClassic.exe" }
```

## POST /api/settings/logging
Update file logging settings.

Request:

```json
{ "enabled": true, "dir": "", "maxFiles": 14, "level": "INFO" }
```

`level` supports: `ERROR`, `WARN`, `INFO`, `DEBUG`.

## GET /api/settings/export
Export current full config as JSON payload.

Response:

```json
{
  "ok": true,
  "exportedAt": "2026-02-23T00:00:00.000Z",
  "config": { "...": "full config object" }
}
```

## POST /api/settings/import
Import full config object.

Request:

```json
{
  "keepCurrentToken": true,
  "config": { "...": "full config object" }
}
```

`keepCurrentToken` defaults to `true`.

## POST /api/settings/autodetect
Autodetect launcher paths.

Request:

```json
{ "launcherId": "vscode" }
```

`launcherId` is optional. If omitted, all launchers are checked.

## POST /api/settings/browse
Opens file/folder picker (if interactive session available).

Request:

```json
{ "kind": "file", "title": "Programm waehlen" }
```

Possible non-fatal response when picker unavailable:

```json
{ "ok": true, "path": "", "unavailable": true, "reason": "..." }
```

## GET /api/programs
Program search index query.

Query params:
- `q`: search text
- `limit`: 1..50

## POST /api/programs/resolve
Resolve app input to executable path.

Request:

```json
{ "input": "notepad" }
```

## GET /api/logs/recent
Return latest log lines.

Query params:
- `lines`: 10..2000

## GET /api/diagnostics
Runtime diagnostics snapshot for observability.

Query params:
- `routeLimit`: 1..40 (default 10)
- `recentRuns`: 1..120 (default 20)

Response includes:
- `process`: runtime + memory stats
- `requests`: counters, top routes, recent 5xx errors
- `runs`: aggregated run analytics
- `caches`: cache sizes and ages
- `liveStreams.activeClients`: number of connected SSE clients

## GET /api/run/history
Execution analytics for tile/action runs.

Query params:
- `limit`: 1..200 (default 40)

Response includes:
- `totals`: total/success/failed/successRate
- `topTiles[]`, `topActions[]`
- `recent[]`: latest run events

## GET /api/tiles/recommendations
Usage-based tile recommendations.

Query params:
- `profile`: optional profile filter
- `page`: optional page filter
- `limit`: 1..50 (default 10)

Response includes:
- `items[]` with `score`, `count`, `hourHits`, `lastRunAt`, `reason`

## GET /api/stream/live
Server-Sent Events stream for live dashboards.

Query params:
- `channels`: comma-separated values from `status,metrics,audio,wow,curseforge,runs` or `all`
- `intervalMs`: 500..15000 (default 1500)

Events:
- `hello`
- `snapshot`
- `error`
- `end`

## POST /api/icon
Extract icon from app file.

Request:

```json
{ "path": "C:\\Tools\\app.exe" }
```

## GET /api/tiles/:id
Get full tile details (used for edit flow).

## POST /api/tiles/upsert
Create or update custom tile.

Request:

```json
{
  "tile": {
    "id": "c_optional_existing_id",
    "profile": "work",
    "page": "main",
    "label": "My App",
    "subtitle": "Custom",
    "type": "app",
    "target": "C:\\Tools\\app.exe",
    "args": ["--flag"],
    "startIn": "C:\\Tools",
    "iconMode": "auto"
  }
}
```

Notes:
- Built-in tiles cannot be overwritten.
- `id` omitted => new custom tile id generated.

## POST /api/tiles/delete
Delete custom tile.

Request:

```json
{ "id": "c_tile_id" }
```

Built-in tiles cannot be deleted.

## POST /api/run
Run by tile id or legacy action.

Request examples:

```json
{ "tileId": "terminal" }
```

```json
{ "action": "browser", "url": "https://example.com" }
```

## Error Semantics
- `400`: invalid input
- `401`: missing/invalid token
- `404`: resource missing
- `429`: rate limited
- `500`: runtime error
