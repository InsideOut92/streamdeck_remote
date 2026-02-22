# API Reference

Base URL (default): `http://127.0.0.1:8787`

All API routes require:
- Header: `X-Token: <token>`
- Content-Type JSON for POST routes

## Common Response Fields
- `ok`: boolean
- `error`: string (on failure)
- `X-Request-Id` response header for log correlation

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
    "programResolve": true,
    "tileDetails": true,
    "dryRun": false,
    "launcherAutodetect": true
  }
}
```

## GET /api/status
Current WoW process status.

## GET /api/actions
List of supported legacy action names.

## GET /api/bootstrap
Primary UI payload.
Returns profiles, client-visible tiles, wow status, version/build/features.

## GET /api/settings
Returns editable server settings for UI.
Includes launchers, wow settings, logging settings.

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
{ "enabled": true, "dir": "", "maxFiles": 14 }
```

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
