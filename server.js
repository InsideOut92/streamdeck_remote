"use strict";

const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");

const APP_NAME = "StreamDeck Remote";
const PUBLIC_DIR = path.join(__dirname, "public");
const IS_PKG = Boolean(process.pkg);
const TILE_TYPES = new Set(["action", "app", "folder", "url", "protocol"]);
const ICON_MODES = new Set(["auto", "emoji", "image"]);
const TILE_SHOW_IF = new Set(["", "wowRunning", "wowNotRunning"]);
const NAMED_ACTIONS = new Set([
  "terminal",
  "powershell",
  "browser",
  "discord",
  "streamingSoundboard",
  "wowNavigator",
  "curseforge",
  "curseforgeManager",
  "performanceOverlay",
  "wowStart",
  "openWorkspace",
  "vscode",
  "wowClassic",
  "wowTBC",
  "openWowAddons",
  "openWowLogs",
  "openWowWtf"
]);
const MAX_PATH_LEN = 2048;
const MAX_ICON_DATA_URL_LEN = 2_000_000;
const APP_FILE_EXTENSIONS = new Set([".exe", ".lnk", ".bat", ".cmd", ".com"]);
const PROGRAM_INDEX_CACHE_MS = 120000;
const LOG_FILE_PREFIX = "server-";
const LOG_FILE_RE = /^server-\d{4}-\d{2}-\d{2}\.log$/;
const LOG_LEVELS = Object.freeze({
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
});
const APP_VERSION = readPackageVersion();
const APP_BUILD = detectBuildStamp();
const PROCESS_STATUS_CACHE_MS = 3000;
const NET_METRICS_CACHE_MS = 1000;
const CLIENT_TILES_CACHE_MS = 1200;
const API_METRICS_SAMPLE_LIMIT = 160;
const API_RECENT_ERRORS_LIMIT = 40;
const RUN_ANALYTICS_RECENT_LIMIT = 240;
const RUN_ANALYTICS_TOP_LIMIT = 16;
const RUN_ANALYTICS_ENTRY_LIMIT = 400;
const DRY_RUN = isTruthyEnv(process.env.STREAMDECK_DRY_RUN);
const DISABLE_AUTODETECT = isTruthyEnv(process.env.STREAMDECK_DISABLE_AUTODETECT);
const DEFAULT_AI_MODEL = "gpt-4o-mini";
const API_FEATURES_BASE = Object.freeze({
  logsRecent: true,
  settingsLogging: true,
  settingsImportExport: true,
  systemMetrics: true,
  wowAddonsManager: true,
  wowNavigator: true,
  questAssistant: true,
  curseforgeControl: true,
  audioMixer: true,
  programResolve: true,
  tileDetails: true,
  diagnostics: true,
  runHistory: true,
  tileRecommendations: true,
  liveStream: true,
  dryRun: DRY_RUN,
  launcherAutodetect: !DISABLE_AUTODETECT
});
const aiRuntimeState = {
  apiKey: "",
  model: DEFAULT_AI_MODEL,
  source: "none"
};
const clientTilesCache = {
  ts: 0,
  revision: 0,
  wowRunning: false,
  payload: null
};
let configRevision = 1;
const apiMetricsState = {
  startedAt: Date.now(),
  active: 0,
  total: 0,
  success: 0,
  clientError: 0,
  serverError: 0,
  rateLimited: 0,
  routes: new Map(),
  recentErrors: []
};
const runAnalyticsState = {
  total: 0,
  success: 0,
  failed: 0,
  byTile: new Map(),
  byAction: new Map(),
  recent: []
};
const liveStreamState = {
  clients: new Set(),
  nextId: 1
};

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function hasLogLevel(level) {
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, String(level || "").trim().toUpperCase());
}

function normalizeLogLevel(value, fallback = "INFO") {
  const raw = String(value || "").trim().toUpperCase();
  if (hasLogLevel(raw)) return raw;
  const safeFallback = String(fallback || "").trim().toUpperCase();
  if (hasLogLevel(safeFallback)) return safeFallback;
  return "INFO";
}

function printCliHelp() {
  process.stdout.write(
    [
      `${APP_NAME} v${APP_VERSION}`,
      "",
      "Usage:",
      "  node server.js [--help] [--version]",
      "",
      "Environment variables:",
      "  STREAMDECK_CONFIG_PATH   Optional absolute/relative path to config JSON",
      "  STREAMDECK_DRY_RUN=1     Skip external process starts and only log run requests",
      "  STREAMDECK_LOG_LEVEL     ERROR | WARN | INFO | DEBUG"
    ].join("\n") + "\n"
  );
}

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write(`${APP_VERSION}\n`);
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printCliHelp();
  process.exit(0);
}

function fileExists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function randomToken(length = 96) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += chars[bytes[i] % chars.length];
  return out;
}

function readPackageVersion() {
  try {
    const pkgPath = path.join(__dirname, "package.json");
    if (!fileExists(pkgPath)) return safeTrim(process.env.APP_VERSION || "dev", 40) || "dev";
    const raw = JSON.parse(fs.readFileSync(pkgPath, "utf8").replace(/^\uFEFF/, ""));
    return safeTrim(raw?.version || "", 40) || "dev";
  } catch {
    return safeTrim(process.env.APP_VERSION || "dev", 40) || "dev";
  }
}

function detectBuildStamp() {
  try {
    return fs.statSync(__filename).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function uniq(list) {
  const set = new Set();
  const out = [];
  for (const item of list || []) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (!value || set.has(value)) continue;
    set.add(value);
    out.push(value);
  }
  return out;
}

function safeTrim(value, maxLen = 256) {
  const raw = String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, "");
  return raw.length > maxLen ? raw.slice(0, maxLen) : raw;
}

function unquoteWrapped(value) {
  const text = String(value || "").trim();
  if (
    (text.startsWith("\"") && text.endsWith("\"")) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function hasAiAssistantKey() {
  return Boolean(aiRuntimeState.apiKey);
}

function getAiAssistantModel() {
  const model = safeTrim(aiRuntimeState.model || "", 80);
  return model || DEFAULT_AI_MODEL;
}

function resolveAiSettingsFromSources(cfg) {
  const envKey = safeTrim(process.env.STREAMDECK_AI_API_KEY || process.env.OPENAI_API_KEY || "", 256);
  const cfgKey = safeTrim(cfg?.ai?.openAiApiKey || "", 256);
  const cfgModel = safeTrim(cfg?.ai?.model || "", 80);
  const envModel = safeTrim(process.env.STREAMDECK_AI_MODEL || "", 80);
  const apiKey = envKey || cfgKey;
  const model = envModel || cfgModel || DEFAULT_AI_MODEL;
  const source = envKey ? "env" : (cfgKey ? "config" : "none");
  return { apiKey, model, source };
}

function refreshAiRuntimeState(cfg) {
  const resolved = resolveAiSettingsFromSources(cfg);
  aiRuntimeState.apiKey = resolved.apiKey;
  aiRuntimeState.model = resolved.model;
  aiRuntimeState.source = resolved.source;
}

function getApiFeatures() {
  return {
    ...API_FEATURES_BASE,
    questAssistantLive: hasAiAssistantKey()
  };
}

function getAiSettingsView() {
  const source = safeTrim(aiRuntimeState.source || "none", 24) || "none";
  return {
    provider: "openai",
    model: getAiAssistantModel(),
    hasApiKey: hasAiAssistantKey(),
    source,
    keyManagedByEnv: source === "env"
  };
}

function clearClientTilesCache() {
  clientTilesCache.ts = 0;
  clientTilesCache.revision = 0;
  clientTilesCache.wowRunning = false;
  clientTilesCache.payload = null;
}

function bumpConfigRevision() {
  configRevision += 1;
  clearClientTilesCache();
}

function pushBounded(list, item, maxItems) {
  if (!Array.isArray(list) || !Number.isFinite(maxItems) || maxItems <= 0) return;
  list.unshift(item);
  if (list.length > maxItems) list.length = maxItems;
}

function percentileFromSorted(sortedValues, percentile) {
  if (!Array.isArray(sortedValues) || !sortedValues.length) return 0;
  const p = Math.max(0, Math.min(100, Number(percentile) || 0));
  const rank = Math.ceil((p / 100) * sortedValues.length) - 1;
  const idx = Math.max(0, Math.min(sortedValues.length - 1, rank));
  return sortedValues[idx];
}

function summarizeSamples(samples) {
  if (!Array.isArray(samples) || !samples.length) {
    return { avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  }
  const sorted = samples
    .map((x) => Number(x) || 0)
    .filter((x) => Number.isFinite(x) && x >= 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return { avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  const avgMs = sorted.reduce((acc, value) => acc + value, 0) / sorted.length;
  return {
    avgMs: Math.round(avgMs * 10) / 10,
    p50Ms: Math.round(percentileFromSorted(sorted, 50) * 10) / 10,
    p95Ms: Math.round(percentileFromSorted(sorted, 95) * 10) / 10,
    p99Ms: Math.round(percentileFromSorted(sorted, 99) * 10) / 10
  };
}

function makeRequestId() {
  return crypto.randomBytes(6).toString("hex");
}

function sanitizeUrlForLog(rawUrl) {
  const value = String(rawUrl || "");
  const [pathname, query = ""] = value.split("?");
  if (!query) return pathname;
  const safeDecode = (x) => {
    try {
      return decodeURIComponent(x || "");
    } catch {
      return String(x || "");
    }
  };
  const pairs = query
    .split("&")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [rawKey, rawVal = ""] = part.split("=");
      const key = safeDecode(rawKey);
      if (/token|x-token/i.test(key)) return `${encodeURIComponent(key)}=[redacted]`;
      return `${rawKey}=${rawVal}`;
    });
  return pairs.length ? `${pathname}?${pairs.join("&")}` : pathname;
}

function normalizeApiMetricPath(rawPath) {
  const pathOnly = String(rawPath || "").split("?")[0];
  if (!pathOnly) return "/api/unknown";
  if (/^\/api\/tiles\/[^/]+$/i.test(pathOnly)) return "/api/tiles/:id";
  return safeTrim(pathOnly, 140) || "/api/unknown";
}

function ensureApiRouteMetrics(method, pathName) {
  const key = `${method.toUpperCase()} ${pathName}`;
  let row = apiMetricsState.routes.get(key);
  if (!row) {
    row = {
      key,
      method: method.toUpperCase(),
      path: pathName,
      total: 0,
      success: 0,
      clientError: 0,
      serverError: 0,
      rateLimited: 0,
      durationTotalMs: 0,
      maxDurationMs: 0,
      lastDurationMs: 0,
      lastStatus: 0,
      lastAt: "",
      samples: []
    };
    apiMetricsState.routes.set(key, row);
  }
  return row;
}

function recordApiRequestMetrics(req, statusCode, durationMs) {
  const method = safeTrim(req?.method || "GET", 12) || "GET";
  const pathName = normalizeApiMetricPath(req?.originalUrl || req?.url || "");
  const route = ensureApiRouteMetrics(method, pathName);
  const status = Number(statusCode) || 0;
  const ms = Math.max(0, Number(durationMs) || 0);

  apiMetricsState.total += 1;
  if (status >= 500) apiMetricsState.serverError += 1;
  else if (status >= 400) apiMetricsState.clientError += 1;
  else apiMetricsState.success += 1;
  if (status === 429) apiMetricsState.rateLimited += 1;

  route.total += 1;
  if (status >= 500) route.serverError += 1;
  else if (status >= 400) route.clientError += 1;
  else route.success += 1;
  if (status === 429) route.rateLimited += 1;
  route.durationTotalMs += ms;
  route.maxDurationMs = Math.max(route.maxDurationMs, ms);
  route.lastDurationMs = ms;
  route.lastStatus = status;
  route.lastAt = new Date().toISOString();
  route.samples.push(ms);
  if (route.samples.length > API_METRICS_SAMPLE_LIMIT) route.samples.shift();

  if (status >= 500) {
    pushBounded(apiMetricsState.recentErrors, {
      at: new Date().toISOString(),
      requestId: safeTrim(req?.requestId || "", 40),
      method,
      path: pathName,
      status,
      durationMs: Math.round(ms * 10) / 10
    }, API_RECENT_ERRORS_LIMIT);
  }

  if (apiMetricsState.routes.size > 240) {
    const routes = Array.from(apiMetricsState.routes.values())
      .sort((a, b) => {
        if (a.total !== b.total) return b.total - a.total;
        return String(b.lastAt || "").localeCompare(String(a.lastAt || ""));
      })
      .slice(0, 220);
    apiMetricsState.routes = new Map(routes.map((item) => [item.key, item]));
  }
}

function getApiTopRoutes(limit = 8) {
  const max = Math.max(1, Math.min(40, Number(limit) || 8));
  return Array.from(apiMetricsState.routes.values())
    .sort((a, b) => {
      const aAvg = a.total > 0 ? a.durationTotalMs / a.total : 0;
      const bAvg = b.total > 0 ? b.durationTotalMs / b.total : 0;
      if (a.total !== b.total) return b.total - a.total;
      if (aAvg !== bAvg) return bAvg - aAvg;
      return String(b.lastAt || "").localeCompare(String(a.lastAt || ""));
    })
    .slice(0, max)
    .map((row) => {
      const avgMs = row.total > 0 ? row.durationTotalMs / row.total : 0;
      const sampleStats = summarizeSamples(row.samples);
      return {
        method: row.method,
        path: row.path,
        total: row.total,
        success: row.success,
        clientError: row.clientError,
        serverError: row.serverError,
        rateLimited: row.rateLimited,
        avgMs: Math.round(avgMs * 10) / 10,
        maxMs: Math.round(row.maxDurationMs * 10) / 10,
        p95Ms: sampleStats.p95Ms,
        p99Ms: sampleStats.p99Ms,
        lastStatus: row.lastStatus,
        lastAt: row.lastAt
      };
    });
}

function createRunHourBuckets() {
  return Array.from({ length: 24 }, () => 0);
}

function ensureRunAggregateEntry(map, key, fallback = {}) {
  const k = safeTrim(key, 96);
  if (!k) return null;
  let entry = map.get(k);
  if (!entry) {
    entry = {
      key: k,
      label: safeTrim(fallback.label || k, 120),
      profile: safeTrim(fallback.profile || "", 64),
      page: safeTrim(fallback.page || "", 64),
      type: safeTrim(fallback.type || "", 32),
      count: 0,
      success: 0,
      failed: 0,
      lastRunAt: "",
      lastErrorAt: "",
      lastError: "",
      hourBuckets: createRunHourBuckets()
    };
    map.set(k, entry);
  }
  return entry;
}

function recordRunEvent(event = {}) {
  const nowIso = new Date().toISOString();
  const ok = event.ok !== false;
  const source = event.source === "action" ? "action" : "tile";
  const tileId = safeTrim(event.tileId || "", 96);
  const action = safeTrim(event.action || "", 96);
  const profile = safeTrim(event.profile || "", 64);
  const page = safeTrim(event.page || "", 64);
  const type = safeTrim(event.type || "", 32);
  const label = safeTrim(event.label || tileId || action || source, 120);
  const errorText = event.error ? safeTrim(String(event.error), 240) : "";
  const hour = new Date().getHours();

  runAnalyticsState.total += 1;
  if (ok) runAnalyticsState.success += 1;
  else runAnalyticsState.failed += 1;

  if (tileId) {
    const tileEntry = ensureRunAggregateEntry(runAnalyticsState.byTile, tileId, {
      label,
      profile,
      page,
      type
    });
    if (tileEntry) {
      tileEntry.count += 1;
      if (ok) tileEntry.success += 1;
      else tileEntry.failed += 1;
      tileEntry.lastRunAt = nowIso;
      tileEntry.hourBuckets[hour] = (tileEntry.hourBuckets[hour] || 0) + 1;
      if (!ok) {
        tileEntry.lastErrorAt = nowIso;
        tileEntry.lastError = errorText;
      }
      if (profile && !tileEntry.profile) tileEntry.profile = profile;
      if (page && !tileEntry.page) tileEntry.page = page;
      if (type && !tileEntry.type) tileEntry.type = type;
    }
  }

  if (action) {
    const actionEntry = ensureRunAggregateEntry(runAnalyticsState.byAction, action, {
      label,
      profile,
      page,
      type
    });
    if (actionEntry) {
      actionEntry.count += 1;
      if (ok) actionEntry.success += 1;
      else actionEntry.failed += 1;
      actionEntry.lastRunAt = nowIso;
      actionEntry.hourBuckets[hour] = (actionEntry.hourBuckets[hour] || 0) + 1;
      if (!ok) {
        actionEntry.lastErrorAt = nowIso;
        actionEntry.lastError = errorText;
      }
    }
  }

  trimRunMap(runAnalyticsState.byTile, RUN_ANALYTICS_ENTRY_LIMIT);
  trimRunMap(runAnalyticsState.byAction, RUN_ANALYTICS_ENTRY_LIMIT);

  pushBounded(runAnalyticsState.recent, {
    at: nowIso,
    requestId: safeTrim(event.requestId || "", 40),
    source,
    ok,
    tileId,
    action,
    label,
    profile,
    page,
    type,
    error: ok ? "" : errorText
  }, RUN_ANALYTICS_RECENT_LIMIT);
}

function summarizeRunMap(map, limit = RUN_ANALYTICS_TOP_LIMIT) {
  const max = Math.max(1, Math.min(RUN_ANALYTICS_TOP_LIMIT, Number(limit) || RUN_ANALYTICS_TOP_LIMIT));
  return Array.from(map.values())
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return String(b.lastRunAt || "").localeCompare(String(a.lastRunAt || ""));
    })
    .slice(0, max)
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      profile: entry.profile,
      page: entry.page,
      type: entry.type,
      count: entry.count,
      success: entry.success,
      failed: entry.failed,
      successRate: entry.count > 0 ? Math.round((entry.success / entry.count) * 1000) / 10 : 0,
      lastRunAt: entry.lastRunAt || "",
      lastErrorAt: entry.lastErrorAt || "",
      lastError: entry.lastError || ""
    }));
}

function trimRunMap(map, maxEntries = RUN_ANALYTICS_ENTRY_LIMIT) {
  if (!(map instanceof Map) || map.size <= maxEntries) return;
  const keep = Array.from(map.values())
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return String(b.lastRunAt || "").localeCompare(String(a.lastRunAt || ""));
    })
    .slice(0, Math.max(40, maxEntries - 40));
  map.clear();
  for (const entry of keep) map.set(entry.key, entry);
}

function getRunAnalyticsSnapshot(recentLimit = 40) {
  const safeRecent = Math.max(1, Math.min(200, Number(recentLimit) || 40));
  return {
    totals: {
      total: runAnalyticsState.total,
      success: runAnalyticsState.success,
      failed: runAnalyticsState.failed,
      successRate: runAnalyticsState.total > 0
        ? Math.round((runAnalyticsState.success / runAnalyticsState.total) * 1000) / 10
        : 0
    },
    topTiles: summarizeRunMap(runAnalyticsState.byTile, RUN_ANALYTICS_TOP_LIMIT),
    topActions: summarizeRunMap(runAnalyticsState.byAction, RUN_ANALYTICS_TOP_LIMIT),
    recent: runAnalyticsState.recent.slice(0, safeRecent)
  };
}

function scoreTileRecommendation(tile, wowRunning, nowTs, currentHour, profileFilter, pageFilter) {
  const tileId = safeTrim(tile?.id || "", 96);
  if (!tileId) return null;
  if (!tileIsVisible(tile, wowRunning)) return null;
  if (profileFilter && tile.profile !== profileFilter) return null;
  if (pageFilter && tile.page !== pageFilter) return null;

  const stats = runAnalyticsState.byTile.get(tileId);
  const count = Number(stats?.count || 0);
  const hourHits = Number(stats?.hourBuckets?.[currentHour] || 0);
  const lastRunAt = stats?.lastRunAt ? Date.parse(stats.lastRunAt) : 0;
  let recencyBoost = 0;
  if (lastRunAt > 0 && nowTs > lastRunAt) {
    const ageMin = (nowTs - lastRunAt) / 60000;
    if (ageMin <= 3) recencyBoost = 70;
    else if (ageMin <= 30) recencyBoost = 45;
    else if (ageMin <= 180) recencyBoost = 26;
    else if (ageMin <= 1440) recencyBoost = 14;
    else recencyBoost = Math.max(0, 8 - Math.log10(ageMin));
  }

  const frequencyBoost = Math.min(160, count * 6);
  const hourBoost = Math.min(40, hourHits * 5);
  const pageBoost = pageFilter && tile.page === pageFilter ? 14 : 0;
  const profileBoost = profileFilter && tile.profile === profileFilter ? 10 : 0;
  const typeBoost = tile.type === "action" ? 6 : 0;
  const score = frequencyBoost + recencyBoost + hourBoost + pageBoost + profileBoost + typeBoost;

  return {
    id: tile.id,
    label: tile.label,
    subtitle: tile.subtitle || "",
    profile: tile.profile,
    page: tile.page,
    type: tile.type,
    iconMode: tile.iconMode || "emoji",
    icon: tile.icon || defaultTileEmoji(tile.type),
    score: Math.round(score * 10) / 10,
    count,
    hourHits,
    lastRunAt: stats?.lastRunAt || "",
    reason: count > 0
      ? `haeufig genutzt (${count}) + Zeitfenster (${hourHits})`
      : "noch ohne Historie"
  };
}

function getTileRecommendations(options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 10));
  const nowTs = Date.now();
  const currentHour = new Date(nowTs).getHours();
  const wowRunning = options.wowRunning === true;
  const profileFilter = safeTrim(options.profile || "", 64);
  const pageFilter = safeTrim(options.page || "", 64);

  const rows = [];
  for (const tile of config.tiles || []) {
    const scored = scoreTileRecommendation(tile, wowRunning, nowTs, currentHour, profileFilter, pageFilter);
    if (!scored) continue;
    rows.push(scored);
  }
  rows.sort((a, b) => b.score - a.score || b.count - a.count || a.label.localeCompare(b.label, "de", { sensitivity: "base" }));
  return rows.slice(0, limit);
}

function getRuntimeDiagnostics(options = {}) {
  const routeLimit = Math.max(1, Math.min(40, Number(options.routeLimit) || 10));
  const recentRunLimit = Math.max(1, Math.min(120, Number(options.recentRuns) || 20));
  const now = Date.now();
  const mem = process.memoryUsage();
  const runSnapshot = getRunAnalyticsSnapshot(recentRunLimit);
  return {
    process: {
      pid: process.pid,
      version: process.version,
      platform: process.platform,
      arch: process.arch,
      uptimeSec: Math.floor(process.uptime()),
      rssBytes: mem.rss || 0,
      heapUsedBytes: mem.heapUsed || 0,
      heapTotalBytes: mem.heapTotal || 0
    },
    requests: {
      active: apiMetricsState.active,
      total: apiMetricsState.total,
      success: apiMetricsState.success,
      clientError: apiMetricsState.clientError,
      serverError: apiMetricsState.serverError,
      rateLimited: apiMetricsState.rateLimited,
      topRoutes: getApiTopRoutes(routeLimit),
      recentErrors: apiMetricsState.recentErrors.slice(0, API_RECENT_ERRORS_LIMIT)
    },
    runs: runSnapshot,
    caches: {
      configRevision,
      programIndex: {
        entries: Array.isArray(programIndexCache.entries) ? programIndexCache.entries.length : 0,
        ageMs: programIndexCache.ts ? Math.max(0, now - programIndexCache.ts) : 0,
        ttlMs: PROGRAM_INDEX_CACHE_MS
      },
      icon: {
        entries: iconCache.size
      },
      processStatus: {
        entries: processStatusCache.size,
        ttlMs: PROCESS_STATUS_CACHE_MS
      },
      audioMixer: {
        cached: Boolean(audioMixerCache.payload),
        ageMs: audioMixerCache.ts ? Math.max(0, now - audioMixerCache.ts) : 0,
        ttlMs: AUDIO_MIXER_CACHE_MS
      },
      clientTiles: {
        cached: Array.isArray(clientTilesCache.payload?.tiles),
        ageMs: clientTilesCache.ts ? Math.max(0, now - clientTilesCache.ts) : 0,
        ttlMs: CLIENT_TILES_CACHE_MS,
        revision: clientTilesCache.revision
      }
    },
    liveStreams: {
      activeClients: liveStreamState.clients.size
    },
    runtime: {
      startedAt: new Date(apiMetricsState.startedAt).toISOString()
    }
  };
}

function safeArray(input, itemMaxLen = 512, maxItems = 16) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const value of input) {
    if (out.length >= maxItems) break;
    const item = safeTrim(String(value || ""), itemMaxLen);
    if (item) out.push(item);
  }
  return out;
}

function parseCommandArgs(rawInput) {
  const raw = safeTrim(rawInput, MAX_PATH_LEN);
  if (!raw) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m = null;
  while ((m = re.exec(raw)) !== null) {
    out.push(m[1] || m[2] || m[3] || "");
  }
  return out.filter(Boolean);
}

function splitLaunchTargetInput(rawInput) {
  const raw = safeTrim(rawInput, MAX_PATH_LEN);
  if (!raw) return { command: "", args: [] };

  const direct = unquoteWrapped(raw);
  const expandedDirect = expandEnv(direct);
  if (fileExists(expandedDirect) && isAppLaunchFilePath(expandedDirect)) {
    return { command: expandedDirect, args: [] };
  }

  const tokenized = parseCommandArgs(raw);
  if (tokenized.length > 1) {
    const tokenCommand = expandEnv(unquoteWrapped(tokenized[0]));
    if (fileExists(tokenCommand) && isAppLaunchFilePath(tokenCommand)) {
      return { command: tokenCommand, args: tokenized.slice(1) };
    }
  }

  const pathWithArgsMatch = raw.match(/^(.+\.(?:exe|lnk|bat|cmd|com))(?:\s+(.+))?$/i);
  if (pathWithArgsMatch) {
    return {
      command: expandEnv(unquoteWrapped(pathWithArgsMatch[1])),
      args: parseCommandArgs(pathWithArgsMatch[2] || "")
    };
  }

  return { command: direct, args: [] };
}

function assertSafeInput(value, label, maxLen = MAX_PATH_LEN) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.includes("\0")) throw new Error(`${label} ungueltig`);
  if (text.length > maxLen) throw new Error(`${label} zu lang`);
  return text;
}

function normalizeProtocolTarget(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw || raw.length > MAX_PATH_LEN || raw.includes("\0")) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) return "";
  if (/\s/.test(raw)) return "";
  return raw;
}

function secureEqualText(a, b) {
  const aBuf = Buffer.from(String(a || ""), "utf8");
  const bBuf = Buffer.from(String(b || ""), "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function isAppLaunchFilePath(p) {
  const ext = path.extname(String(p || "")).toLowerCase();
  return APP_FILE_EXTENSIONS.has(ext);
}

function looksLikePath(input) {
  const value = String(input || "").trim();
  if (!value) return false;
  if (/^[a-z]:[\\/]/i.test(value)) return true;
  if (value.includes("\\") || value.includes("/")) return true;
  if (value.startsWith(".\\")) return true;
  return false;
}

function normalizeProgramLabel(filePath) {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return base
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(x64|x86|launcher|setup)\b/gi, "")
    .trim();
}

function normalizeProgramMatchKey(value, stripExt = false) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const text = stripExt ? raw.replace(/\.(exe|lnk|bat|cmd|com)$/i, "") : raw;
  return text.replace(/[^a-z0-9]+/g, "");
}

function collectLaunchableFiles(rootDir, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 3;
  const maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : 1400;
  if (!dirExists(rootDir)) return [];

  const out = [];
  const stack = [{ dir: rootDir, depth: 0 }];
  while (stack.length && out.length < maxFiles) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      const full = path.join(cur.dir, entry.name);
      if (entry.isDirectory()) {
        if (cur.depth < maxDepth) stack.push({ dir: full, depth: cur.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isAppLaunchFilePath(full)) continue;
      out.push(full);
    }
  }

  return out;
}

function programSourcePriority(source) {
  if (source === "launcherPath") return 120;
  if (source === "launcherCandidate") return 95;
  if (source === "startMenu") return 80;
  if (source === "localPrograms") return 70;
  if (source === "programFiles") return 60;
  if (source === "desktop") return 45;
  return 20;
}

function scoreProgram(entry, query) {
  const q = String(query || "").trim().toLowerCase();
  let score = programSourcePriority(entry.source);
  if (!q) return score;

  const tokens = q.split(/\s+/).filter(Boolean);
  const label = entry.labelLower;
  const file = entry.fileLower;
  const full = entry.pathLower;
  const queryKey = normalizeProgramMatchKey(q, false);
  const queryBaseKey = normalizeProgramMatchKey(q, true);

  if (queryKey && queryKey === entry.fileKey) score += 260;
  if (queryBaseKey && queryBaseKey === entry.fileBaseKey) score += 240;
  if (queryBaseKey && queryBaseKey === entry.labelKey) score += 190;

  for (const token of tokens) {
    if (label === token) score += 220;
    else if (label.startsWith(token)) score += 120;
    else if (label.includes(token)) score += 70;

    if (file === token || file === `${token}.exe` || file === `${token}.lnk`) score += 120;
    else if (file.startsWith(token)) score += 65;
    else if (file.includes(token)) score += 30;

    if (full.includes(`\\${token}`)) score += 12;
  }

  return score;
}

function getSearchRoots() {
  const localAppData = process.env.LOCALAPPDATA || "";
  const appData = process.env.APPDATA || "";
  const programData = process.env.ProgramData || "C:\\ProgramData";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFiles86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const desktop = path.join(os.homedir(), "Desktop");

  return uniq([
    path.join(localAppData, "Programs"),
    programFiles,
    programFiles86,
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs"),
    desktop
  ]).filter((p) => dirExists(p));
}

let programIndexCache = { ts: 0, entries: [] };

function invalidateProgramIndexCache() {
  programIndexCache = { ts: 0, entries: [] };
}

function buildProgramIndex() {
  const now = Date.now();
  if (programIndexCache.entries.length && now - programIndexCache.ts < PROGRAM_INDEX_CACHE_MS) {
    return programIndexCache.entries;
  }

  const byPath = new Map();
  const add = (filePath, source, labelHint = "") => {
    const safePath = String(filePath || "").trim();
    if (!safePath || !fileExists(safePath) || !isAppLaunchFilePath(safePath)) return;
    const key = safePath.toLowerCase();
    if (byPath.has(key)) return;
    const ext = path.extname(safePath).toLowerCase();
    const fileName = path.basename(safePath).toLowerCase();
    const label = safeTrim(labelHint || normalizeProgramLabel(safePath) || path.basename(safePath, ext), 80);
    byPath.set(key, {
      label: label || path.basename(safePath, ext),
      path: safePath,
      source,
      ext,
      fileName,
      labelLower: label.toLowerCase(),
      fileLower: fileName,
      pathLower: safePath.toLowerCase(),
      labelKey: normalizeProgramMatchKey(label, true),
      fileKey: normalizeProgramMatchKey(fileName, false),
      fileBaseKey: normalizeProgramMatchKey(fileName, true)
    });
  };

  if (config?.launchers && typeof config.launchers === "object") {
    for (const [key, launcher] of Object.entries(config.launchers)) {
      if (!launcher || typeof launcher !== "object") continue;
      const label = safeTrim(launcher.label || key, 80);
      add(expandEnv(String(launcher.path || "")), "launcherPath", label);
      for (const candidate of launcher.candidates || []) {
        add(expandEnv(String(candidate || "")), "launcherCandidate", label);
      }
    }
  }

  for (const root of getSearchRoots()) {
    const source = root.toLowerCase().includes("start menu")
      ? "startMenu"
      : root.toLowerCase().includes("localappdata")
        ? "localPrograms"
        : root.toLowerCase().endsWith("\\desktop")
          ? "desktop"
          : "programFiles";

    const maxDepth = source === "startMenu" ? 4 : 3;
    const maxFiles = source === "startMenu" ? 2200 : 1600;
    for (const filePath of collectLaunchableFiles(root, { maxDepth, maxFiles })) add(filePath, source);
  }

  const entries = Array.from(byPath.values())
    .sort((a, b) => a.label.localeCompare(b.label, "de", { sensitivity: "base" }))
    .map((x) => ({
      label: x.label,
      path: x.path,
      source: x.source,
      ext: x.ext,
      fileName: x.fileName,
      labelLower: x.labelLower,
      fileLower: x.fileLower,
      pathLower: x.pathLower,
      labelKey: x.labelKey,
      fileKey: x.fileKey,
      fileBaseKey: x.fileBaseKey
    }));

  programIndexCache = { ts: now, entries };
  return entries;
}

function rankPrograms(query = "", limit = 25, includeWeakMatches = false) {
  const max = Math.max(1, Math.min(100, Number(limit) || 25));
  const q = safeTrim(query, 120).toLowerCase();
  const entries = buildProgramIndex();
  return entries
    .map((entry) => ({ entry, score: scoreProgram(entry, q) }))
    .filter((row) => !q || includeWeakMatches || row.score > programSourcePriority(row.entry.source))
    .sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label, "de", { sensitivity: "base" }))
    .slice(0, max);
}

function searchPrograms(query = "", limit = 25) {
  const ranked = rankPrograms(query, limit, false);
  return ranked.map(({ entry }) => ({ label: entry.label, path: entry.path, source: entry.source, ext: entry.ext }));
}

function chooseBestProgramMatch(ranked) {
  if (!Array.isArray(ranked) || !ranked.length) return "";
  if (ranked.length === 1) return ranked[0].entry.path;
  const first = ranked[0];
  const second = ranked[1];
  if (!second) return first.entry.path;
  if (first.score >= second.score + 80) return first.entry.path;
  if (first.score >= second.score + 55 && first.entry.source === "launcherPath") return first.entry.path;
  return "";
}

function findCommandOnPath(input) {
  const raw = safeTrim(input, 120);
  if (!raw || raw.includes("\\") || raw.includes("/") || raw.includes(":")) return "";
  const pathDirs = String(process.env.PATH || "")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x && dirExists(x));
  if (!pathDirs.length) return "";

  const hasExt = raw.includes(".");
  const names = hasExt ? [raw] : [`${raw}.exe`, `${raw}.cmd`, `${raw}.bat`, `${raw}.com`];
  for (const dir of pathDirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (fileExists(p)) return p;
    }
  }
  return "";
}

function resolveProgramPath(input) {
  const raw = unquoteWrapped(safeTrim(input, MAX_PATH_LEN));
  if (!raw) return "";
  const expanded = expandEnv(raw);
  if (fileExists(expanded) && isAppLaunchFilePath(expanded)) return expanded;

  const fromPath = findCommandOnPath(expanded);
  if (fromPath) return fromPath;

  const ranked = rankPrograms(expanded, 8, true);
  if (!ranked.length) return "";
  const candidates = ranked.map((x) => x.entry);

  const lowered = expanded.toLowerCase();
  const queryKey = normalizeProgramMatchKey(lowered, false);
  const queryBaseKey = normalizeProgramMatchKey(lowered, true);
  const exact = candidates.find((x) =>
    x.label.toLowerCase() === lowered ||
    path.basename(x.path).toLowerCase() === lowered ||
    path.basename(x.path, path.extname(x.path)).toLowerCase() === lowered ||
    (queryKey && x.fileKey === queryKey) ||
    (queryBaseKey && (x.fileBaseKey === queryBaseKey || x.labelKey === queryBaseKey))
  );
  if (exact) return exact.path;
  const byExeName = candidates.find((x) => x.fileLower === lowered || x.fileLower === `${lowered}.exe`);
  if (byExeName) return byExeName.path;

  const best = ranked[0]?.entry;
  if (best && queryBaseKey && queryBaseKey.length >= 4) {
    if (
      best.fileBaseKey.includes(queryBaseKey) ||
      queryBaseKey.includes(best.fileBaseKey) ||
      best.labelKey.includes(queryBaseKey)
    ) {
      return best.path;
    }
  }
  return chooseBestProgramMatch(ranked);
}

function expandEnv(value) {
  if (typeof value !== "string") return "";
  return value.replace(/%([^%]+)%/g, (_, key) => process.env[key] || "");
}

function getByPath(obj, dottedPath) {
  const parts = String(dottedPath || "").split(".").filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== "object" || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function resolveTemplate(value, config) {
  if (typeof value !== "string") return "";
  const m = value.match(/^\{\{(.+)\}\}$/);
  if (!m) return expandEnv(value);
  const got = getByPath(config, m[1].trim());
  return typeof got === "string" ? expandEnv(got) : "";
}

function hasTemplateSyntax(value) {
  const text = String(value || "");
  return text.includes("{{") && text.includes("}}");
}

function getDefaultProfiles() {
  return [
    { id: "work", label: "Work", pages: [{ id: "main", label: "Main" }, { id: "dev", label: "Dev" }] },
    { id: "wow", label: "WoW", pages: [{ id: "main", label: "Main" }, { id: "addons", label: "Addons" }] },
    { id: "gaming", label: "Gaming", pages: [{ id: "main", label: "Main" }, { id: "overlay", label: "Overlay" }, { id: "addons", label: "Addons" }] },
    { id: "streaming", label: "Streaming", pages: [{ id: "main", label: "Main" }, { id: "social", label: "Social" }] },
    { id: "fav", label: "Favorites", pages: [{ id: "main", label: "Main" }] }
  ];
}

function getDefaultTiles() {
  return [
    { id: "vscode", profile: "work", page: "dev", label: "VS Code", subtitle: "Workspace", type: "app", launcherKey: "vscode", args: ["."], startIn: "{{workspaceDir}}", iconMode: "auto", icon: "💻", builtin: true },
    { id: "terminal", profile: "work", page: "main", label: "Terminal", subtitle: "Windows Terminal", type: "action", action: "terminal", iconMode: "emoji", icon: "⌨️", builtin: true },
    { id: "powershell", profile: "work", page: "main", label: "PowerShell", subtitle: "Neue Session", type: "action", action: "powershell", iconMode: "emoji", icon: "🧰", builtin: true },
    { id: "workspace", profile: "work", page: "main", label: "Projektordner", subtitle: "Explorer", type: "folder", target: "{{workspaceDir}}", iconMode: "emoji", icon: "📁", builtin: true },
    { id: "wowStart", profile: "wow", page: "main", label: "WoW Start", subtitle: "Launcher + WoW Profil", type: "action", action: "wowStart", iconMode: "emoji", icon: "🎮", showIf: "wowNotRunning", builtin: true },
    { id: "wowLauncher", profile: "wow", page: "main", label: "WoW Launcher", subtitle: "Direkt starten", type: "app", launcherKey: "wow", iconMode: "auto", icon: "🎮", builtin: true },
    { id: "wowNavigator", profile: "wow", page: "addons", label: "WoW Navigator", subtitle: "Quest-Hilfe + Waypoints", type: "action", action: "wowNavigator", iconMode: "emoji", icon: "🧭", builtin: true },
    { id: "wowAddons", profile: "wow", page: "addons", label: "AddOns", subtitle: "Ordner oeffnen", type: "folder", target: "{{wow.folders.addons}}", iconMode: "emoji", icon: "🧩", showIf: "wowRunning", builtin: true },
    { id: "wowLogs", profile: "wow", page: "addons", label: "Logs", subtitle: "Ordner oeffnen", type: "folder", target: "{{wow.folders.logs}}", iconMode: "emoji", icon: "📝", showIf: "wowRunning", builtin: true },
    { id: "wowWtf", profile: "wow", page: "addons", label: "WTF", subtitle: "Ordner oeffnen", type: "folder", target: "{{wow.folders.wtf}}", iconMode: "emoji", icon: "⚙️", showIf: "wowRunning", builtin: true },
    { id: "gamingPerfOverlay", profile: "gaming", page: "overlay", label: "Leistungs-Overlay", subtitle: "CPU | RAM | Netz live", type: "action", action: "performanceOverlay", iconMode: "emoji", icon: "📊", builtin: true },
    { id: "gamingWowNavigator", profile: "gaming", page: "addons", label: "WoW Navigator", subtitle: "KI Quest-Hilfe", type: "action", action: "wowNavigator", iconMode: "emoji", icon: "🧭", builtin: true },
    { id: "gamingCurseForgeManager", profile: "gaming", page: "addons", label: "CurseForge Manager", subtitle: "AddOns verwalten", type: "action", action: "curseforgeManager", iconMode: "emoji", icon: "🧩", builtin: true },
    { id: "gamingCurseForgeApp", profile: "gaming", page: "addons", label: "CurseForge App", subtitle: "Client starten", type: "action", action: "curseforge", iconMode: "emoji", icon: "🔥", builtin: true },
    { id: "discord", profile: "streaming", page: "social", label: "Discord", subtitle: "Protocol", type: "protocol", target: "discord://", iconMode: "emoji", icon: "💬", builtin: true },
    { id: "obs", profile: "streaming", page: "main", label: "OBS Studio", subtitle: "Streaming", type: "app", launcherKey: "obs", iconMode: "auto", icon: "🎬", builtin: true },
    { id: "streamingSoundboard", profile: "streaming", page: "main", label: "Live Soundboard", subtitle: "App-Audio + Spotify", type: "action", action: "streamingSoundboard", iconMode: "emoji", icon: "🎚️", builtin: true }
  ];
}

function getDefaultLaunchers(oldConfig) {
  const oldPaths = oldConfig.paths && typeof oldConfig.paths === "object" ? oldConfig.paths : {};
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFiles86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  return {
    vscode: {
      label: "VS Code",
      path: oldPaths.vscode || "",
      candidates: uniq([
        path.join(localAppData, "Programs", "Microsoft VS Code", "Code.exe"),
        path.join(programFiles, "Microsoft VS Code", "Code.exe"),
        path.join(programFiles, "Microsoft VS Code Insiders", "Code - Insiders.exe")
      ])
    },
    wow: {
      label: "World of Warcraft Launcher",
      path: oldPaths.wowClassic || oldPaths.wowTBC || "",
      candidates: uniq([
        path.join(programFiles86, "World of Warcraft", "World of Warcraft Launcher.exe"),
        path.join(programFiles, "World of Warcraft", "World of Warcraft Launcher.exe"),
        path.join(programFiles86, "Battle.net", "Battle.net Launcher.exe"),
        path.join(programFiles, "Battle.net", "Battle.net Launcher.exe")
      ])
    },
    obs: {
      label: "OBS Studio",
      path: "",
      candidates: uniq([
        path.join(programFiles, "obs-studio", "bin", "64bit", "obs64.exe"),
        path.join(programFiles86, "obs-studio", "bin", "64bit", "obs64.exe")
      ])
    },
    curseforge: {
      label: "CurseForge",
      path: "",
      candidates: uniq([
        path.join(localAppData, "Programs", "CurseForge Windows", "CurseForge.exe"),
        path.join(localAppData, "Programs", "CurseForge", "CurseForge.exe"),
        path.join(programFiles, "Overwolf", "OverwolfLauncher.exe"),
        path.join(programFiles86, "Overwolf", "OverwolfLauncher.exe")
      ])
    }
  };
}

function createDefaultConfig(oldConfig = {}) {
  const wowFolders = oldConfig.wow && oldConfig.wow.folders ? oldConfig.wow.folders : {};
  const wowBase = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "World of Warcraft", "_anniversary_");
  return {
    host: "0.0.0.0",
    port: 8787,
    token: randomToken(),
    workspaceDir: process.cwd(),
    rateLimit: { windowMs: 3000, max: 20 },
    wow: {
      processName: oldConfig.wow && oldConfig.wow.processName ? oldConfig.wow.processName : "WowClassic.exe",
      folders: {
        addons: wowFolders.addons || path.join(wowBase, "Interface", "AddOns"),
        logs: wowFolders.logs || path.join(wowBase, "Logs"),
        wtf: wowFolders.wtf || path.join(wowBase, "WTF")
      }
    },
    logging: {
      enabled: oldConfig.logging?.enabled !== false,
      dir: typeof oldConfig.logging?.dir === "string" ? oldConfig.logging.dir : "",
      maxFiles: Number.isInteger(oldConfig.logging?.maxFiles) ? oldConfig.logging.maxFiles : 14,
      level: normalizeLogLevel(oldConfig.logging?.level, "INFO")
    },
    ai: {
      model: typeof oldConfig.ai?.model === "string" && oldConfig.ai.model.trim()
        ? safeTrim(oldConfig.ai.model, 80)
        : DEFAULT_AI_MODEL,
      openAiApiKey: typeof oldConfig.ai?.openAiApiKey === "string"
        ? safeTrim(oldConfig.ai.openAiApiKey, 256)
        : ""
    },
    launchers: getDefaultLaunchers(oldConfig),
    profiles: getDefaultProfiles(),
    tiles: getDefaultTiles()
  };
}

function normalizeProfiles(input) {
  if (!Array.isArray(input) || !input.length) return getDefaultProfiles();
  const out = [];
  for (const p of input) {
    if (!p || typeof p !== "object") continue;
    const id = String(p.id || "").trim();
    const label = String(p.label || "").trim();
    if (!id || !label) continue;
    const pages = Array.isArray(p.pages) && p.pages.length
      ? p.pages
          .map((x) => ({ id: String(x.id || "").trim(), label: String(x.label || "").trim() }))
          .filter((x) => x.id && x.label)
      : [{ id: "main", label: "Main" }];
    out.push({ id, label, pages: pages.length ? pages : [{ id: "main", label: "Main" }] });
  }
  if (!out.length) return getDefaultProfiles();

  const profileById = new Map(out.map((p) => [p.id, p]));
  for (const def of getDefaultProfiles()) {
    const existing = profileById.get(def.id);
    if (!existing) {
      const clone = {
        id: def.id,
        label: def.label,
        pages: def.pages.map((x) => ({ id: x.id, label: x.label }))
      };
      out.push(clone);
      profileById.set(clone.id, clone);
      continue;
    }

    const pageById = new Map((existing.pages || []).map((x) => [x.id, x]));
    for (const defPage of def.pages) {
      if (!pageById.has(defPage.id)) existing.pages.push({ id: defPage.id, label: defPage.label });
    }
  }

  return out;
}
function normalizeTile(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = safeTrim(raw.id, 64);
  const profile = safeTrim(raw.profile, 64);
  const page = safeTrim(raw.page || "main", 64);
  const label = safeTrim(raw.label, 80);
  const type = safeTrim(raw.type, 32);
  if (!id || !profile || !page || !label || !type) return null;
  if (!TILE_TYPES.has(type)) return null;

  const tile = {
    id,
    profile,
    page,
    label,
    subtitle: safeTrim(raw.subtitle, 140),
    type,
    builtin: Boolean(raw.builtin),
    showIf: TILE_SHOW_IF.has(safeTrim(raw.showIf, 24)) ? safeTrim(raw.showIf, 24) : "",
    iconMode: ICON_MODES.has(raw.iconMode) ? raw.iconMode : "emoji",
    icon: safeTrim(raw.icon, 12),
    iconData: typeof raw.iconData === "string" && raw.iconData.length <= MAX_ICON_DATA_URL_LEN ? raw.iconData : ""
  };

  if (typeof raw.launcherKey === "string" && raw.launcherKey.trim()) tile.launcherKey = safeTrim(raw.launcherKey, 64);
  if (typeof raw.target === "string" && raw.target.trim()) {
    const target = String(raw.target).trim();
    if (target.includes("\0") || target.length > MAX_PATH_LEN) return null;
    tile.target = target;
  }
  if (Array.isArray(raw.args)) tile.args = safeArray(raw.args, 512, 16);
  if (typeof raw.startIn === "string" && raw.startIn.trim()) {
    const startIn = String(raw.startIn).trim();
    if (startIn.includes("\0") || startIn.length > MAX_PATH_LEN) return null;
    tile.startIn = startIn;
  }
  if (typeof raw.action === "string" && raw.action.trim()) tile.action = safeTrim(raw.action, 64);

  if (tile.type === "action" && (!tile.action || !NAMED_ACTIONS.has(tile.action))) return null;
  if (tile.type === "app" && !tile.target && !tile.launcherKey) return null;
  if ((tile.type === "folder" || tile.type === "url" || tile.type === "protocol") && !tile.target) return null;
  if (tile.type === "url" && !normalizeHttpUrl(tile.target)) return null;
  if (tile.type === "protocol" && !normalizeProtocolTarget(tile.target)) return null;

  return tile;
}

function ensureBuiltinTiles(inputTiles) {
  const byId = new Map();
  for (const raw of Array.isArray(inputTiles) ? inputTiles : []) {
    const t = normalizeTile(raw);
    if (!t) continue;
    byId.set(t.id, t);
  }
  for (const def of getDefaultTiles()) {
    if (!byId.has(def.id)) byId.set(def.id, def);
  }
  return Array.from(byId.values());
}

function autodetectLaunchers(config, oneKey = "") {
  if (!config.launchers || typeof config.launchers !== "object") return false;
  let changed = false;
  for (const [key, launcher] of Object.entries(config.launchers)) {
    if (oneKey && key !== oneKey) continue;
    if (!launcher || typeof launcher !== "object") continue;

    const current = expandEnv(String(launcher.path || ""));
    if (current && fileExists(current)) {
      launcher.path = current;
      continue;
    }

    const candidates = uniq((launcher.candidates || []).map(expandEnv));
    const found = candidates.find((p) => fileExists(p));
    if (found && launcher.path !== found) {
      launcher.path = found;
      changed = true;
    }
  }
  return changed;
}

function mergeWithDefaults(raw) {
  const base = createDefaultConfig(raw);
  const cfg = raw && typeof raw === "object" ? raw : {};
  const out = { ...base };

  if (typeof cfg.host === "string" && cfg.host.trim()) out.host = cfg.host.trim();
  if (Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port <= 65535) out.port = cfg.port;
  if (typeof cfg.token === "string" && cfg.token.length >= 12) out.token = cfg.token;
  if (typeof cfg.workspaceDir === "string" && cfg.workspaceDir.trim()) out.workspaceDir = cfg.workspaceDir.trim();

  if (cfg.rateLimit && typeof cfg.rateLimit === "object") {
    const w = Number(cfg.rateLimit.windowMs);
    const m = Number(cfg.rateLimit.max);
    out.rateLimit = {
      windowMs: Number.isFinite(w) ? Math.max(250, Math.floor(w)) : out.rateLimit.windowMs,
      max: Number.isFinite(m) ? Math.max(3, Math.floor(m)) : out.rateLimit.max
    };
  }

  if (cfg.wow && typeof cfg.wow === "object") {
    out.wow = {
      processName: typeof cfg.wow.processName === "string" && cfg.wow.processName.trim() ? cfg.wow.processName.trim() : out.wow.processName,
      folders: {
        addons: typeof cfg.wow.folders?.addons === "string" ? cfg.wow.folders.addons : out.wow.folders.addons,
        logs: typeof cfg.wow.folders?.logs === "string" ? cfg.wow.folders.logs : out.wow.folders.logs,
        wtf: typeof cfg.wow.folders?.wtf === "string" ? cfg.wow.folders.wtf : out.wow.folders.wtf
      }
    };
  }

  if (cfg.logging && typeof cfg.logging === "object") {
    const maxFiles = Number(cfg.logging.maxFiles);
    out.logging = {
      enabled: cfg.logging.enabled !== false,
      dir: typeof cfg.logging.dir === "string" ? cfg.logging.dir : out.logging.dir,
      maxFiles: Number.isFinite(maxFiles) ? Math.max(3, Math.min(90, Math.floor(maxFiles))) : out.logging.maxFiles,
      level: normalizeLogLevel(cfg.logging.level, out.logging.level)
    };
  }

  if (cfg.ai && typeof cfg.ai === "object") {
    out.ai = {
      model: safeTrim(cfg.ai.model || out.ai.model || DEFAULT_AI_MODEL, 80) || DEFAULT_AI_MODEL,
      openAiApiKey: typeof cfg.ai.openAiApiKey === "string"
        ? safeTrim(cfg.ai.openAiApiKey, 256)
        : out.ai.openAiApiKey
    };
  }

  if (cfg.launchers && typeof cfg.launchers === "object") {
    const merged = { ...out.launchers };
    for (const [key, value] of Object.entries(cfg.launchers)) {
      if (!value || typeof value !== "object") continue;
      const old = merged[key] || { label: key, path: "", candidates: [] };
      merged[key] = {
        label: typeof value.label === "string" && value.label.trim() ? value.label : old.label,
        path: typeof value.path === "string" ? value.path : old.path,
        candidates: uniq([...(old.candidates || []), ...(value.candidates || [])])
      };
    }
    out.launchers = merged;
  }

  out.profiles = normalizeProfiles(cfg.profiles);
  out.tiles = ensureBuiltinTiles(cfg.tiles);
  if (!DISABLE_AUTODETECT) autodetectLaunchers(out);
  return out;
}

function resolveConfigPath() {
  const envOverride = safeTrim(
    process.env.STREAMDECK_CONFIG_PATH || process.env.STREAMDECK_CONFIG || process.env.STREAMDECK_REMOTE_CONFIG || "",
    MAX_PATH_LEN
  );
  if (envOverride) {
    const candidate = path.isAbsolute(envOverride)
      ? envOverride
      : path.resolve(process.cwd(), envOverride);
    const parent = path.dirname(candidate);
    if (!dirExists(parent)) fs.mkdirSync(parent, { recursive: true });
    return candidate;
  }

  const local = path.join(__dirname, "config.json");
  if (!IS_PKG && fileExists(local)) return local;

  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const dir = path.join(appData, "StreamDeckRemote");
  if (!dirExists(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "config.json");
}

const CONFIG_PATH = resolveConfigPath();

const loggerState = {
  enabled: true,
  dir: path.join(path.dirname(CONFIG_PATH), "logs"),
  maxFiles: 14,
  level: normalizeLogLevel(process.env.STREAMDECK_LOG_LEVEL, "INFO"),
  writeCount: 0
};

function resolveLogsDir(loggingCfg = {}) {
  const configured = expandEnv(String(loggingCfg.dir || "").trim());
  if (configured) return configured;
  return path.join(path.dirname(CONFIG_PATH), "logs");
}

function pruneOldLogFiles() {
  if (!dirExists(loggerState.dir)) return;
  let files = [];
  try {
    files = fs
      .readdirSync(loggerState.dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && LOG_FILE_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return;
  }

  for (let i = loggerState.maxFiles; i < files.length; i += 1) {
    try {
      fs.unlinkSync(path.join(loggerState.dir, files[i]));
    } catch {
      // ignore delete failures for old logs
    }
  }
}

function applyLoggingConfig(cfg = {}) {
  const loggingCfg = cfg.logging && typeof cfg.logging === "object" ? cfg.logging : {};
  const configuredLevel = normalizeLogLevel(loggingCfg.level, "INFO");
  const envLevelRaw = safeTrim(process.env.STREAMDECK_LOG_LEVEL, 16).toUpperCase();
  const envLevel = hasLogLevel(envLevelRaw) ? envLevelRaw : "";
  loggerState.enabled = loggingCfg.enabled !== false;
  loggerState.maxFiles = Math.max(3, Math.min(90, Number(loggingCfg.maxFiles) || 14));
  loggerState.dir = resolveLogsDir(loggingCfg);
  loggerState.level = envLevel || configuredLevel;

  if (!loggerState.enabled) return;
  try {
    if (!dirExists(loggerState.dir)) fs.mkdirSync(loggerState.dir, { recursive: true });
    pruneOldLogFiles();
  } catch {
    loggerState.enabled = false;
  }
}

function todayLogFile() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(loggerState.dir, `${LOG_FILE_PREFIX}${day}.log`);
}

function safeLogMeta(meta) {
  if (meta === undefined) return "";
  try {
    const text = typeof meta === "string" ? meta : JSON.stringify(meta);
    return text ? ` ${text}` : "";
  } catch {
    return " [meta:unserializable]";
  }
}

function writeLog(level, message, meta) {
  const normalizedLevel = normalizeLogLevel(level, "INFO");
  if (LOG_LEVELS[normalizedLevel] > LOG_LEVELS[loggerState.level]) return;
  const ts = new Date().toISOString();
  const msg = safeTrim(String(message || ""), 4000);
  const line = `[${ts}] [${normalizedLevel}] ${msg}${safeLogMeta(meta)}`;

  if (normalizedLevel === "ERROR" || normalizedLevel === "WARN") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);

  if (!loggerState.enabled) return;
  try {
    if (!dirExists(loggerState.dir)) fs.mkdirSync(loggerState.dir, { recursive: true });
    fs.appendFileSync(todayLogFile(), `${line}\n`, "utf8");
    loggerState.writeCount += 1;
    if (loggerState.writeCount % 80 === 0) pruneOldLogFiles();
  } catch {
    // keep app operational even if log file writing fails
  }
}

const logger = {
  info: (message, meta) => writeLog("INFO", message, meta),
  warn: (message, meta) => writeLog("WARN", message, meta),
  error: (message, meta) => writeLog("ERROR", message, meta),
  debug: (message, meta) => writeLog("DEBUG", message, meta)
};

function readRecentLogLines(limit = 200) {
  const maxLines = Math.max(10, Math.min(2000, Number(limit) || 200));
  if (!dirExists(loggerState.dir)) return [];

  let names = [];
  try {
    names = fs
      .readdirSync(loggerState.dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && LOG_FILE_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }

  const collected = [];
  for (const name of names) {
    if (collected.length >= maxLines) break;
    const p = path.join(loggerState.dir, name);
    let lines = [];
    try {
      lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0 && collected.length < maxLines; i -= 1) {
      collected.push(lines[i]);
    }
  }

  return collected.reverse();
}

function parseJsonFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(content);
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  if (!dirExists(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function cloneConfigData(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function readConfigFromPath(filePath) {
  const raw = parseJsonFile(filePath);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config root must be an object");
  }
  return mergeWithDefaults(raw);
}

function readConfig() {
  if (!fileExists(CONFIG_PATH)) {
    const fresh = createDefaultConfig({});
    if (!DISABLE_AUTODETECT) autodetectLaunchers(fresh);
    writeJsonAtomic(CONFIG_PATH, fresh);
    return fresh;
  }

  try {
    return readConfigFromPath(CONFIG_PATH);
  } catch (error) {
    logger.error("config parse error", { error: error?.message || String(error), path: CONFIG_PATH });
    const backupPath = `${CONFIG_PATH}.bak`;
    if (fileExists(backupPath)) {
      try {
        const recovered = readConfigFromPath(backupPath);
        logger.warn("config backup recovery used", { path: backupPath });
        return recovered;
      } catch (backupError) {
        logger.error("config backup parse error", {
          error: backupError?.message || String(backupError),
          path: backupPath
        });
      }
    }
    return mergeWithDefaults({});
  }
}

let config = readConfig();
applyLoggingConfig(config);
refreshAiRuntimeState(config);
function persistConfig() {
  const backupPath = `${CONFIG_PATH}.bak`;
  if (fileExists(CONFIG_PATH)) {
    try {
      fs.copyFileSync(CONFIG_PATH, backupPath);
    } catch (error) {
      logger.warn("config backup write warning", {
        error: error?.message || String(error),
        path: backupPath
      });
    }
  }
  writeJsonAtomic(CONFIG_PATH, config);
}

function persistConfigSafe() {
  try {
    persistConfig();
    applyLoggingConfig(config);
    refreshAiRuntimeState(config);
    return true;
  } catch (error) {
    logger.warn("config write warning", { error: error?.message || String(error), path: CONFIG_PATH });
    return false;
  }
}

if (!persistConfigSafe()) {
  logger.warn("config normalization write skipped", { path: CONFIG_PATH });
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      const out = String(stdout || "");
      const errOut = String(stderr || "");
      if (err) {
        err.stdout = out;
        err.stderr = errOut;
        err.bin = file;
        err.binArgs = args;
        return reject(err);
      }
      resolve({ stdout: out, stderr: errOut });
    });
  });
}

function spawnDetached(command, args = [], opts = {}) {
  const safeOpts = { detached: true, stdio: "ignore", ...opts };
  if (safeOpts.cwd && !dirExists(safeOpts.cwd)) delete safeOpts.cwd;
  if (DRY_RUN) {
    logger.info("dry-run spawn skipped", { command, args, cwd: safeOpts.cwd || "" });
    return;
  }
  const child = spawn(command, args, safeOpts);
  child.on("error", (err) => logger.error("spawn error", { command, args, error: String(err) }));
  child.unref();
}

function startViaCmd(target, args = [], cwd = "") {
  const opts = cwd ? { cwd } : {};
  spawnDetached("cmd.exe", ["/c", "start", "", target, ...args], opts);
}

function normalizeHttpUrl(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) return "";
  try {
    const url = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

function setSecurityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'self'"
  );
  next();
}

function resolveLauncherPath(key) {
  const launcher = config.launchers && typeof config.launchers === "object" ? config.launchers[key] : null;
  if (!launcher || typeof launcher !== "object") return "";
  return expandEnv(String(launcher.path || "").trim());
}

function resolveLauncherPathWithCandidates(key) {
  const direct = resolveLauncherPath(key);
  if (direct && fileExists(direct)) return direct;
  const launcher = config.launchers && typeof config.launchers === "object" ? config.launchers[key] : null;
  if (!launcher || !Array.isArray(launcher.candidates)) return direct;
  for (const raw of launcher.candidates) {
    const candidate = expandEnv(String(raw || "").trim());
    if (!candidate) continue;
    if (fileExists(candidate)) return candidate;
  }
  return direct;
}

const CURSEFORGE_PROCESS_NAMES = Object.freeze(["CurseForge.exe"]);

function resolveCurseForgeExecutablePath() {
  const launcher = config.launchers && typeof config.launchers === "object" ? config.launchers.curseforge : null;
  const candidates = [];

  const configured = resolveLauncherPath("curseforge");
  if (configured) candidates.push(configured);
  if (launcher && Array.isArray(launcher.candidates)) {
    for (const raw of launcher.candidates) {
      const expanded = expandEnv(String(raw || "").trim());
      if (expanded) candidates.push(expanded);
    }
  }

  const bestMatch = resolveLauncherPathWithCandidates("curseforge");
  if (bestMatch) candidates.push(bestMatch);

  for (const candidate of uniq(candidates.filter(Boolean))) {
    if (!fileExists(candidate)) continue;
    if (path.basename(candidate).toLowerCase() === "curseforge.exe") return candidate;
  }
  return "";
}

function resolveTileTarget(tile) {
  if (tile.launcherKey) return resolveLauncherPath(tile.launcherKey);
  if (typeof tile.target === "string") return unquoteWrapped(resolveTemplate(tile.target, config));
  return "";
}

function assertFilePath(value, label) {
  const p = String(value || "").trim();
  if (!p) throw new Error(`${label} fehlt`);
  if (!fileExists(p)) throw new Error(`${label} nicht gefunden: ${p}`);
  return p;
}

function assertFolderPath(value, label) {
  const p = String(value || "").trim();
  if (!p) throw new Error(`${label} fehlt`);
  if (!dirExists(p)) throw new Error(`${label} nicht gefunden: ${p}`);
  return p;
}
function safeWorkspaceDir() {
  const dir = resolveTemplate("{{workspaceDir}}", config);
  return dirExists(dir) ? dir : process.cwd();
}

function runNamedAction(name, payload = {}) {
  const action = String(name || "").trim();
  if (!action) throw new Error("Action fehlt");

  if (action === "terminal") {
    startViaCmd("wt.exe");
    return;
  }
  if (action === "powershell") {
    startViaCmd("powershell.exe", ["-NoExit"]);
    return;
  }
  if (action === "browser") {
    const url = normalizeHttpUrl(payload.url || payload.target || "https://google.com");
    if (!url) throw new Error("ungueltige URL");
    startViaCmd(url);
    return;
  }
  if (action === "discord") {
    startViaCmd("discord://");
    return;
  }
  if (action === "streamingSoundboard") {
    startViaCmd(`http://localhost:${config.port}/StreamDeck.html?profile=streaming&page=main&panel=streamingSoundboard`);
    return;
  }
  if (action === "wowNavigator") {
    startViaCmd(`http://localhost:${config.port}/StreamDeck.html?profile=gaming&page=addons&panel=wowNavigator`);
    return;
  }
  if (action === "curseforge") {
    const exe = resolveCurseForgeExecutablePath();
    if (exe && fileExists(exe)) {
      startViaCmd(exe);
      return;
    }
    startViaCmd("https://www.curseforge.com/download/app");
    return;
  }
  if (action === "curseforgeManager") {
    startViaCmd(`http://localhost:${config.port}/StreamDeck.html?profile=gaming&page=main&panel=curseforgeManager`);
    return;
  }
  if (action === "performanceOverlay") {
    startViaCmd(`http://localhost:${config.port}/StreamDeck.html?profile=gaming&page=main&panel=performanceOverlay`);
    return;
  }
  if (action === "wowStart") {
    const wowExe = assertFilePath(resolveLauncherPath("wow"), "WoW Launcher");
    startViaCmd(wowExe);
    startViaCmd(`http://localhost:${config.port}/StreamDeck.html?profile=wow`);
    return;
  }
  if (action === "openWorkspace") {
    const workspace = assertFolderPath(safeWorkspaceDir(), "Workspace");
    startViaCmd("explorer.exe", [workspace]);
    return;
  }

  throw new Error(`Unbekannte Action: ${action}`);
}

function runTile(tile, payload = {}) {
  if (!tile || typeof tile !== "object") throw new Error("Tile fehlt");

  if (tile.type === "action") {
    if (!tile.action) throw new Error("Tile Action fehlt");
    runNamedAction(tile.action, payload);
    return;
  }

  if (tile.type === "app") {
    const split = splitLaunchTargetInput(resolveTileTarget(tile));
    let resolvedTarget = split.command;
    const rawArgs = [
      ...split.args,
      ...(Array.isArray(tile.args) ? tile.args.map((x) => String(x)) : [])
    ];
    const args = rawArgs.map((x) => String(resolveTemplate(String(x), config))).filter(Boolean);

    if (!fileExists(resolvedTarget)) {
      const fromResolver = resolveProgramPath(resolvedTarget);
      if (fromResolver) resolvedTarget = fromResolver;
    }
    const target = assertFilePath(resolvedTarget, `Programm ${tile.label || tile.id}`);
    const cwd = tile.startIn ? resolveTemplate(tile.startIn, config) : "";
    const ext = path.extname(target).toLowerCase();

    if (ext === ".lnk" || ext === ".bat" || ext === ".cmd" || ext === ".com") {
      startViaCmd(target, args, cwd);
    } else {
      spawnDetached(target, args, cwd ? { cwd } : {});
    }
    return;
  }

  if (tile.type === "folder") {
    const folder = assertFolderPath(resolveTileTarget(tile), `Ordner ${tile.label || tile.id}`);
    startViaCmd("explorer.exe", [folder]);
    return;
  }

  if (tile.type === "url") {
    const url = normalizeHttpUrl(resolveTileTarget(tile));
    if (!url) throw new Error("ungueltige URL");
    startViaCmd(url);
    return;
  }

  if (tile.type === "protocol") {
    const protocol = normalizeProtocolTarget(resolveTileTarget(tile));
    if (!protocol) throw new Error("ungueltiges Protocol");
    startViaCmd(protocol);
    return;
  }

  throw new Error(`Tile Typ nicht unterstuetzt: ${tile.type}`);
}

function runLegacyAction(action, payload = {}) {
  if (action === "vscode") {
    const tile = config.tiles.find((x) => x.id === "vscode");
    if (!tile) throw new Error("vscode tile fehlt");
    runTile(tile, payload);
    return;
  }
  if (action === "wowClassic" || action === "wowTBC") {
    const tile = config.tiles.find((x) => x.id === "wowLauncher");
    if (!tile) throw new Error("wow launcher tile fehlt");
    runTile(tile, payload);
    return;
  }
  if (action === "openWowAddons") {
    startViaCmd("explorer.exe", [assertFolderPath(config.wow.folders.addons, "WoW Addons")]);
    return;
  }
  if (action === "openWowLogs") {
    startViaCmd("explorer.exe", [assertFolderPath(config.wow.folders.logs, "WoW Logs")]);
    return;
  }
  if (action === "openWowWtf") {
    startViaCmd("explorer.exe", [assertFolderPath(config.wow.folders.wtf, "WoW WTF")]);
    return;
  }
  runNamedAction(action, payload);
}

async function runPowerShell(script, args = [], timeoutMs = 10000, options = {}) {
  const cmdArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass"];
  if (options && options.sta === true) cmdArgs.push("-Sta");
  cmdArgs.push("-Command", script, ...args);
  try {
    const result = await execFileAsync("powershell.exe", cmdArgs, { windowsHide: true, timeout: timeoutMs });
    return result.stdout.trim();
  } catch (error) {
    const details = [
      error?.message ? String(error.message) : "",
      error?.stderr ? String(error.stderr) : "",
      error?.stdout ? String(error.stdout) : ""
    ]
      .filter(Boolean)
      .join(" | ");
    throw new Error(safeTrim(details || "powershell execution failed", 1200));
  }
}

function parseJsonPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Leere JSON-Antwort");
  try {
    return JSON.parse(raw);
  } catch {
    // Continue with fallback extraction.
  }

  const firstObject = raw.indexOf("{");
  const lastObject = raw.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    const fragment = raw.slice(firstObject, lastObject + 1);
    try {
      return JSON.parse(fragment);
    } catch {
      // ignore and continue
    }
  }

  const firstArray = raw.indexOf("[");
  const lastArray = raw.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) {
    const fragment = raw.slice(firstArray, lastArray + 1);
    return JSON.parse(fragment);
  }
  throw new Error(`JSON konnte nicht gelesen werden: ${safeTrim(raw, 260)}`);
}

async function runPowerShellJson(script, args = [], timeoutMs = 12000, options = {}) {
  const output = await runPowerShell(script, args, timeoutMs, options);
  return parseJsonPayload(output);
}

const AUDIO_MIXER_BRIDGE_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace StreamDeckAudio {
  public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
  public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }
  public enum AudioSessionState { Inactive = 0, Active = 1, Expired = 2 }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int NotImpl1();
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppDevice);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
  }

  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int NotImpl1();
    int NotImpl2();
    int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
  }

  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    int GetCount(out int SessionCount);
    int GetSession(int SessionCount, out IAudioSessionControl Session);
  }

  [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl {
    int GetState(out AudioSessionState pRetVal);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetGroupingParam(out Guid pRetVal);
    int SetGroupingParam(ref Guid Override, ref Guid EventContext);
    int RegisterAudioSessionNotification(IntPtr NewNotifications);
    int UnregisterAudioSessionNotification(IntPtr NewNotifications);
  }

  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int GetState(out AudioSessionState pRetVal);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetGroupingParam(out Guid pRetVal);
    int SetGroupingParam(ref Guid Override, ref Guid EventContext);
    int RegisterAudioSessionNotification(IntPtr NewNotifications);
    int UnregisterAudioSessionNotification(IntPtr NewNotifications);
    int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int GetProcessId(out uint pRetVal);
    int IsSystemSoundsSession();
    int SetDuckingPreference(bool optOut);
  }

  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    int SetMasterVolume(float fLevel, ref Guid EventContext);
    int GetMasterVolume(out float pfLevel);
    int SetMute(bool bMute, ref Guid EventContext);
    int GetMute(out bool pbMute);
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorComObject { }

  public sealed class SessionSnapshot {
    public int Pid { get; set; }
    public string ProcessName { get; set; }
    public string DisplayName { get; set; }
    public string SessionIdentifier { get; set; }
    public string SessionInstanceIdentifier { get; set; }
    public string SessionKey { get; set; }
    public string State { get; set; }
    public double VolumePercent { get; set; }
    public bool Muted { get; set; }
    public bool HasWindow { get; set; }
  }

  public static class CoreAudioBridge {
    const int CLSCTX_ALL = 23;
    const uint WM_APPCOMMAND = 0x0319;
    const int APPCOMMAND_MEDIA_PLAY_PAUSE = 14;
    const byte VK_MEDIA_PLAY_PAUSE = 0xB3;
    const int KEYEVENTF_KEYUP = 0x0002;

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);

    static IAudioSessionEnumerator CreateSessionEnumerator(ERole role) {
      IMMDeviceEnumerator deviceEnumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
      if (deviceEnumerator == null) throw new InvalidOperationException("IMMDeviceEnumerator unavailable");

      IMMDevice device;
      Marshal.ThrowExceptionForHR(deviceEnumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, role, out device));
      if (device == null) throw new InvalidOperationException("Default audio endpoint unavailable");

      object managerObj;
      Guid iid = typeof(IAudioSessionManager2).GUID;
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out managerObj));
      IAudioSessionManager2 manager = managerObj as IAudioSessionManager2;
      if (manager == null) throw new InvalidOperationException("IAudioSessionManager2 unavailable");

      IAudioSessionEnumerator enumerator;
      Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out enumerator));
      return enumerator;
    }

    static string GuessProcessNameFromIdentifier(string sessionIdentifier) {
      if (string.IsNullOrWhiteSpace(sessionIdentifier)) return "";
      string raw = sessionIdentifier.Trim();
      int exeIndex = raw.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
      if (exeIndex <= 0) return "";

      int startBackslash = raw.LastIndexOf('\\', exeIndex);
      int startSlash = raw.LastIndexOf('/', exeIndex);
      int start = Math.Max(startBackslash, startSlash) + 1;
      int length = (exeIndex + 4) - start;
      if (start < 0 || length <= 0 || start + length > raw.Length) return "";

      string fileName = raw.Substring(start, length);
      if (fileName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) {
        fileName = fileName.Substring(0, fileName.Length - 4);
      }
      return fileName.Trim();
    }

    static string BuildSessionKey(int pid, string sessionIdentifier, string sessionInstanceIdentifier, string processName, int fallbackIndex) {
      if (!string.IsNullOrWhiteSpace(sessionInstanceIdentifier)) return "inst::" + sessionInstanceIdentifier.Trim();
      if (!string.IsNullOrWhiteSpace(sessionIdentifier)) return "sess::" + sessionIdentifier.Trim();

      string proc = processName ?? "";
      return string.Format("pid::{0}:{1}:{2}", pid, proc.Trim().ToLowerInvariant(), fallbackIndex);
    }

    static bool SessionMatchesTarget(
      int currentPid,
      string currentSessionIdentifier,
      string currentSessionInstanceIdentifier,
      string currentProcessName,
      int fallbackIndex,
      int targetPid,
      string targetSessionKey
    ) {
      string target = targetSessionKey ?? "";
      if (!string.IsNullOrWhiteSpace(target)) {
        string key = BuildSessionKey(currentPid, currentSessionIdentifier, currentSessionInstanceIdentifier, currentProcessName, fallbackIndex);
        if (string.Equals(key, target, StringComparison.OrdinalIgnoreCase)) return true;
        if (!string.IsNullOrWhiteSpace(currentSessionIdentifier)
          && string.Equals(currentSessionIdentifier, target, StringComparison.OrdinalIgnoreCase)) return true;
        if (!string.IsNullOrWhiteSpace(currentSessionInstanceIdentifier)
          && string.Equals(currentSessionInstanceIdentifier, target, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
      }

      return targetPid > 0 && currentPid == targetPid;
    }

    public static List<SessionSnapshot> ListSessions() {
      List<SessionSnapshot> result = new List<SessionSnapshot>();
      HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      ERole[] roles = new ERole[] { ERole.eMultimedia, ERole.eConsole, ERole.eCommunications };

      for (int roleIndex = 0; roleIndex < roles.Length; roleIndex++) {
        IAudioSessionEnumerator enumerator = null;
        try {
          enumerator = CreateSessionEnumerator(roles[roleIndex]);
        } catch {
          continue;
        }

        int count = 0;
        Marshal.ThrowExceptionForHR(enumerator.GetCount(out count));

        for (int i = 0; i < count; i++) {
          IAudioSessionControl control;
          Marshal.ThrowExceptionForHR(enumerator.GetSession(i, out control));
          if (control == null) continue;

          IAudioSessionControl2 control2 = control as IAudioSessionControl2;
          ISimpleAudioVolume volume = control as ISimpleAudioVolume;
          if (control2 == null || volume == null) continue;

          AudioSessionState state = AudioSessionState.Inactive;
          try { control.GetState(out state); } catch { }

          uint pidRaw = 0;
          try { control2.GetProcessId(out pidRaw); } catch { }
          int pid = unchecked((int)pidRaw);

          string displayName = "";
          try { control.GetDisplayName(out displayName); } catch { displayName = ""; }

          string sessionIdentifier = "";
          try { control2.GetSessionIdentifier(out sessionIdentifier); } catch { sessionIdentifier = ""; }

          string sessionInstanceIdentifier = "";
          try { control2.GetSessionInstanceIdentifier(out sessionInstanceIdentifier); } catch { sessionInstanceIdentifier = ""; }

          float volumeRaw = 0f;
          try { volume.GetMasterVolume(out volumeRaw); } catch { }
          bool muted = false;
          try { volume.GetMute(out muted); } catch { }

          string processName = "";
          bool hasWindow = false;
          if (pid > 0) {
            try {
              Process process = Process.GetProcessById(pid);
              processName = process.ProcessName ?? "";
              hasWindow = process.MainWindowHandle != IntPtr.Zero;
            } catch {
              processName = "";
            }
          }
          if (string.IsNullOrWhiteSpace(processName)) {
            processName = GuessProcessNameFromIdentifier(sessionIdentifier);
          }
          if (string.IsNullOrWhiteSpace(processName) && pid == 0) {
            processName = "System";
          }

          string dedupeKey = !string.IsNullOrWhiteSpace(sessionInstanceIdentifier)
            ? "inst::" + sessionInstanceIdentifier.Trim()
            : !string.IsNullOrWhiteSpace(sessionIdentifier)
              ? "sess::" + sessionIdentifier.Trim()
              : string.Format("pid::{0}:{1}:{2}", pid, (processName ?? "").Trim().ToLowerInvariant(), i);
          if (!seen.Add(dedupeKey)) continue;

          int fallbackIndex = roleIndex * 10000 + i;
          result.Add(new SessionSnapshot {
            Pid = pid,
            ProcessName = processName ?? "",
            DisplayName = displayName ?? "",
            SessionIdentifier = sessionIdentifier ?? "",
            SessionInstanceIdentifier = sessionInstanceIdentifier ?? "",
            SessionKey = BuildSessionKey(pid, sessionIdentifier, sessionInstanceIdentifier, processName, fallbackIndex),
            State = state.ToString(),
            VolumePercent = Math.Round(Math.Max(0.0, Math.Min(1.0, volumeRaw)) * 100.0, 1),
            Muted = muted,
            HasWindow = hasWindow
          });
        }
      }

      return result;
    }

    public static bool SetVolume(int pid, string sessionKey, float level, out string message) {
      message = "";
      if (pid <= 0 && string.IsNullOrWhiteSpace(sessionKey)) {
        message = "pid oder sessionKey fehlt";
        return false;
      }

      float clamped = Math.Max(0f, Math.Min(1f, level));
      Guid context = Guid.Empty;
      int changed = 0;
      ERole[] roles = new ERole[] { ERole.eMultimedia, ERole.eConsole, ERole.eCommunications };

      for (int roleIndex = 0; roleIndex < roles.Length; roleIndex++) {
        IAudioSessionEnumerator enumerator = null;
        try {
          enumerator = CreateSessionEnumerator(roles[roleIndex]);
        } catch {
          continue;
        }

        int count = 0;
        Marshal.ThrowExceptionForHR(enumerator.GetCount(out count));

        for (int i = 0; i < count; i++) {
          IAudioSessionControl control;
          Marshal.ThrowExceptionForHR(enumerator.GetSession(i, out control));
          if (control == null) continue;

          IAudioSessionControl2 control2 = control as IAudioSessionControl2;
          ISimpleAudioVolume volume = control as ISimpleAudioVolume;
          if (control2 == null || volume == null) continue;

          uint pidRaw = 0;
          try { control2.GetProcessId(out pidRaw); } catch { }
          int currentPid = unchecked((int)pidRaw);

          string sessionIdentifier = "";
          try { control2.GetSessionIdentifier(out sessionIdentifier); } catch { sessionIdentifier = ""; }

          string sessionInstanceIdentifier = "";
          try { control2.GetSessionInstanceIdentifier(out sessionInstanceIdentifier); } catch { sessionInstanceIdentifier = ""; }

          string processName = "";
          if (currentPid > 0) {
            try {
              Process process = Process.GetProcessById(currentPid);
              processName = process.ProcessName ?? "";
            } catch {
              processName = "";
            }
          }
          if (string.IsNullOrWhiteSpace(processName)) {
            processName = GuessProcessNameFromIdentifier(sessionIdentifier);
          }

          int fallbackIndex = roleIndex * 10000 + i;
          if (!SessionMatchesTarget(currentPid, sessionIdentifier, sessionInstanceIdentifier, processName, fallbackIndex, pid, sessionKey)) continue;

          volume.SetMasterVolume(clamped, ref context);
          changed++;
        }
      }

      if (changed <= 0) {
        message = "Keine Session fuer Ziel gefunden";
        return false;
      }
      message = "OK";
      return true;
    }

    public static bool SetMute(int pid, string sessionKey, bool mute, out string message) {
      message = "";
      if (pid <= 0 && string.IsNullOrWhiteSpace(sessionKey)) {
        message = "pid oder sessionKey fehlt";
        return false;
      }

      Guid context = Guid.Empty;
      int changed = 0;
      ERole[] roles = new ERole[] { ERole.eMultimedia, ERole.eConsole, ERole.eCommunications };

      for (int roleIndex = 0; roleIndex < roles.Length; roleIndex++) {
        IAudioSessionEnumerator enumerator = null;
        try {
          enumerator = CreateSessionEnumerator(roles[roleIndex]);
        } catch {
          continue;
        }

        int count = 0;
        Marshal.ThrowExceptionForHR(enumerator.GetCount(out count));

        for (int i = 0; i < count; i++) {
          IAudioSessionControl control;
          Marshal.ThrowExceptionForHR(enumerator.GetSession(i, out control));
          if (control == null) continue;

          IAudioSessionControl2 control2 = control as IAudioSessionControl2;
          ISimpleAudioVolume volume = control as ISimpleAudioVolume;
          if (control2 == null || volume == null) continue;

          uint pidRaw = 0;
          try { control2.GetProcessId(out pidRaw); } catch { }
          int currentPid = unchecked((int)pidRaw);

          string sessionIdentifier = "";
          try { control2.GetSessionIdentifier(out sessionIdentifier); } catch { sessionIdentifier = ""; }

          string sessionInstanceIdentifier = "";
          try { control2.GetSessionInstanceIdentifier(out sessionInstanceIdentifier); } catch { sessionInstanceIdentifier = ""; }

          string processName = "";
          if (currentPid > 0) {
            try {
              Process process = Process.GetProcessById(currentPid);
              processName = process.ProcessName ?? "";
            } catch {
              processName = "";
            }
          }
          if (string.IsNullOrWhiteSpace(processName)) {
            processName = GuessProcessNameFromIdentifier(sessionIdentifier);
          }

          int fallbackIndex = roleIndex * 10000 + i;
          if (!SessionMatchesTarget(currentPid, sessionIdentifier, sessionInstanceIdentifier, processName, fallbackIndex, pid, sessionKey)) continue;

          volume.SetMute(mute, ref context);
          changed++;
        }
      }

      if (changed <= 0) {
        message = "Keine Session fuer Ziel gefunden";
        return false;
      }
      message = "OK";
      return true;
    }

    public static bool SendPlayPause(int pid, out string message) {
      message = "";
      IntPtr targetWindow = IntPtr.Zero;

      if (pid > 0) {
        try {
          Process process = Process.GetProcessById(pid);
          targetWindow = process.MainWindowHandle;
        } catch { }
      }

      if (targetWindow != IntPtr.Zero) {
        IntPtr lParam = new IntPtr(APPCOMMAND_MEDIA_PLAY_PAUSE << 16);
        bool posted = PostMessage(targetWindow, WM_APPCOMMAND, targetWindow, lParam);
        if (posted) {
          message = "APPCOMMAND gesendet";
          return true;
        }
      }

      // Fallback to global media key (active media session)
      keybd_event(VK_MEDIA_PLAY_PAUSE, 0, 0, 0);
      keybd_event(VK_MEDIA_PLAY_PAUSE, 0, KEYEVENTF_KEYUP, 0);
      message = "Globales Media Play/Pause gesendet";
      return true;
    }
  }
}
`;
const AUDIO_MIXER_BRIDGE_CSHARP_B64 = Buffer.from(AUDIO_MIXER_BRIDGE_CSHARP, "utf8").toString("base64");

function toPowerShellNumberLiteral(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(fallback);
  return String(num).replace(",", ".");
}

function audioMixerPowerShellScript(action = "snapshot", targetPid = 0, value = 0, flag = "", sessionKey = "") {
  const actionLit = toPowerShellSingleQuoted(String(action || ""));
  const targetPidLit = String(Number.isFinite(Number(targetPid)) ? Math.max(0, Math.trunc(Number(targetPid))) : 0);
  const valueLit = toPowerShellNumberLiteral(value, 0);
  const flagLit = toPowerShellSingleQuoted(String(flag || ""));
  const sessionKeyLit = toPowerShellSingleQuoted(String(sessionKey || ""));
  return `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not ("StreamDeckAudio.CoreAudioBridge" -as [type])) {
  $code = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${AUDIO_MIXER_BRIDGE_CSHARP_B64}'))
  Add-Type -Language CSharp -TypeDefinition $code
}

$action = ${actionLit}
$targetPid = [int]${targetPidLit}
$value = [double]${valueLit}
$flag = ${flagLit}
$sessionKey = [string]${sessionKeyLit}

if ($action -eq 'snapshot') {
  $sessions = @([StreamDeckAudio.CoreAudioBridge]::ListSessions())
  $spotify = $sessions | Where-Object { [string]$_.ProcessName -match '(?i)spotify' } | Select-Object -First 1
  [pscustomobject]@{
    ok = $true
    sessions = $sessions
    spotify = $spotify
  } | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

if ($action -eq 'setVolume') {
  $msg = ''
  $ok = [StreamDeckAudio.CoreAudioBridge]::SetVolume($targetPid, [string]$sessionKey, [float]([Math]::Max(0, [Math]::Min(100, $value)) / 100.0), [ref]$msg)
  [pscustomobject]@{
    ok = [bool]$ok
    message = [string]$msg
    pid = $targetPid
    sessionKey = [string]$sessionKey
    volumePercent = [Math]::Round([Math]::Max(0, [Math]::Min(100, $value)), 1)
  } | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

if ($action -eq 'setMute') {
  $mute = $false
  if ([string]$flag -match '^(1|true|yes|on)$') { $mute = $true }
  $msg = ''
  $ok = [StreamDeckAudio.CoreAudioBridge]::SetMute($targetPid, [string]$sessionKey, [bool]$mute, [ref]$msg)
  [pscustomobject]@{
    ok = [bool]$ok
    message = [string]$msg
    pid = $targetPid
    sessionKey = [string]$sessionKey
    muted = [bool]$mute
  } | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

if ($action -eq 'playPause') {
  $msg = ''
  $ok = [StreamDeckAudio.CoreAudioBridge]::SendPlayPause($targetPid, [ref]$msg)
  [pscustomobject]@{
    ok = [bool]$ok
    message = [string]$msg
    pid = $targetPid
  } | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

throw "unknown audio action: $action"
`;
}

function normalizeAudioSession(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pid = Number(raw.Pid ?? raw.pid ?? 0);
  const processName = safeTrim(raw.ProcessName ?? raw.processName ?? "", 120);
  const displayName = safeTrim(raw.DisplayName ?? raw.displayName ?? "", 160);
  const sessionIdentifier = safeTrim(raw.SessionIdentifier ?? raw.sessionIdentifier ?? "", 260);
  const sessionInstanceIdentifier = safeTrim(raw.SessionInstanceIdentifier ?? raw.sessionInstanceIdentifier ?? "", 260);
  const sessionKey = safeTrim(raw.SessionKey ?? raw.sessionKey ?? "", 360);
  const state = safeTrim(raw.State ?? raw.state ?? "", 40);
  const muted = Boolean(raw.Muted ?? raw.muted);
  const hasWindow = Boolean(raw.HasWindow ?? raw.hasWindow);
  const volumePercentRaw = Number(raw.VolumePercent ?? raw.volumePercent ?? 0);
  const volumePercent = Number.isFinite(volumePercentRaw)
    ? Math.max(0, Math.min(100, Math.round(volumePercentRaw * 10) / 10))
    : 0;
  if (!Number.isFinite(pid) || pid < 0) return null;
  if (!pid && !processName && !displayName && !sessionKey && !sessionIdentifier && !sessionInstanceIdentifier) return null;
  const normalizedSessionKey = sessionKey || sessionInstanceIdentifier || sessionIdentifier || "";
  return {
    pid: Math.trunc(pid),
    processName,
    displayName,
    sessionIdentifier,
    sessionInstanceIdentifier,
    sessionKey: normalizedSessionKey,
    state,
    volumePercent,
    muted,
    hasWindow
  };
}

const AUDIO_MIXER_CACHE_MS = 1200;
const audioMixerCache = { ts: 0, payload: null };

function clearAudioMixerCache() {
  audioMixerCache.ts = 0;
  audioMixerCache.payload = null;
}

async function readAudioMixerSnapshot(options = {}) {
  const useCache = options.useCache !== false;
  const now = Date.now();
  if (useCache && audioMixerCache.payload && now - audioMixerCache.ts < AUDIO_MIXER_CACHE_MS) {
    return audioMixerCache.payload;
  }

  if (process.platform !== "win32") {
    const fallback = {
      available: false,
      platform: process.platform,
      sessions: [],
      spotify: null
    };
    audioMixerCache.ts = now;
    audioMixerCache.payload = fallback;
    return fallback;
  }

  let parsed = null;
  try {
    parsed = await runPowerShellJson(audioMixerPowerShellScript("snapshot", 0, 0, ""), [], 25000);
  } catch (error) {
    const degraded = {
      available: false,
      platform: process.platform,
      sessions: [],
      spotify: null,
      error: safeTrim(error?.message || String(error), 240)
    };
    audioMixerCache.ts = now;
    audioMixerCache.payload = degraded;
    return degraded;
  }

  const list = Array.isArray(parsed?.sessions)
    ? parsed.sessions.map(normalizeAudioSession).filter(Boolean)
    : [];
  list.sort((a, b) => {
    const byName = String(a.processName || a.displayName).localeCompare(String(b.processName || b.displayName), "de", { sensitivity: "base" });
    if (byName !== 0) return byName;
    return a.pid - b.pid;
  });

  const spotify = list.find((x) => /spotify/i.test(`${x.processName} ${x.displayName}`)) || null;
  const payload = {
    available: true,
    platform: process.platform,
    sessions: list,
    spotify: spotify
      ? {
          pid: spotify.pid,
          sessionKey: spotify.sessionKey || spotify.sessionInstanceIdentifier || spotify.sessionIdentifier || "",
          processName: spotify.processName,
          displayName: spotify.displayName,
          muted: spotify.muted,
          volumePercent: spotify.volumePercent
        }
      : null
  };

  audioMixerCache.ts = now;
  audioMixerCache.payload = payload;
  return payload;
}

function sanitizeOptionalPid(value) {
  const pid = Number(value);
  if (!Number.isFinite(pid) || pid <= 0 || pid > 2_147_483_647) return 0;
  return Math.trunc(pid);
}

function sanitizeAudioSessionKey(value) {
  if (typeof value !== "string") return "";
  const key = safeTrim(value, 360);
  if (!key) return "";
  if (/[\r\n]/.test(key)) throw new Error("ungueltiger sessionKey");
  return key;
}

function sanitizeAudioSessionTarget(body = {}) {
  const pid = sanitizeOptionalPid(body?.pid);
  const sessionKey = sanitizeAudioSessionKey(body?.sessionKey);
  if (!pid && !sessionKey) throw new Error("ungueltiges Session-Ziel");
  return { pid, sessionKey };
}

function sanitizeVolumePercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error("ungueltige Lautstaerke");
  return Math.max(0, Math.min(100, Math.round(num * 10) / 10));
}

async function setAudioSessionVolume(pid, volumePercent, sessionKey = "") {
  if (process.platform !== "win32") throw new Error("Audio-Mixer ist nur unter Windows verfuegbar.");
  const parsed = await runPowerShellJson(
    audioMixerPowerShellScript("setVolume", pid || 0, volumePercent, "", sessionKey),
    [],
    20000
  );
  if (!parsed || parsed.ok !== true) throw new Error(parsed?.message || "Lautstaerke konnte nicht gesetzt werden");
  clearAudioMixerCache();
  return parsed;
}

async function setAudioSessionMute(pid, muted, sessionKey = "") {
  if (process.platform !== "win32") throw new Error("Audio-Mixer ist nur unter Windows verfuegbar.");
  const parsed = await runPowerShellJson(
    audioMixerPowerShellScript("setMute", pid || 0, 0, muted ? "true" : "false", sessionKey),
    [],
    20000
  );
  if (!parsed || parsed.ok !== true) throw new Error(parsed?.message || "Mute konnte nicht gesetzt werden");
  clearAudioMixerCache();
  return parsed;
}

async function sendAudioSessionPlayPause(pid) {
  if (process.platform !== "win32") throw new Error("Audio-Mixer ist nur unter Windows verfuegbar.");
  const parsed = await runPowerShellJson(
    audioMixerPowerShellScript("playPause", pid || 0, 0, ""),
    [],
    15000
  );
  if (!parsed || parsed.ok !== true) throw new Error(parsed?.message || "Play/Pause fehlgeschlagen");
  return parsed;
}

function openSpotifyApp() {
  startViaCmd("spotify:");
}

const processStatusCache = new Map();
async function isProcessRunning(imageName, options = {}) {
  const name = String(imageName || "").trim();
  if (!name) return false;

  const useCache = options.useCache !== false;
  const key = name.toLowerCase();
  const now = Date.now();
  if (useCache && processStatusCache.has(key)) {
    const cached = processStatusCache.get(key);
    if (cached && now - cached.ts < PROCESS_STATUS_CACHE_MS) return Boolean(cached.value);
  }

  let running = false;
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("tasklist", ["/FI", `IMAGENAME eq ${name}`], {
        windowsHide: true,
        timeout: 5000
      });
      const out = stdout.toLowerCase();
      running = !out.includes("no tasks are running") && out.includes(key);
    } catch {
      running = false;
    }
  }

  processStatusCache.set(key, { ts: now, value: running });
  if (processStatusCache.size > 64) {
    const cutoff = now - PROCESS_STATUS_CACHE_MS * 2;
    for (const [cacheKey, value] of processStatusCache.entries()) {
      if (!value || value.ts < cutoff) processStatusCache.delete(cacheKey);
    }
  }
  return running;
}

function clearProcessStatusCache(processNames = []) {
  if (!Array.isArray(processNames)) return;
  for (const name of processNames) {
    const key = String(name || "").trim().toLowerCase();
    if (key) processStatusCache.delete(key);
  }
}

async function detectRunningProcessName(processNames, options = {}) {
  const names = Array.isArray(processNames) ? processNames.map((x) => String(x || "").trim()).filter(Boolean) : [];
  for (const name of names) {
    if (await isProcessRunning(name, options)) return name;
  }
  return "";
}

async function getCurseForgeStatus(options = {}) {
  const processName = await detectRunningProcessName(CURSEFORGE_PROCESS_NAMES, options);
  const configuredPath = resolveLauncherPath("curseforge");
  const executablePath = resolveCurseForgeExecutablePath();
  return {
    configuredPath,
    executablePath,
    installed: Boolean(executablePath),
    running: Boolean(processName),
    processName: processName || ""
  };
}

function startCurseForgeProcess() {
  const executablePath = resolveCurseForgeExecutablePath();
  if (!executablePath) {
    throw new Error("CurseForge.exe nicht gefunden. Bitte in Einstellungen -> Launcher den CurseForge-Pfad setzen.");
  }
  startViaCmd(executablePath);
  clearProcessStatusCache(CURSEFORGE_PROCESS_NAMES);
  return executablePath;
}

function taskkillNotRunning(output) {
  const text = String(output || "").toLowerCase();
  return text.includes("not found")
    || text.includes("no tasks are running")
    || text.includes("keine tasks")
    || text.includes("konnte nicht gefunden werden")
    || text.includes("wurde nicht gefunden")
    || text.includes("keine laufende instanz");
}

async function stopCurseForgeProcesses() {
  const attempted = [...CURSEFORGE_PROCESS_NAMES];
  const stopped = [];
  const skipped = [];

  if (process.platform !== "win32") {
    throw new Error("CurseForge Prozesssteuerung ist nur unter Windows verfuegbar.");
  }

  if (DRY_RUN) {
    logger.info("dry-run curseforge stop skipped", { attempted });
    clearProcessStatusCache(CURSEFORGE_PROCESS_NAMES);
    return { attempted, stopped, skipped: attempted, dryRun: true };
  }

  for (const imageName of attempted) {
    try {
      await execFileAsync("taskkill", ["/IM", imageName, "/T", "/F"], { windowsHide: true, timeout: 10000 });
      stopped.push(imageName);
    } catch (error) {
      const details = `${String(error?.stdout || "")} ${String(error?.stderr || "")}`;
      if (taskkillNotRunning(details)) {
        skipped.push(imageName);
        continue;
      }
      throw new Error(`taskkill ${imageName} fehlgeschlagen: ${safeTrim(details.trim(), 260)}`);
    }
  }

  clearProcessStatusCache(CURSEFORGE_PROCESS_NAMES);
  return { attempted, stopped, skipped, dryRun: false };
}

const systemMetricsState = {
  cpuSample: null,
  network: {
    ts: 0,
    rxTotalBytes: 0,
    txTotalBytes: 0,
    rxBytesPerSec: 0,
    txBytesPerSec: 0,
    source: process.platform === "win32" ? "netstat" : "unsupported"
  }
};

function readCpuSample() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu && cpu.times ? cpu.times : {};
    const cpuTotal = (times.user || 0) + (times.nice || 0) + (times.sys || 0) + (times.idle || 0) + (times.irq || 0);
    total += cpuTotal;
    idle += (times.idle || 0);
  }
  return { idle, total, cores: cpus.length || 1 };
}

function readCpuUsagePercent() {
  const current = readCpuSample();
  const previous = systemMetricsState.cpuSample;
  systemMetricsState.cpuSample = current;
  if (!previous) return 0;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return 0;
  const usage = (1 - (idleDelta / totalDelta)) * 100;
  return Math.max(0, Math.min(100, usage));
}

function parseCounterNumber(text) {
  const digits = String(text || "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : 0;
}

function safeAddonFolderKey(value) {
  const key = safeTrim(value, 160);
  if (!key) throw new Error("addon key fehlt");
  if (key.includes("\0")) throw new Error("addon key ungueltig");
  if (/[\\/]/.test(key)) throw new Error("addon key darf keine Pfadtrenner enthalten");
  if (key.includes("..")) throw new Error("addon key ungueltig");
  return key;
}

function wowAddonsBaseDir() {
  const dir = expandEnv(String(config.wow?.folders?.addons || "").trim());
  if (!dir) throw new Error("WoW AddOns Ordner nicht konfiguriert");
  if (!dirExists(dir)) throw new Error(`WoW AddOns Ordner nicht gefunden: ${dir}`);
  return dir;
}

function parseAddonTitle(folderPath, folderName) {
  const preferred = path.join(folderPath, `${folderName}.toc`);
  const candidates = [];
  if (fileExists(preferred)) candidates.push(preferred);
  try {
    const other = fs
      .readdirSync(folderPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".toc"))
      .map((entry) => path.join(folderPath, entry.name));
    candidates.push(...other);
  } catch {
    // ignore TOC scan failures
  }

  for (const tocPath of candidates) {
    try {
      const lines = fs.readFileSync(tocPath, "utf8").split(/\r?\n/).slice(0, 120);
      for (const line of lines) {
        const m = String(line || "").match(/^##\s*Title\s*:\s*(.+)$/i);
        if (!m) continue;
        const title = safeTrim(m[1].replace(/\|c[0-9a-fA-F]{8}/g, "").replace(/\|r/g, ""), 120);
        if (title) return title;
      }
    } catch {
      // ignore malformed toc files
    }
  }
  return "";
}

function listWowAddons() {
  const baseDir = wowAddonsBaseDir();
  let entries = [];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const items = [];
  for (const entry of entries) {
    if (!entry || !entry.isDirectory()) continue;
    const folderKey = safeTrim(entry.name, 160);
    if (!folderKey || folderKey.startsWith(".")) continue;
    const disabled = /\.disabled$/i.test(folderKey);
    const displayName = disabled ? folderKey.replace(/\.disabled$/i, "") : folderKey;
    const folderPath = path.join(baseDir, folderKey);
    const title = parseAddonTitle(folderPath, displayName) || displayName;

    items.push({
      key: folderKey,
      folder: folderKey,
      name: displayName,
      title,
      enabled: !disabled
    });
  }

  items.sort((a, b) => a.title.localeCompare(b.title, "de", { sensitivity: "base" }));
  return { baseDir, items };
}

function detectWowAddonCapabilitiesFromList(items = []) {
  const normalized = Array.isArray(items)
    ? items.map((item) => ({
        key: String(item?.key || "").toLowerCase(),
        name: String(item?.name || "").toLowerCase(),
        title: String(item?.title || "").toLowerCase(),
        enabled: item?.enabled === true
      }))
    : [];
  const matchAny = (patterns = []) => normalized.some((item) => {
    const text = `${item.key} ${item.name} ${item.title}`;
    return patterns.some((pattern) => text.includes(pattern));
  });
  const isTomTomInstalled = matchAny(["tomtom"]);
  const isQuestieInstalled = matchAny(["questie"]);
  const isStreamDeckNavigatorInstalled = matchAny(["streamdecknavigator", "stream deck navigator", "sdnavigator"]);
  return {
    isTomTomInstalled,
    isQuestieInstalled,
    isStreamDeckNavigatorInstalled
  };
}

async function getWowNavigatorStatus(options = {}) {
  const wowRunning = await isProcessRunning(config.wow.processName, options);
  const base = {
    wowRunning,
    processName: config.wow.processName,
    addonsAvailable: false,
    addonsBaseDir: expandEnv(String(config.wow?.folders?.addons || "").trim()),
    addonsError: "",
    addonsCount: 0,
    isTomTomInstalled: false,
    isQuestieInstalled: false,
    isStreamDeckNavigatorInstalled: false
  };

  try {
    const data = listWowAddons();
    const caps = detectWowAddonCapabilitiesFromList(data.items);
    return {
      ...base,
      addonsAvailable: true,
      addonsBaseDir: data.baseDir,
      addonsCount: Array.isArray(data.items) ? data.items.length : 0,
      ...caps
    };
  } catch (error) {
    return {
      ...base,
      addonsError: safeTrim(error?.message || String(error), 220)
    };
  }
}

function parseCoordValue(input) {
  const raw = String(input || "").trim().replace(",", ".");
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  return Math.round(value * 10) / 10;
}

function extractFirstCoordinatePair(text) {
  const raw = String(text || "");
  const match = raw.match(/(\d{1,2}(?:[.,]\d+)?)\s*[,/]\s*(\d{1,2}(?:[.,]\d+)?)/);
  if (!match) return null;
  const x = parseCoordValue(match[1]);
  const y = parseCoordValue(match[2]);
  if (x == null || y == null) return null;
  return { x, y };
}

function sanitizeQuestStep(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = safeTrim(raw.title || raw.name || "", 120);
  const details = safeTrim(raw.details || raw.reason || raw.description || "", 360);
  if (!title && !details) return null;
  return {
    title: title || "Empfehlung",
    details
  };
}

function normalizeWaypointItem(raw, fallbackZone = "") {
  if (!raw || typeof raw !== "object") return null;
  const zone = safeTrim(raw.zone || fallbackZone || "", 80);
  const note = safeTrim(raw.note || raw.label || raw.title || "", 120);
  const x = parseCoordValue(raw.x);
  const y = parseCoordValue(raw.y);
  if (x == null || y == null) return null;
  const xText = x.toFixed(1);
  const yText = y.toFixed(1);
  const noteSuffix = note ? ` ${note}` : "";
  const tomtomCommand = zone
    ? `/way ${zone} ${xText} ${yText}${noteSuffix}`
    : `/way ${xText} ${yText}${noteSuffix}`;
  const streamDeckNavigatorCommand = `/sdnav ${xText} ${yText}${noteSuffix}`;
  return {
    zone,
    x,
    y,
    note,
    tomtomCommand,
    streamDeckNavigatorCommand
  };
}

function sanitizeWowAssistantRequest(body = {}) {
  const question = safeTrim(body?.question || "", 800);
  if (!question) throw new Error("frage fehlt");

  const ctx = body?.context && typeof body.context === "object" ? body.context : {};
  const levelNum = Number(ctx.level);
  const level = Number.isFinite(levelNum) ? Math.max(1, Math.min(80, Math.trunc(levelNum))) : 0;

  return {
    question,
    context: {
      characterName: safeTrim(ctx.characterName || "", 64),
      className: safeTrim(ctx.className || "", 40),
      faction: safeTrim(ctx.faction || "", 24),
      zone: safeTrim(ctx.zone || "", 80),
      objective: safeTrim(ctx.objective || "", 220),
      level,
      expansion: safeTrim(ctx.expansion || "", 40)
    }
  };
}

function buildLocalWowAssistantResponse(input, navStatus) {
  const question = input.question;
  const zone = input.context.zone || "aktuelle Zone";
  const level = input.context.level || 0;
  const hasTomTom = navStatus.isTomTomInstalled === true;
  const hasQuestie = navStatus.isQuestieInstalled === true;

  const nextSteps = [];
  if (hasQuestie) {
    nextSteps.push({
      title: "Questie Pins nutzen",
      details: "Oeffne die Weltkarte und aktiviere die Questie-Filter fuer deine aktive Questkette."
    });
  } else {
    nextSteps.push({
      title: "Questie installieren",
      details: "Questie zeigt Questziele direkt auf Karte/Minimap und spart viel Suchzeit."
    });
  }
  if (hasTomTom) {
    nextSteps.push({
      title: "TomTom Waypoints setzen",
      details: "Nutze die erzeugten /way Befehle fuer direkte Marker-Navigation."
    });
  } else {
    nextSteps.push({
      title: "TomTom fuer Navigation",
      details: "Mit TomTom bekommst du Pfeil-Navigation und Distanzanzeige zu Koordinaten."
    });
  }

  if (level > 0) {
    nextSteps.push({
      title: `Level-${level} Route fokusieren`,
      details: "Priorisiere eng beieinander liegende Quests und gib lange Laufwege nur als Nebenroute frei."
    });
  } else {
    nextSteps.push({
      title: "Route in Blöcken planen",
      details: "Gruppiere Quests nach Gebietsteilen, damit du nicht zwischen Nord/Sued pendelst."
    });
  }

  const waypoints = [];
  const coord = extractFirstCoordinatePair(question);
  if (coord) {
    const wp = normalizeWaypointItem(
      { zone, x: coord.x, y: coord.y, note: "Ziel aus deiner Eingabe" },
      zone
    );
    if (wp) waypoints.push(wp);
  }

  return {
    provider: "local-fallback",
    model: "",
    answer: safeTrim(
      `Ich habe eine sichere Komfort-Route fuer ${zone} erstellt. Fokus: kurze Laufwege, klare Questreihenfolge und optionale Waypoints ohne Automatisierung/Cheat.`,
      1200
    ),
    safety: "Kein Cheat: nur Empfehlungen, Marker-Befehle und manuelle Navigation.",
    nextSteps,
    waypoints,
    contextEcho: input.context
  };
}

function normalizeAssistantModelResponse(raw, input, provider, model) {
  const fallback = buildLocalWowAssistantResponse(input, {
    isTomTomInstalled: false,
    isQuestieInstalled: false,
    isStreamDeckNavigatorInstalled: false
  });
  if (!raw || typeof raw !== "object") return { ...fallback, provider, model };

  const nextSteps = Array.isArray(raw.nextSteps)
    ? raw.nextSteps.map(sanitizeQuestStep).filter(Boolean).slice(0, 8)
    : [];
  const waypoints = Array.isArray(raw.waypoints)
    ? raw.waypoints.map((wp) => normalizeWaypointItem(wp, input.context.zone)).filter(Boolean).slice(0, 10)
    : [];

  return {
    provider,
    model,
    answer: safeTrim(raw.answer || raw.summary || fallback.answer, 1800),
    safety: safeTrim(raw.safety || fallback.safety, 240),
    nextSteps: nextSteps.length ? nextSteps : fallback.nextSteps,
    waypoints,
    contextEcho: input.context
  };
}

async function queryOpenAiWowAssistant(input, navStatus) {
  const apiKey = aiRuntimeState.apiKey;
  const model = getAiAssistantModel();
  if (!apiKey) throw new Error("AI key fehlt");
  if (typeof fetch !== "function") throw new Error("fetch ist in dieser Node-Version nicht verfuegbar");

  const systemPrompt = [
    "Du bist ein WoW Quest Assistant fuer Classic/Anniversary.",
    "Regeln:",
    "- Nur Komfort-Hilfe, keine Cheats, keine Bot/Automation-Anweisungen.",
    "- Antworte als JSON Objekt ohne Markdown.",
    "- JSON Schema: {\"answer\":string,\"safety\":string,\"nextSteps\":[{\"title\":string,\"details\":string}],\"waypoints\":[{\"zone\":string,\"x\":number,\"y\":number,\"note\":string}]}",
    "- waypoints nur mit x/y im Bereich 0..100."
  ].join("\n");

  const userPayload = {
    question: input.question,
    context: input.context,
    wowStatus: {
      wowRunning: navStatus.wowRunning,
      tomtomInstalled: navStatus.isTomTomInstalled,
      questieInstalled: navStatus.isQuestieInstalled,
      streamDeckNavigatorInstalled: navStatus.isStreamDeckNavigatorInstalled
    }
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 700,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) }
      ]
    })
  });

  if (!response.ok) {
    const text = safeTrim(await response.text().catch(() => ""), 260);
    throw new Error(`OpenAI Fehler ${response.status}: ${text || "request failed"}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("AI Antwort leer");
  }
  return parseJsonPayload(content);
}

async function buildWowAssistantResponse(input, navStatus) {
  if (!hasAiAssistantKey()) {
    return buildLocalWowAssistantResponse(input, navStatus);
  }

  try {
    const raw = await queryOpenAiWowAssistant(input, navStatus);
    return normalizeAssistantModelResponse(raw, input, "openai", getAiAssistantModel());
  } catch (error) {
    logger.warn("wow assistant fallback", { error: safeTrim(error?.message || String(error), 260) });
    return buildLocalWowAssistantResponse(input, navStatus);
  }
}

function sanitizeAiModel(value) {
  const model = safeTrim(value || "", 80);
  if (!model) return DEFAULT_AI_MODEL;
  if (/[\r\n]/.test(model)) throw new Error("ungueltiges ai model");
  return model;
}

function sanitizeAiApiKey(value) {
  const key = safeTrim(value || "", 256);
  if (!key) return "";
  if (/[\r\n]/.test(key)) throw new Error("ungueltiger api key");
  if (key.length < 20) throw new Error("api key zu kurz");
  return key;
}

async function verifyOpenAiApiKey(apiKey) {
  if (typeof fetch !== "function") throw new Error("fetch nicht verfuegbar");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal
    });
    if (!response.ok) {
      const text = safeTrim(await response.text().catch(() => ""), 260);
      throw new Error(`OpenAI Verifizierung fehlgeschlagen (${response.status})${text ? `: ${text}` : ""}`);
    }
    const body = await response.json().catch(() => null);
    const modelIds = Array.isArray(body?.data)
      ? body.data.map((item) => safeTrim(item?.id || "", 80)).filter(Boolean)
      : [];
    return {
      ok: true,
      modelCount: modelIds.length
    };
  } catch (error) {
    if (String(error?.name || "") === "AbortError") {
      throw new Error("OpenAI Verifizierung Timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function toggleWowAddonState(key, shouldEnable) {
  const baseDir = wowAddonsBaseDir();
  const fromKey = safeAddonFolderKey(key);
  const fromPath = path.join(baseDir, fromKey);
  if (!dirExists(fromPath)) throw new Error(`Addon nicht gefunden: ${fromKey}`);

  const isDisabled = /\.disabled$/i.test(fromKey);
  let targetKey = fromKey;
  if (shouldEnable && isDisabled) targetKey = fromKey.replace(/\.disabled$/i, "");
  if (!shouldEnable && !isDisabled) targetKey = `${fromKey}.disabled`;
  if (targetKey === fromKey) return { fromKey, toKey: targetKey, changed: false };

  const toPath = path.join(baseDir, targetKey);
  if (dirExists(toPath)) {
    throw new Error(`Ziel existiert bereits: ${targetKey}`);
  }
  fs.renameSync(fromPath, toPath);
  return { fromKey, toKey: targetKey, changed: true };
}

async function readWindowsNetworkTotals() {
  const { stdout } = await execFileAsync("netstat", ["-e"], { windowsHide: true, timeout: 5000 });
  const line = String(stdout || "")
    .split(/\r?\n/)
    .find((x) => /^\s*bytes\b/i.test(String(x || "").trim()));
  if (!line) return null;
  const parts = String(line).trim().split(/\s+/);
  if (parts.length < 3) return null;
  const rx = parseCounterNumber(parts[1]);
  const tx = parseCounterNumber(parts[2]);
  if (!Number.isFinite(rx) || !Number.isFinite(tx)) return null;
  return { rxTotalBytes: rx, txTotalBytes: tx };
}

async function readNetworkMetrics() {
  if (process.platform !== "win32") {
    return {
      rxTotalBytes: 0,
      txTotalBytes: 0,
      rxBytesPerSec: 0,
      txBytesPerSec: 0,
      source: "unsupported"
    };
  }

  const now = Date.now();
  const cached = systemMetricsState.network;
  if (cached.ts && (now - cached.ts) < NET_METRICS_CACHE_MS) {
    return {
      rxTotalBytes: cached.rxTotalBytes,
      txTotalBytes: cached.txTotalBytes,
      rxBytesPerSec: cached.rxBytesPerSec,
      txBytesPerSec: cached.txBytesPerSec,
      source: cached.source
    };
  }

  let totals = null;
  try {
    totals = await readWindowsNetworkTotals();
  } catch {
    totals = null;
  }
  if (!totals) {
    return {
      rxTotalBytes: cached.rxTotalBytes,
      txTotalBytes: cached.txTotalBytes,
      rxBytesPerSec: 0,
      txBytesPerSec: 0,
      source: "netstat-unavailable"
    };
  }

  let rxBytesPerSec = 0;
  let txBytesPerSec = 0;
  if (cached.ts && totals.rxTotalBytes >= cached.rxTotalBytes && totals.txTotalBytes >= cached.txTotalBytes) {
    const dtSec = Math.max(0.2, (now - cached.ts) / 1000);
    rxBytesPerSec = Math.max(0, (totals.rxTotalBytes - cached.rxTotalBytes) / dtSec);
    txBytesPerSec = Math.max(0, (totals.txTotalBytes - cached.txTotalBytes) / dtSec);
  }

  systemMetricsState.network = {
    ts: now,
    rxTotalBytes: totals.rxTotalBytes,
    txTotalBytes: totals.txTotalBytes,
    rxBytesPerSec,
    txBytesPerSec,
    source: "netstat"
  };

  return {
    rxTotalBytes: totals.rxTotalBytes,
    txTotalBytes: totals.txTotalBytes,
    rxBytesPerSec,
    txBytesPerSec,
    source: "netstat"
  };
}

async function collectSystemMetrics() {
  const cpuUsagePercent = readCpuUsagePercent();
  const cpu = os.cpus();
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const usagePercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  const network = await readNetworkMetrics();
  const mem = process.memoryUsage();

  return {
    system: {
      hostname: os.hostname(),
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      uptimeSec: Math.floor(os.uptime())
    },
    cpu: {
      usagePercent: Math.max(0, Math.min(100, cpuUsagePercent)),
      cores: cpu.length || 1
    },
    memory: {
      totalBytes,
      usedBytes,
      freeBytes,
      usagePercent: Math.max(0, Math.min(100, usagePercent))
    },
    network,
    process: {
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
      rssBytes: mem.rss || 0,
      heapUsedBytes: mem.heapUsed || 0,
      nodeVersion: process.version
    }
  };
}

const iconCache = new Map();
async function extractIconDataUrl(filePath) {
  const p = String(filePath || "").trim();
  if (!p || !fileExists(p)) return "";
  const key = p.toLowerCase();
  if (iconCache.has(key)) return iconCache.get(key);

  const pathLit = toPowerShellSingleQuoted(p);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$p = ${pathLit}`,
    "Add-Type -AssemblyName System.Drawing",
    "if (-not (Test-Path -LiteralPath $p)) { exit 2 }",
    "function Convert-IconToBase64([System.Drawing.Icon]$icon) {",
    "  if ($null -eq $icon) { return '' }",
    "  $bmp = New-Object System.Drawing.Bitmap 64,64",
    "  $g = [System.Drawing.Graphics]::FromImage($bmp)",
    "  $g.Clear([System.Drawing.Color]::Transparent)",
    "  $src = $icon.ToBitmap()",
    "  $g.DrawImage($src, 0, 0, 64, 64)",
    "  $g.Dispose()",
    "  $src.Dispose()",
    "  $ms = New-Object System.IO.MemoryStream",
    "  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
    "  $bmp.Dispose()",
    "  $icon.Dispose()",
    "  $result = [Convert]::ToBase64String($ms.ToArray())",
    "  $ms.Dispose()",
    "  return $result",
    "}",
    "$icon = $null",
    "try { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($p) } catch {}",
    "if ($null -eq $icon -and [System.IO.Path]::GetExtension($p).ToLowerInvariant() -eq '.lnk') {",
    "  try {",
    "    $shell = New-Object -ComObject WScript.Shell",
    "    $shortcut = $shell.CreateShortcut($p)",
    "    if ($shortcut.TargetPath -and (Test-Path -LiteralPath $shortcut.TargetPath)) {",
    "      $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($shortcut.TargetPath)",
    "    }",
    "  } catch {}",
    "}",
    "$b64 = Convert-IconToBase64 $icon",
    "if (-not $b64) { exit 3 }",
    "$b64"
  ].join("; ");

  try {
    const b64 = await runPowerShell(script, [], 5000);
    if (!b64) return "";
    const data = `data:image/png;base64,${b64}`;
    iconCache.set(key, data);
    return data;
  } catch {
    return "";
  }
}

function tileIsVisible(tile, wowRunning) {
  if (!tile.showIf) return true;
  if (tile.showIf === "wowRunning") return wowRunning === true;
  if (tile.showIf === "wowNotRunning") return wowRunning === false;
  return true;
}

function defaultTileEmoji(type) {
  const normalized = String(type || "").trim().toLowerCase();
  if (normalized === "app") return "🖥️";
  if (normalized === "folder") return "📁";
  if (normalized === "url") return "🌐";
  if (normalized === "protocol") return "🔗";
  if (normalized === "action") return "⚡";
  return "■";
}

async function buildClientTiles(options = {}) {
  const useCache = options.useCache !== false;
  const wowRunning = await isProcessRunning(config.wow.processName);
  const now = Date.now();
  if (
    useCache
    && clientTilesCache.payload
    && clientTilesCache.revision === configRevision
    && clientTilesCache.wowRunning === wowRunning
    && (now - clientTilesCache.ts) < CLIENT_TILES_CACHE_MS
  ) {
    return clientTilesCache.payload;
  }

  const list = [];

  for (const tile of config.tiles) {
    if (!tileIsVisible(tile, wowRunning)) continue;

    const out = {
      id: tile.id,
      profile: tile.profile,
      page: tile.page || "main",
      label: tile.label,
      subtitle: tile.subtitle || "",
      type: tile.type,
      builtin: Boolean(tile.builtin),
      iconMode: tile.iconMode || "emoji",
      icon: tile.icon || defaultTileEmoji(tile.type),
      iconData: "",
      action: tile.type === "action" ? (tile.action || "") : ""
    };

    if (tile.iconMode === "image" && tile.iconData) {
      out.iconData = tile.iconData;
    } else if (tile.iconMode === "auto" || (!tile.icon && tile.type === "app")) {
      out.iconData = await extractIconDataUrl(resolveTileTarget(tile));
    }

    list.push(out);
  }

  const payload = { wowRunning, tiles: list };
  clientTilesCache.ts = now;
  clientTilesCache.revision = configRevision;
  clientTilesCache.wowRunning = wowRunning;
  clientTilesCache.payload = payload;
  return payload;
}

function sanitizeCustomTile(input, existing) {
  const raw = input && typeof input === "object" ? input : {};
  const id = existing
    ? existing.id
    : safeTrim(raw.id || `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, 96);
  const profile = safeTrim(raw.profile || existing?.profile || "", 64);
  const page = safeTrim(raw.page || existing?.page || "main", 64);
  const label = safeTrim(raw.label || existing?.label || "", 80);
  const type = safeTrim(raw.type || existing?.type || "", 32);
  if (!id || !profile || !page || !label || !type) throw new Error("Tile Daten unvollstaendig");
  if (!TILE_TYPES.has(type)) throw new Error("Tile Typ nicht erlaubt");

  const tile = {
    id,
    profile,
    page,
    label,
    subtitle: safeTrim(raw.subtitle, 140),
    type,
    builtin: false,
    iconMode: ICON_MODES.has(raw.iconMode) ? raw.iconMode : "emoji",
    icon: safeTrim(raw.icon, 12),
    iconData: typeof raw.iconData === "string" ? raw.iconData : ""
  };

  if (tile.iconData.length > MAX_ICON_DATA_URL_LEN) throw new Error("Icon zu gross");
  if (typeof raw.target === "string" && raw.target.trim()) tile.target = assertSafeInput(raw.target, "target");
  if (typeof raw.launcherKey === "string" && raw.launcherKey.trim()) tile.launcherKey = safeTrim(raw.launcherKey, 64);
  if (typeof raw.action === "string" && raw.action.trim()) tile.action = safeTrim(raw.action, 64);
  if (Array.isArray(raw.args)) tile.args = safeArray(raw.args, 512, 16);
  if (typeof raw.startIn === "string" && raw.startIn.trim()) tile.startIn = assertSafeInput(raw.startIn, "startIn");

  const normalized = normalizeTile(tile);
  if (!normalized || normalized.builtin) throw new Error("ungueltige Tile Daten");
  const profileDef = config.profiles.find((p) => p.id === normalized.profile);
  if (!profileDef) throw new Error("Profil nicht gefunden");
  if (!Array.isArray(profileDef.pages) || !profileDef.pages.some((p) => p.id === normalized.page)) {
    throw new Error("Seite nicht gefunden");
  }
  if (normalized.launcherKey && !config.launchers?.[normalized.launcherKey]) {
    throw new Error("Launcher nicht gefunden");
  }

  if (normalized.type === "app" && !normalized.launcherKey) {
    const split = splitLaunchTargetInput(String(normalized.target || "").trim());
    const requested = split.command || unquoteWrapped(String(normalized.target || "").trim());
    if (!requested) throw new Error("Programmziel fehlt");
    if (hasTemplateSyntax(requested)) throw new Error("Template-Pfade sind fuer App-Tiles nicht erlaubt");
    if (split.args.length) {
      normalized.args = safeArray([...(normalized.args || []), ...split.args], 512, 16);
    }
    const expanded = expandEnv(requested);
    if (looksLikePath(expanded)) {
      if (fileExists(expanded) && isAppLaunchFilePath(expanded)) {
        normalized.target = expanded;
      } else {
        // Keep unresolved path-like targets so users can save portable/custom app paths.
        normalized.target = expanded;
      }
    } else {
      const resolved = resolveProgramPath(expanded);
      if (!resolved) {
        throw new Error("Programmname nicht eindeutig. Nutze einen exakten Pfad oder waehle einen Treffer aus der Programmsuche.");
      }
      normalized.target = resolved;
    }
  }

  if (normalized.type === "folder") {
    const requested = String(normalized.target || "").trim();
    if (!requested) throw new Error("Ordnerziel fehlt");
    if (!hasTemplateSyntax(requested)) {
      const expanded = expandEnv(requested);
      if (!dirExists(expanded)) throw new Error(`Ordner nicht gefunden: ${expanded}`);
      normalized.target = expanded;
    }
  }

  if (normalized.type === "app" && normalized.startIn) {
    if (hasTemplateSyntax(normalized.startIn)) throw new Error("Template-Startordner sind nicht erlaubt");
    const expanded = expandEnv(normalized.startIn);
    if (!dirExists(expanded)) throw new Error(`Startordner nicht gefunden: ${expanded}`);
    normalized.startIn = expanded;
  }

  return normalized;
}

async function browsePath(kind, title) {
  const useKind = kind === "folder" ? "folder" : "file";
  const prompt = String(title || (useKind === "folder" ? "Ordner waehlen" : "Datei waehlen"));
  const promptLit = toPowerShellSingleQuoted(prompt);

  if (useKind === "folder") {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "if (-not [Environment]::UserInteractive) { throw 'not interactive desktop' }",
      "Add-Type -AssemblyName System.Windows.Forms",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$d.Description = ${promptLit}`,
      "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }"
    ].join("; ");
    return runPowerShell(script, [], 15000, { sta: true });
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "if (-not [Environment]::UserInteractive) { throw 'not interactive desktop' }",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$d = New-Object System.Windows.Forms.OpenFileDialog",
    `$d.Title = ${promptLit}`,
    "$d.Filter = 'Programme (*.exe;*.lnk)|*.exe;*.lnk|Alle Dateien (*.*)|*.*'",
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName }"
  ].join("; ");
  return runPowerShell(script, [], 15000, { sta: true });
}

function normalizeBrowseFailure(error) {
  const raw = [
    error?.message ? String(error.message) : "",
    error?.stderr ? String(error.stderr) : "",
    error?.stdout ? String(error.stdout) : ""
  ]
    .filter(Boolean)
    .join(" | ")
    .replace(/\r?\n+/g, " ")
    .trim();

  if (/timed out|timeout|etimedout/i.test(raw)) {
    return "Datei-Dialog nicht verfuegbar oder wurde geschlossen. Pfad bitte manuell eintragen.";
  }
  if (/access is denied|zugriff verweigert/i.test(raw)) {
    return "Datei-Dialog blockiert (Zugriff verweigert). Pfad bitte manuell eintragen.";
  }
  if (/not interactive desktop|single thread apartment|apartmentstate/i.test(raw)) {
    return "Datei-Dialog nicht verfuegbar (kein interaktiver Desktop/STA). Pfad bitte manuell eintragen.";
  }
  if (!raw) return "Datei-Dialog nicht verfuegbar. Pfad bitte manuell eintragen.";
  return `Datei-Dialog fehlgeschlagen. Pfad bitte manuell eintragen. (${safeTrim(raw, 220)})`;
}

function toPowerShellSingleQuoted(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

const app = express();
app.disable("x-powered-by");
app.use(setSecurityHeaders);
app.use(express.json({ limit: "6mb" }));
app.use(express.static(PUBLIC_DIR, {
  etag: true,
  maxAge: "1h",
  setHeaders: (res, filePath) => {
    if (String(filePath || "").toLowerCase().endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store");
    }
  }
}));
app.use((req, res, next) => {
  const requestId = makeRequestId();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
});
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api", (req, res, next) => {
  const startedAtNs = process.hrtime.bigint();
  apiMetricsState.active += 1;
  let settled = false;
  const finalize = () => {
    if (settled) return;
    settled = true;
    apiMetricsState.active = Math.max(0, apiMetricsState.active - 1);
    const durationMs = Number(process.hrtime.bigint() - startedAtNs) / 1_000_000;
    recordApiRequestMetrics(req, res.statusCode, durationMs);

    const p = sanitizeUrlForLog(req.originalUrl || req.url || "");
    if (
      p.startsWith("/api/health")
      || p.startsWith("/api/status")
      || p.startsWith("/api/system/metrics")
      || p.startsWith("/api/curseforge/status")
      || p.startsWith("/api/audio/mixer")
      || p.startsWith("/api/wow/navigator/status")
    ) return;
    logger.info("api request", {
      requestId: req.requestId,
      method: req.method,
      path: p,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      ip: req.ip || req.socket?.remoteAddress || ""
    });
  };
  res.on("finish", finalize);
  res.on("close", finalize);
  next();
});

function readTokenFromRequest(req) {
  const header = safeTrim(req.header("x-token"), 512);
  const query = typeof req.query?.token === "string" ? safeTrim(req.query.token, 512) : "";
  return header || query;
}

function requireToken(req, res, next) {
  const token = readTokenFromRequest(req);
  if (!token) return res.status(401).json({ ok: false, error: "unauthorized: missing token" });
  if (!secureEqualText(token, config.token)) return res.status(401).json({ ok: false, error: "unauthorized: token mismatch" });
  next();
}

const rateState = new Map();
const rateMetrics = { allowed: 0, blocked: 0, sweeps: 0 };
let rateSweepCounter = 0;
function rateLimitCostForPath(rawPath) {
  const p = String(rawPath || "").toLowerCase();
  if (p.startsWith("/api/wow/assistant")) return 4;
  if (p.startsWith("/api/icon") || p.startsWith("/api/stream/live")) return 3;
  if (
    p.startsWith("/api/system/metrics")
    || p.startsWith("/api/audio/mixer")
    || p.startsWith("/api/bootstrap")
  ) return 2;
  return 1;
}

function rateClientKey(req) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const token = readTokenFromRequest(req);
  if (!token) return ip;
  const tokenHash = crypto.createHash("sha1").update(token).digest("hex").slice(0, 12);
  return `${ip}|${tokenHash}`;
}

function rateLimit(req, res, next) {
  const windowMs = Math.max(250, Number(config.rateLimit?.windowMs || 3000));
  const max = Math.max(3, Number(config.rateLimit?.max || 20));
  const now = Date.now();
  const key = rateClientKey(req);
  const cost = rateLimitCostForPath(req.path || req.url || "");
  const state = rateState.get(key) || { t0: now, n: 0, hits: 0, blocked: 0 };
  if (now - state.t0 > windowMs) {
    state.t0 = now;
    state.n = 0;
  }
  state.n += cost;
  state.hits += 1;
  rateState.set(key, state);
  rateSweepCounter += 1;
  if (rateSweepCounter >= 200 || rateState.size > 5000) {
    rateSweepCounter = 0;
    const cutoff = now - (windowMs * 4);
    for (const [entryKey, value] of rateState.entries()) {
      if (!value || value.t0 < cutoff) rateState.delete(entryKey);
    }
    rateMetrics.sweeps += 1;
  }

  const resetMs = Math.max(0, (state.t0 + windowMs) - now);
  const resetSec = Math.max(1, Math.ceil(resetMs / 1000));
  const remaining = Math.max(0, Math.floor(max - state.n));
  res.setHeader("X-RateLimit-Limit", String(max));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(resetSec));

  req.rateLimitInfo = { max, remaining, resetSec, cost };
  if (state.n > max) {
    state.blocked += 1;
    rateMetrics.blocked += 1;
    res.setHeader("Retry-After", String(resetSec));
    return res.status(429).json({ ok: false, error: "rate limited" });
  }
  rateMetrics.allowed += 1;
  next();
}

const LIVE_STREAM_CHANNELS = new Set(["status", "metrics", "audio", "wow", "curseforge", "runs"]);

function parseLiveStreamChannels(rawValue) {
  const raw = safeTrim(rawValue || "", 200).toLowerCase();
  if (!raw || raw === "default") return ["status", "metrics"];
  if (raw === "all") return Array.from(LIVE_STREAM_CHANNELS.values());
  const picked = uniq(raw.split(",").map((x) => String(x || "").trim().toLowerCase()))
    .filter((x) => LIVE_STREAM_CHANNELS.has(x));
  return picked.length ? picked : ["status", "metrics"];
}

function parseLiveStreamIntervalMs(rawValue) {
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return 1500;
  return Math.max(500, Math.min(15000, Math.trunc(n)));
}

function writeSseEvent(res, eventName, data) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function withLiveSnapshotField(payload, key, producer) {
  try {
    payload[key] = await producer();
  } catch (error) {
    payload[key] = { error: safeTrim(error?.message || String(error), 220) };
  }
}

async function buildLiveSnapshot(channels = []) {
  const picked = new Set(Array.isArray(channels) ? channels : []);
  const payload = {
    ts: Date.now(),
    serverVersion: APP_VERSION
  };
  const tasks = [];
  if (picked.has("status")) {
    tasks.push(withLiveSnapshotField(payload, "status", async () => ({
      wowRunning: await isProcessRunning(config.wow.processName),
      processName: config.wow.processName
    })));
  }
  if (picked.has("metrics")) {
    tasks.push(withLiveSnapshotField(payload, "metrics", async () => collectSystemMetrics()));
  }
  if (picked.has("audio")) {
    tasks.push(withLiveSnapshotField(payload, "audio", async () => readAudioMixerSnapshot()));
  }
  if (picked.has("wow")) {
    tasks.push(withLiveSnapshotField(payload, "wow", async () => ({
      ...(await getWowNavigatorStatus()),
      aiLive: hasAiAssistantKey()
    })));
  }
  if (picked.has("curseforge")) {
    tasks.push(withLiveSnapshotField(payload, "curseforge", async () => getCurseForgeStatus()));
  }
  if (picked.has("runs")) {
    tasks.push(withLiveSnapshotField(payload, "runs", async () => getRunAnalyticsSnapshot(10)));
  }
  await Promise.all(tasks);
  return payload;
}

function closeLiveStreamClient(client, reason = "closed") {
  if (!client || client.closed) return;
  client.closed = true;
  if (client.timer) clearTimeout(client.timer);
  if (client.keepAliveTimer) clearInterval(client.keepAliveTimer);
  liveStreamState.clients.delete(client);
  try {
    if (client.res && !client.res.writableEnded) {
      writeSseEvent(client.res, "end", { reason, ts: Date.now() });
      client.res.end();
    }
  } catch {
    // ignore socket close races
  }
}

function closeAllLiveStreams(reason = "shutdown") {
  for (const client of Array.from(liveStreamState.clients)) {
    closeLiveStreamClient(client, reason);
  }
}

app.get("/api/health", requireToken, rateLimit, (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    ts: Date.now(),
    version: APP_VERSION,
    build: APP_BUILD,
    features: getApiFeatures()
  });
});

app.get("/api/status", requireToken, rateLimit, async (req, res) => {
  const wowRunning = await isProcessRunning(config.wow.processName);
  res.json({ ok: true, wowRunning, processName: config.wow.processName, ts: Date.now() });
});

app.get("/api/curseforge/status", requireToken, rateLimit, async (req, res) => {
  try {
    const status = await getCurseForgeStatus();
    return res.json({ ok: true, ...status, ts: Date.now() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/curseforge/start", requireToken, rateLimit, async (req, res) => {
  try {
    const executablePath = startCurseForgeProcess();
    const status = await getCurseForgeStatus({ useCache: false });
    return res.json({ ok: true, executablePath, ...status, ts: Date.now() });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/curseforge/stop", requireToken, rateLimit, async (req, res) => {
  try {
    const stopResult = await stopCurseForgeProcesses();
    const status = await getCurseForgeStatus({ useCache: false });
    return res.json({ ok: true, ...stopResult, ...status, ts: Date.now() });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/curseforge/restart", requireToken, rateLimit, async (req, res) => {
  try {
    const stopResult = await stopCurseForgeProcesses();
    await new Promise((resolve) => setTimeout(resolve, 240));
    const executablePath = startCurseForgeProcess();
    const status = await getCurseForgeStatus({ useCache: false });
    return res.json({ ok: true, executablePath, stop: stopResult, ...status, ts: Date.now() });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/api/audio/mixer", requireToken, rateLimit, async (req, res) => {
  try {
    const snapshot = await readAudioMixerSnapshot();
    return res.json({ ok: true, ...snapshot, ts: Date.now() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/audio/session/volume", requireToken, rateLimit, async (req, res) => {
  try {
    const { pid, sessionKey } = sanitizeAudioSessionTarget(req.body || {});
    const volumePercent = sanitizeVolumePercent(req.body?.volumePercent);
    const result = await setAudioSessionVolume(pid, volumePercent, sessionKey);
    const snapshot = await readAudioMixerSnapshot({ useCache: false });
    return res.json({ ok: true, pid, sessionKey, volumePercent, result, snapshot });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/audio/session/mute", requireToken, rateLimit, async (req, res) => {
  try {
    const { pid, sessionKey } = sanitizeAudioSessionTarget(req.body || {});
    const muted = req.body?.muted === true || String(req.body?.muted || "").toLowerCase() === "true";
    const result = await setAudioSessionMute(pid, muted, sessionKey);
    const snapshot = await readAudioMixerSnapshot({ useCache: false });
    return res.json({ ok: true, pid, sessionKey, muted, result, snapshot });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/audio/session/playpause", requireToken, rateLimit, async (req, res) => {
  try {
    const rawPid = Number(req.body?.pid || 0);
    const pid = Number.isFinite(rawPid) && rawPid > 0 ? Math.trunc(rawPid) : 0;
    const result = await sendAudioSessionPlayPause(pid);
    return res.json({ ok: true, pid, result, ts: Date.now() });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/audio/spotify/open", requireToken, rateLimit, (req, res) => {
  try {
    openSpotifyApp();
    return res.json({ ok: true, ts: Date.now() });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/api/wow/navigator/status", requireToken, rateLimit, async (req, res) => {
  try {
    const status = await getWowNavigatorStatus();
    return res.json({ ok: true, ...status, aiLive: hasAiAssistantKey(), ts: Date.now() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/wow/assistant", requireToken, rateLimit, async (req, res) => {
  try {
    const input = sanitizeWowAssistantRequest(req.body || {});
    const navStatus = await getWowNavigatorStatus({ useCache: true });
    const guide = await buildWowAssistantResponse(input, navStatus);
    return res.json({
      ok: true,
      ...guide,
      wowStatus: {
        wowRunning: navStatus.wowRunning,
        processName: navStatus.processName,
        isTomTomInstalled: navStatus.isTomTomInstalled,
        isQuestieInstalled: navStatus.isQuestieInstalled,
        isStreamDeckNavigatorInstalled: navStatus.isStreamDeckNavigatorInstalled
      },
      aiLive: hasAiAssistantKey(),
      ts: Date.now()
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/api/system/metrics", requireToken, rateLimit, async (req, res) => {
  try {
    const metrics = await collectSystemMetrics();
    res.json({ ok: true, ...metrics, ts: Date.now() });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/api/wow/addons", requireToken, rateLimit, (req, res) => {
  try {
    const data = listWowAddons();
    return res.json({ ok: true, baseDir: data.baseDir, items: data.items, ts: Date.now() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/wow/addons/toggle", requireToken, rateLimit, (req, res) => {
  try {
    const key = safeAddonFolderKey(req.body?.key);
    const enabled = req.body?.enabled !== false;
    const result = toggleWowAddonState(key, enabled);
    const data = listWowAddons();
    return res.json({
      ok: true,
      changed: result.changed,
      fromKey: result.fromKey,
      toKey: result.toKey,
      baseDir: data.baseDir,
      items: data.items
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/wow/addons/open-folder", requireToken, rateLimit, (req, res) => {
  try {
    const baseDir = wowAddonsBaseDir();
    startViaCmd("explorer.exe", [baseDir]);
    return res.json({ ok: true, path: baseDir });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/api/actions", requireToken, rateLimit, (req, res) => {
  res.json({
    ok: true,
    actions: [
      "terminal",
      "powershell",
      "browser",
      "discord",
      "streamingSoundboard",
      "wowNavigator",
      "curseforge",
      "curseforgeManager",
      "performanceOverlay",
      "wowStart",
      "openWorkspace",
      "vscode",
      "wowClassic",
      "wowTBC",
      "openWowAddons",
      "openWowLogs",
      "openWowWtf"
    ]
  });
});

app.get("/api/bootstrap", requireToken, rateLimit, async (req, res) => {
  try {
    const payload = await buildClientTiles();
    res.json({
      ok: true,
      appName: APP_NAME,
      host: config.host,
      port: config.port,
      profiles: config.profiles,
      tiles: payload.tiles,
      wowRunning: payload.wowRunning,
      serverVersion: APP_VERSION,
      serverBuild: APP_BUILD,
      features: getApiFeatures(),
      ts: Date.now()
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/api/settings", requireToken, rateLimit, (req, res) => {
  const launchers = Object.entries(config.launchers || {}).map(([id, v]) => ({
    id,
    label: v.label || id,
    path: v.path || "",
    candidates: Array.isArray(v.candidates) ? v.candidates : []
  }));

  res.json({
    ok: true,
    launchers,
    wow: {
      processName: config.wow.processName,
      folders: { ...config.wow.folders }
    },
    ai: getAiSettingsView(),
    serverVersion: APP_VERSION,
    serverBuild: APP_BUILD,
    features: getApiFeatures(),
    logging: {
      enabled: config.logging?.enabled !== false,
      dir: resolveLogsDir(config.logging || {}),
      maxFiles: Math.max(3, Math.min(90, Number(config.logging?.maxFiles) || 14)),
      level: normalizeLogLevel(config.logging?.level, "INFO"),
      effectiveLevel: loggerState.level
    }
  });
});

app.get("/api/settings/ai", requireToken, rateLimit, (req, res) => {
  return res.json({
    ok: true,
    ai: getAiSettingsView(),
    ts: Date.now()
  });
});

app.post("/api/settings/ai", requireToken, rateLimit, async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const hasModelField = Object.prototype.hasOwnProperty.call(body, "model");
    const hasKeyField = Object.prototype.hasOwnProperty.call(body, "openAiApiKey");
    const verify = body.verify !== false;
    if (!hasModelField && !hasKeyField) {
      return res.status(400).json({ ok: false, error: "mindestens model oder openAiApiKey angeben" });
    }

    if (hasModelField) {
      config.ai = config.ai && typeof config.ai === "object" ? config.ai : {};
      config.ai.model = sanitizeAiModel(body.model);
    }

    let verification = null;
    if (hasKeyField) {
      const hasEnvKey = Boolean(
        safeTrim(process.env.STREAMDECK_AI_API_KEY || "", 256)
        || safeTrim(process.env.OPENAI_API_KEY || "", 256)
      );
      if (hasEnvKey) {
        return res.status(409).json({
          ok: false,
          error: "API key wird per Umgebungsvariable gesetzt und kann hier nicht ueberschrieben werden"
        });
      }

      const newKey = sanitizeAiApiKey(body.openAiApiKey);
      if (newKey && verify) {
        verification = await verifyOpenAiApiKey(newKey);
      }
      config.ai = config.ai && typeof config.ai === "object" ? config.ai : {};
      config.ai.openAiApiKey = newKey;
    }

    if (!persistConfigSafe()) return res.status(500).json({ ok: false, error: "config write failed" });
    bumpConfigRevision();
    return res.json({
      ok: true,
      ai: getAiSettingsView(),
      verification,
      ts: Date.now()
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/settings/launcher", requireToken, rateLimit, (req, res) => {
  const id = safeTrim(req.body?.id, 64);
  let requested = "";
  try {
    requested = assertSafeInput(req.body?.path, "path");
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
  const newPath = requested ? expandEnv(requested) : "";
  if (!id) return res.status(400).json({ ok: false, error: "id fehlt" });
  if (!config.launchers[id]) return res.status(404).json({ ok: false, error: "launcher nicht gefunden" });
  config.launchers[id].path = newPath;
  invalidateProgramIndexCache();
  if (!persistConfigSafe()) return res.status(500).json({ ok: false, error: "config write failed" });
  bumpConfigRevision();
  res.json({ ok: true, launcher: { id, ...config.launchers[id] } });
});

app.post("/api/settings/wow-folder", requireToken, rateLimit, (req, res) => {
  const key = safeTrim(req.body?.key, 32);
  let requested = "";
  try {
    requested = assertSafeInput(req.body?.path, "path");
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
  const newPath = requested ? expandEnv(requested) : "";
  if (!["addons", "logs", "wtf"].includes(key)) {
    return res.status(400).json({ ok: false, error: "ungueltiger key" });
  }
  config.wow.folders[key] = newPath;
  if (!persistConfigSafe()) return res.status(500).json({ ok: false, error: "config write failed" });
  bumpConfigRevision();
  res.json({ ok: true, key, path: newPath });
});

app.post("/api/settings/wow-process", requireToken, rateLimit, (req, res) => {
  const processName = safeTrim(req.body?.processName, 120);
  if (!processName) return res.status(400).json({ ok: false, error: "processName fehlt" });
  if (/[\\/]/.test(processName)) return res.status(400).json({ ok: false, error: "ungueltiger processName" });
  config.wow.processName = processName;
  if (!persistConfigSafe()) return res.status(500).json({ ok: false, error: "config write failed" });
  bumpConfigRevision();
  res.json({ ok: true, processName });
});

app.post("/api/settings/logging", requireToken, rateLimit, (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const enabled = body.enabled !== false;
    const requestedDir = typeof body.dir === "string" ? unquoteWrapped(body.dir) : "";
    const expandedDir = requestedDir ? expandEnv(assertSafeInput(requestedDir, "dir", MAX_PATH_LEN)) : "";
    const maxFiles = Math.max(3, Math.min(90, Number(body.maxFiles) || config.logging?.maxFiles || 14));
    const level = normalizeLogLevel(body.level, config.logging?.level || "INFO");

    config.logging = {
      enabled,
      dir: expandedDir,
      maxFiles,
      level
    };
    applyLoggingConfig(config);
    if (!persistConfigSafe()) return res.status(500).json({ ok: false, error: "config write failed" });
    bumpConfigRevision();
    return res.json({
      ok: true,
      logging: {
        enabled: config.logging.enabled,
        dir: resolveLogsDir(config.logging),
        maxFiles: config.logging.maxFiles,
        level: normalizeLogLevel(config.logging.level, "INFO"),
        effectiveLevel: loggerState.level
      }
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/api/settings/export", requireToken, rateLimit, (req, res) => {
  try {
    const exported = mergeWithDefaults(cloneConfigData(config));
    return res.json({
      ok: true,
      exportedAt: new Date().toISOString(),
      config: exported
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/settings/import", requireToken, rateLimit, (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const incoming = body.config;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return res.status(400).json({ ok: false, error: "config object fehlt" });
    }

    const keepCurrentToken = body.keepCurrentToken !== false;
    const previous = config;
    const imported = mergeWithDefaults(cloneConfigData(incoming));
    if (keepCurrentToken) imported.token = previous.token;

    config = imported;
    invalidateProgramIndexCache();
    applyLoggingConfig(config);
    if (!persistConfigSafe()) return res.status(500).json({ ok: false, error: "config write failed" });
    bumpConfigRevision();

    const restartRequired = previous.host !== config.host || previous.port !== config.port;
    return res.json({
      ok: true,
      importedAt: new Date().toISOString(),
      restartRequired,
      keepCurrentToken,
      summary: {
        profiles: Array.isArray(config.profiles) ? config.profiles.length : 0,
        tiles: Array.isArray(config.tiles) ? config.tiles.length : 0,
        launchers: config.launchers && typeof config.launchers === "object" ? Object.keys(config.launchers).length : 0
      }
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/settings/autodetect", requireToken, rateLimit, (req, res) => {
  if (DISABLE_AUTODETECT) {
    return res.status(503).json({ ok: false, error: "autodetect deaktiviert (STREAMDECK_DISABLE_AUTODETECT=1)" });
  }
  const launcherId = safeTrim(req.body?.launcherId, 64);
  if (launcherId && !config.launchers?.[launcherId]) {
    return res.status(404).json({ ok: false, error: "launcher nicht gefunden" });
  }
  const changed = autodetectLaunchers(config, launcherId || "");
  if (changed) invalidateProgramIndexCache();
  if (changed && !persistConfigSafe()) return res.status(500).json({ ok: false, error: "config write failed" });
  if (changed) bumpConfigRevision();
  res.json({ ok: true, changed });
});

app.post("/api/settings/browse", requireToken, rateLimit, async (req, res) => {
  const kind = safeTrim(req.body?.kind || "file", 16);
  const title = safeTrim(req.body?.title, 120);
  try {
    const selected = await browsePath(kind, title);
    res.json({ ok: true, path: selected || "" });
  } catch (error) {
    const reason = normalizeBrowseFailure(error);
    logger.warn("browse dialog unavailable", {
      requestId: req.requestId,
      kind,
      title,
      reason,
      error: safeTrim(String(error?.message || error), 600)
    });
    res.json({
      ok: true,
      path: "",
      unavailable: true,
      reason
    });
  }
});

app.get("/api/programs", requireToken, rateLimit, (req, res) => {
  try {
    const query = safeTrim(req.query?.q || "", 120);
    const limit = Math.max(1, Math.min(50, Number(req.query?.limit) || 20));
    const programs = searchPrograms(query, limit);
    res.json({ ok: true, programs, ts: Date.now() });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/programs/resolve", requireToken, rateLimit, (req, res) => {
  try {
    const input = assertSafeInput(req.body?.input, "input", 240);
    if (!input) return res.status(400).json({ ok: false, error: "input fehlt" });
    const resolved = resolveProgramPath(input);
    if (!resolved) return res.status(404).json({ ok: false, error: "programm nicht gefunden" });
    res.json({ ok: true, path: resolved });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/api/logs/recent", requireToken, rateLimit, (req, res) => {
  try {
    const lines = Math.max(10, Math.min(2000, Number(req.query?.lines) || 200));
    const data = readRecentLogLines(lines);
    res.json({
      ok: true,
      lines: data,
      logDir: loggerState.dir,
      loggingEnabled: loggerState.enabled,
      loggingLevel: loggerState.level,
      ts: Date.now()
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/api/diagnostics", requireToken, rateLimit, (req, res) => {
  try {
    const routeLimit = Math.max(1, Math.min(40, Number(req.query?.routeLimit) || 10));
    const recentRuns = Math.max(1, Math.min(120, Number(req.query?.recentRuns) || 20));
    const diagnostics = getRuntimeDiagnostics({ routeLimit, recentRuns });
    return res.json({ ok: true, diagnostics, ts: Date.now() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/api/run/history", requireToken, rateLimit, (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 40));
    const snapshot = getRunAnalyticsSnapshot(limit);
    return res.json({ ok: true, ...snapshot, ts: Date.now() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/api/tiles/recommendations", requireToken, rateLimit, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query?.limit) || 10));
    const profile = safeTrim(req.query?.profile || "", 64);
    const page = safeTrim(req.query?.page || "", 64);
    const wowRunning = await isProcessRunning(config.wow.processName);
    const items = getTileRecommendations({ limit, profile, page, wowRunning });
    return res.json({
      ok: true,
      profile: profile || "",
      page: page || "",
      wowRunning,
      items,
      ts: Date.now()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/api/stream/live", requireToken, rateLimit, async (req, res) => {
  const channels = parseLiveStreamChannels(req.query?.channels || "");
  const intervalMs = parseLiveStreamIntervalMs(req.query?.intervalMs);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const client = {
    id: liveStreamState.nextId++,
    requestId: req.requestId,
    channels,
    intervalMs,
    res,
    timer: null,
    keepAliveTimer: null,
    inFlight: false,
    closed: false
  };
  liveStreamState.clients.add(client);

  const scheduleTick = () => {
    if (client.closed) return;
    client.timer = setTimeout(async () => {
      if (client.closed) return;
      if (client.inFlight) {
        scheduleTick();
        return;
      }
      client.inFlight = true;
      try {
        const snapshot = await buildLiveSnapshot(client.channels);
        if (!client.closed) writeSseEvent(client.res, "snapshot", snapshot);
      } catch (error) {
        if (!client.closed) {
          writeSseEvent(client.res, "error", { message: safeTrim(error?.message || String(error), 220), ts: Date.now() });
        }
      } finally {
        client.inFlight = false;
        scheduleTick();
      }
    }, client.intervalMs);
    if (typeof client.timer?.unref === "function") client.timer.unref();
  };

  client.keepAliveTimer = setInterval(() => {
    if (client.closed) return;
    try {
      client.res.write(": keep-alive\n\n");
    } catch {
      closeLiveStreamClient(client, "write-failed");
    }
  }, 15000);
  if (typeof client.keepAliveTimer?.unref === "function") client.keepAliveTimer.unref();

  req.on("close", () => closeLiveStreamClient(client, "client-disconnected"));
  req.on("aborted", () => closeLiveStreamClient(client, "client-aborted"));

  writeSseEvent(res, "hello", {
    requestId: req.requestId,
    channels,
    intervalMs,
    connectedClients: liveStreamState.clients.size,
    ts: Date.now()
  });
  try {
    const initial = await buildLiveSnapshot(channels);
    if (!client.closed) writeSseEvent(res, "snapshot", initial);
  } catch (error) {
    if (!client.closed) {
      writeSseEvent(res, "error", { message: safeTrim(error?.message || String(error), 220), ts: Date.now() });
    }
  }
  scheduleTick();
});

app.post("/api/icon", requireToken, rateLimit, async (req, res) => {
  let targetPath = "";
  try {
    targetPath = assertSafeInput(req.body?.path, "path");
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
  if (!targetPath) return res.status(400).json({ ok: false, error: "path fehlt" });
  const iconData = await extractIconDataUrl(targetPath);
  if (!iconData) return res.status(404).json({ ok: false, error: "kein icon" });
  res.json({ ok: true, iconData });
});

app.get("/api/tiles/:id", requireToken, rateLimit, (req, res) => {
  const id = safeTrim(req.params?.id || "", 96);
  if (!id) return res.status(400).json({ ok: false, error: "id fehlt" });
  const tile = config.tiles.find((x) => x.id === id);
  if (!tile) return res.status(404).json({ ok: false, error: "tile nicht gefunden" });
  return res.json({
    ok: true,
    tile: {
      ...tile,
      args: Array.isArray(tile.args) ? tile.args : [],
      target: typeof tile.target === "string" ? tile.target : "",
      launcherKey: typeof tile.launcherKey === "string" ? tile.launcherKey : "",
      action: typeof tile.action === "string" ? tile.action : "",
      startIn: typeof tile.startIn === "string" ? tile.startIn : "",
      iconData: typeof tile.iconData === "string" ? tile.iconData : ""
    }
  });
});

app.post("/api/tiles/upsert", requireToken, rateLimit, (req, res) => {
  try {
    const incoming = req.body?.tile;
    if (!incoming || typeof incoming !== "object") {
      return res.status(400).json({ ok: false, error: "tile fehlt" });
    }

    const id = String(incoming.id || "").trim();
    const existing = id ? config.tiles.find((x) => x.id === id) : null;
    if (existing && existing.builtin) {
      return res.status(400).json({ ok: false, error: "builtin tiles koennen nicht ueberschrieben werden" });
    }

    const safe = sanitizeCustomTile(incoming, existing);
    const idx = config.tiles.findIndex((x) => x.id === safe.id);
    if (idx >= 0) config.tiles[idx] = safe;
    else config.tiles.push(safe);
    if (!persistConfigSafe()) return res.status(500).json({ ok: false, error: "config write failed" });
    bumpConfigRevision();
    res.json({ ok: true, tile: safe });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/tiles/delete", requireToken, rateLimit, (req, res) => {
  const id = String(req.body?.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "id fehlt" });
  const tile = config.tiles.find((x) => x.id === id);
  if (!tile) return res.status(404).json({ ok: false, error: "tile nicht gefunden" });
  if (tile.builtin) return res.status(400).json({ ok: false, error: "builtin tile kann nicht geloescht werden" });
  config.tiles = config.tiles.filter((x) => x.id !== id);
  if (!persistConfigSafe()) return res.status(500).json({ ok: false, error: "config write failed" });
  bumpConfigRevision();
  res.json({ ok: true });
});

app.post("/api/run", requireToken, rateLimit, (req, res) => {
  let runMeta = null;
  try {
    const tileId = String(req.body?.tileId || "").trim();
    const action = String(req.body?.action || "").trim();
    const payload = req.body && typeof req.body === "object" ? req.body : {};

    if (tileId) {
      const tile = config.tiles.find((x) => x.id === tileId);
      if (!tile) {
        recordRunEvent({
          requestId: req.requestId,
          source: "tile",
          tileId,
          label: tileId,
          ok: false,
          error: "tile nicht gefunden"
        });
        return res.status(404).json({ ok: false, error: "tile nicht gefunden" });
      }
      runMeta = {
        source: "tile",
        tileId: tile.id,
        action: tile.type === "action" ? safeTrim(tile.action || "", 96) : "",
        label: safeTrim(tile.label || tile.id, 120),
        profile: safeTrim(tile.profile || "", 64),
        page: safeTrim(tile.page || "", 64),
        type: safeTrim(tile.type || "", 32)
      };
      runTile(tile, payload);
      recordRunEvent({ ...runMeta, requestId: req.requestId, ok: true });
      return res.json({ ok: true });
    }

    if (action) {
      runMeta = {
        source: "action",
        tileId: "",
        action: safeTrim(action, 96),
        label: safeTrim(action, 120),
        profile: "",
        page: "",
        type: "action"
      };
      runLegacyAction(action, payload);
      recordRunEvent({ ...runMeta, requestId: req.requestId, ok: true });
      return res.json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: "tileId oder action fehlt" });
  } catch (error) {
    if (runMeta) {
      recordRunEvent({
        ...runMeta,
        requestId: req.requestId,
        ok: false,
        error: safeTrim(String(error?.message || error), 240)
      });
    }
    logger.error("run error", {
      requestId: req.requestId,
      error: String(error?.stack || error?.message || error)
    });
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.use("/api", (req, res) => {
  return res.status(404).json({ ok: false, error: "api route not found" });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
    return res.status(400).json({ ok: false, error: "ungueltiger JSON-Body" });
  }
  logger.error("unhandled api error", {
    requestId: req.requestId,
    method: req?.method,
    path: req?.originalUrl || req?.url,
    error: String(err?.stack || err?.message || err)
  });
  return res.status(500).json({ ok: false, error: "internal error" });
});

const server = app.listen(config.port, config.host, () => {
  logger.info(`Listening on http://${config.host}:${config.port}`);
  logger.info(`Config: ${CONFIG_PATH}`);
  logger.info(`Profiles: ${config.profiles.map((p) => p.id).join(", ")}`);
  logger.info(`LogDir: ${loggerState.dir}`);
  if (DISABLE_AUTODETECT) logger.warn("Launcher autodetect disabled by environment");
  if (DRY_RUN) logger.warn("Dry-run mode active: external process starts are disabled");
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn("shutdown signal received", { signal });
  closeAllLiveStreams("shutdown");
  server.close(() => {
    logger.info("http server closed");
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn("forced shutdown timeout reached");
    process.exit(1);
  }, 4000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", { error: String(reason?.stack || reason?.message || reason) });
});
process.on("uncaughtException", (error) => {
  logger.error("uncaught exception", { error: String(error?.stack || error?.message || error) });
  setTimeout(() => process.exit(1), 100).unref();
});
