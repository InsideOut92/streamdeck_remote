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
const APP_VERSION = readPackageVersion();
const APP_BUILD = detectBuildStamp();
const PROCESS_STATUS_CACHE_MS = 3000;
const DRY_RUN = isTruthyEnv(process.env.STREAMDECK_DRY_RUN);
const DISABLE_AUTODETECT = isTruthyEnv(process.env.STREAMDECK_DISABLE_AUTODETECT);
const API_FEATURES = Object.freeze({
  logsRecent: true,
  settingsLogging: true,
  programResolve: true,
  tileDetails: true,
  dryRun: DRY_RUN,
  launcherAutodetect: !DISABLE_AUTODETECT
});

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
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
      "  STREAMDECK_DRY_RUN=1     Skip external process starts and only log run requests"
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
      pathLower: safePath.toLowerCase()
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
    .map((x) => ({ label: x.label, path: x.path, source: x.source, ext: x.ext, fileName: x.fileName, labelLower: x.labelLower, fileLower: x.fileLower, pathLower: x.pathLower }));

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
  const exact = candidates.find((x) => x.label.toLowerCase() === lowered || path.basename(x.path).toLowerCase() === lowered || path.basename(x.path, path.extname(x.path)).toLowerCase() === lowered);
  if (exact) return exact.path;
  const byExeName = candidates.find((x) => x.fileLower === lowered || x.fileLower === `${lowered}.exe`);
  if (byExeName) return byExeName.path;
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
    { id: "wowAddons", profile: "wow", page: "addons", label: "AddOns", subtitle: "Ordner oeffnen", type: "folder", target: "{{wow.folders.addons}}", iconMode: "emoji", icon: "🧩", showIf: "wowRunning", builtin: true },
    { id: "wowLogs", profile: "wow", page: "addons", label: "Logs", subtitle: "Ordner oeffnen", type: "folder", target: "{{wow.folders.logs}}", iconMode: "emoji", icon: "📝", showIf: "wowRunning", builtin: true },
    { id: "wowWtf", profile: "wow", page: "addons", label: "WTF", subtitle: "Ordner oeffnen", type: "folder", target: "{{wow.folders.wtf}}", iconMode: "emoji", icon: "⚙️", showIf: "wowRunning", builtin: true },
    { id: "discord", profile: "streaming", page: "social", label: "Discord", subtitle: "Protocol", type: "protocol", target: "discord://", iconMode: "emoji", icon: "💬", builtin: true },
    { id: "obs", profile: "streaming", page: "main", label: "OBS Studio", subtitle: "Streaming", type: "app", launcherKey: "obs", iconMode: "auto", icon: "🎬", builtin: true }
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
    }
  };
}

function createDefaultConfig(oldConfig = {}) {
  const wowFolders = oldConfig.wow && oldConfig.wow.folders ? oldConfig.wow.folders : {};
  const wowBase = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "World of Warcraft", "_classic_");
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
      maxFiles: Number.isInteger(oldConfig.logging?.maxFiles) ? oldConfig.logging.maxFiles : 14
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
  return out.length ? out : getDefaultProfiles();
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
      maxFiles: Number.isFinite(maxFiles) ? Math.max(3, Math.min(90, Math.floor(maxFiles))) : out.logging.maxFiles
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
  loggerState.enabled = loggingCfg.enabled !== false;
  loggerState.maxFiles = Math.max(3, Math.min(90, Number(loggingCfg.maxFiles) || 14));
  loggerState.dir = resolveLogsDir(loggingCfg);

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
  const ts = new Date().toISOString();
  const msg = safeTrim(String(message || ""), 4000);
  const line = `[${ts}] [${level}] ${msg}${safeLogMeta(meta)}`;

  if (level === "ERROR" || level === "WARN") process.stderr.write(`${line}\n`);
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
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
  );
  next();
}

function resolveLauncherPath(key) {
  const launcher = config.launchers && typeof config.launchers === "object" ? config.launchers[key] : null;
  if (!launcher || typeof launcher !== "object") return "";
  return expandEnv(String(launcher.path || "").trim());
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

async function runPowerShell(script, args = [], timeoutMs = 10000) {
  const cmdArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script, ...args];
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

const iconCache = new Map();
async function extractIconDataUrl(filePath) {
  const p = String(filePath || "").trim();
  if (!p || !fileExists(p)) return "";
  const key = p.toLowerCase();
  if (iconCache.has(key)) return iconCache.get(key);

  const script = [
    "$p = $args[0]",
    "Add-Type -AssemblyName System.Drawing",
    "if (-not (Test-Path $p)) { exit 2 }",
    "$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($p)",
    "if ($null -eq $icon) { exit 3 }",
    "$bmp = New-Object System.Drawing.Bitmap 64,64",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$src = $icon.ToBitmap()",
    "$g.DrawImage($src, 0, 0, 64, 64)",
    "$g.Dispose()",
    "$ms = New-Object System.IO.MemoryStream",
    "$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
    "[Convert]::ToBase64String($ms.ToArray())"
  ].join("; ");

  try {
    const b64 = await runPowerShell(script, [p], 4000);
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

async function buildClientTiles() {
  const wowRunning = await isProcessRunning(config.wow.processName);
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
      icon: tile.icon || "",
      iconData: ""
    };

    if (tile.iconMode === "image" && tile.iconData) {
      out.iconData = tile.iconData;
    } else if (tile.iconMode === "auto" || (!tile.icon && tile.type === "app")) {
      out.iconData = await extractIconDataUrl(resolveTileTarget(tile));
    }

    list.push(out);
  }

  return { wowRunning, tiles: list };
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

  if (useKind === "folder") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$d.Description = $args[0]",
      "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }"
    ].join("; ");
    return runPowerShell(script, [prompt], 120000);
  }

  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$d = New-Object System.Windows.Forms.OpenFileDialog",
    "$d.Title = $args[0]",
    "$d.Filter = 'Programme (*.exe;*.lnk)|*.exe;*.lnk|Alle Dateien (*.*)|*.*'",
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName }"
  ].join("; ");
  return runPowerShell(script, [prompt], 120000);
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

  if (/single thread apartment|sta|showdialog/i.test(raw)) {
    return "Datei-Dialog nicht verfuegbar (kein interaktiver Desktop/STA). Pfad bitte manuell eintragen.";
  }
  if (/timed out|timeout|etimedout/i.test(raw)) {
    return "Datei-Dialog nicht verfuegbar oder wurde geschlossen. Pfad bitte manuell eintragen.";
  }
  if (/access is denied|zugriff verweigert/i.test(raw)) {
    return "Datei-Dialog blockiert (Zugriff verweigert). Pfad bitte manuell eintragen.";
  }
  if (!raw) return "Datei-Dialog nicht verfuegbar. Pfad bitte manuell eintragen.";
  return `Datei-Dialog fehlgeschlagen. Pfad bitte manuell eintragen. (${safeTrim(raw, 220)})`;
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
  const started = Date.now();
  res.on("finish", () => {
    const p = sanitizeUrlForLog(req.originalUrl || req.url || "");
    if (p.startsWith("/api/health") || p.startsWith("/api/status")) return;
    logger.info("api request", {
      requestId: req.requestId,
      method: req.method,
      path: p,
      status: res.statusCode,
      durationMs: Date.now() - started,
      ip: req.ip || req.socket?.remoteAddress || ""
    });
  });
  next();
});

function requireToken(req, res, next) {
  const header = safeTrim(req.header("x-token"), 512);
  const query = typeof req.query.token === "string" ? safeTrim(req.query.token, 512) : "";
  const token = header || query;
  if (!token) return res.status(401).json({ ok: false, error: "unauthorized: missing token" });
  if (!secureEqualText(token, config.token)) return res.status(401).json({ ok: false, error: "unauthorized: token mismatch" });
  next();
}

const rateState = new Map();
let rateSweepCounter = 0;
function rateLimit(req, res, next) {
  const windowMs = Math.max(250, Number(config.rateLimit?.windowMs || 3000));
  const max = Math.max(3, Number(config.rateLimit?.max || 20));
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const state = rateState.get(ip) || { t0: now, n: 0 };
  if (now - state.t0 > windowMs) {
    state.t0 = now;
    state.n = 0;
  }
  state.n += 1;
  rateState.set(ip, state);
  rateSweepCounter += 1;
  if (rateSweepCounter >= 200 || rateState.size > 5000) {
    rateSweepCounter = 0;
    const cutoff = now - (windowMs * 4);
    for (const [key, value] of rateState.entries()) {
      if (value.t0 < cutoff) rateState.delete(key);
    }
  }
  if (state.n > max) return res.status(429).json({ ok: false, error: "rate limited" });
  next();
}

app.get("/api/health", requireToken, rateLimit, (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    ts: Date.now(),
    version: APP_VERSION,
    build: APP_BUILD,
    features: API_FEATURES
  });
});

app.get("/api/status", requireToken, rateLimit, async (req, res) => {
  const wowRunning = await isProcessRunning(config.wow.processName);
  res.json({ ok: true, wowRunning, processName: config.wow.processName, ts: Date.now() });
});

app.get("/api/actions", requireToken, rateLimit, (req, res) => {
  res.json({
    ok: true,
    actions: [
      "terminal",
      "powershell",
      "browser",
      "discord",
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
      features: API_FEATURES,
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
    serverVersion: APP_VERSION,
    serverBuild: APP_BUILD,
    features: API_FEATURES,
    logging: {
      enabled: config.logging?.enabled !== false,
      dir: resolveLogsDir(config.logging || {}),
      maxFiles: Math.max(3, Math.min(90, Number(config.logging?.maxFiles) || 14))
    }
  });
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
  res.json({ ok: true, key, path: newPath });
});

app.post("/api/settings/wow-process", requireToken, rateLimit, (req, res) => {
  const processName = safeTrim(req.body?.processName, 120);
  if (!processName) return res.status(400).json({ ok: false, error: "processName fehlt" });
  if (/[\\/]/.test(processName)) return res.status(400).json({ ok: false, error: "ungueltiger processName" });
  config.wow.processName = processName;
  if (!persistConfigSafe()) return res.status(500).json({ ok: false, error: "config write failed" });
  res.json({ ok: true, processName });
});

app.post("/api/settings/logging", requireToken, rateLimit, (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const enabled = body.enabled !== false;
    const requestedDir = typeof body.dir === "string" ? unquoteWrapped(body.dir) : "";
    const expandedDir = requestedDir ? expandEnv(assertSafeInput(requestedDir, "dir", MAX_PATH_LEN)) : "";
    const maxFiles = Math.max(3, Math.min(90, Number(body.maxFiles) || config.logging?.maxFiles || 14));

    config.logging = {
      enabled,
      dir: expandedDir,
      maxFiles
    };
    applyLoggingConfig(config);
    if (!persistConfigSafe()) return res.status(500).json({ ok: false, error: "config write failed" });
    return res.json({
      ok: true,
      logging: {
        enabled: config.logging.enabled,
        dir: resolveLogsDir(config.logging),
        maxFiles: config.logging.maxFiles
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
      ts: Date.now()
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
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
  res.json({ ok: true });
});

app.post("/api/run", requireToken, rateLimit, (req, res) => {
  try {
    const tileId = String(req.body?.tileId || "").trim();
    const action = String(req.body?.action || "").trim();
    const payload = req.body && typeof req.body === "object" ? req.body : {};

    if (tileId) {
      const tile = config.tiles.find((x) => x.id === tileId);
      if (!tile) return res.status(404).json({ ok: false, error: "tile nicht gefunden" });
      runTile(tile, payload);
      return res.json({ ok: true });
    }

    if (action) {
      runLegacyAction(action, payload);
      return res.json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: "tileId oder action fehlt" });
  } catch (error) {
    logger.error("run error", {
      requestId: req.requestId,
      error: String(error?.stack || error?.message || error)
    });
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
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
