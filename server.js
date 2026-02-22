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
  const id = String(raw.id || "").trim();
  const profile = String(raw.profile || "").trim();
  const page = String(raw.page || "main").trim();
  const label = String(raw.label || "").trim();
  const type = String(raw.type || "").trim();
  if (!id || !profile || !page || !label || !type) return null;

  const tile = {
    id,
    profile,
    page,
    label,
    subtitle: String(raw.subtitle || ""),
    type,
    builtin: Boolean(raw.builtin),
    showIf: raw.showIf ? String(raw.showIf) : "",
    iconMode: ["auto", "emoji", "image"].includes(raw.iconMode) ? raw.iconMode : "emoji",
    icon: typeof raw.icon === "string" ? raw.icon : "",
    iconData: typeof raw.iconData === "string" ? raw.iconData : ""
  };

  if (typeof raw.launcherKey === "string" && raw.launcherKey.trim()) tile.launcherKey = raw.launcherKey.trim();
  if (typeof raw.target === "string" && raw.target.trim()) tile.target = raw.target.trim();
  if (Array.isArray(raw.args)) tile.args = raw.args.map((x) => String(x));
  if (typeof raw.startIn === "string" && raw.startIn.trim()) tile.startIn = raw.startIn.trim();
  if (typeof raw.action === "string" && raw.action.trim()) tile.action = raw.action.trim();
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
  autodetectLaunchers(out);
  return out;
}

function resolveConfigPath() {
  const local = path.join(__dirname, "config.json");
  if (!IS_PKG && fileExists(local)) return local;

  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const dir = path.join(appData, "StreamDeckRemote");
  if (!dirExists(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "config.json");
}

const CONFIG_PATH = resolveConfigPath();

function readConfig() {
  if (!fileExists(CONFIG_PATH)) {
    const fresh = createDefaultConfig({});
    autodetectLaunchers(fresh);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(fresh, null, 2), "utf8");
    return fresh;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return mergeWithDefaults(raw);
  } catch (error) {
    console.error("config parse error:", error.message);
    return mergeWithDefaults({});
  }
}

let config = readConfig();
function persistConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

function persistConfigSafe() {
  try {
    persistConfig();
    return true;
  } catch (error) {
    console.warn('config write warning:', error.message);
    return false;
  }
}
try {
  persistConfig();
} catch (error) {
  console.warn('config write warning:', error.message);
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function spawnDetached(command, args = [], opts = {}) {
  const safeOpts = { detached: true, stdio: "ignore", ...opts };
  if (safeOpts.cwd && !dirExists(safeOpts.cwd)) delete safeOpts.cwd;
  const child = spawn(command, args, safeOpts);
  child.on("error", (err) => console.error("spawn error:", command, args, String(err)));
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

function resolveLauncherPath(key) {
  const launcher = config.launchers && typeof config.launchers === "object" ? config.launchers[key] : null;
  if (!launcher || typeof launcher !== "object") return "";
  return expandEnv(String(launcher.path || "").trim());
}

function resolveTileTarget(tile) {
  if (tile.launcherKey) return resolveLauncherPath(tile.launcherKey);
  if (typeof tile.target === "string") return resolveTemplate(tile.target, config);
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
    const target = assertFilePath(resolveTileTarget(tile), `Programm ${tile.label || tile.id}`);
    const args = Array.isArray(tile.args)
      ? tile.args.map((x) => String(resolveTemplate(String(x), config)))
      : [];
    const cwd = tile.startIn ? resolveTemplate(tile.startIn, config) : "";

    if (target.toLowerCase().endsWith(".lnk")) {
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
    const protocol = String(resolveTileTarget(tile) || "").trim();
    if (!protocol) throw new Error("Protocol fehlt");
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
  const result = await execFileAsync("powershell.exe", cmdArgs, { windowsHide: true, timeout: timeoutMs });
  return result.stdout.trim();
}

async function isProcessRunning(imageName) {
  const name = String(imageName || "").trim();
  if (!name) return false;
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `IMAGENAME eq ${name}`], { windowsHide: true, timeout: 5000 });
    const out = stdout.toLowerCase();
    if (out.includes("no tasks are running")) return false;
    return out.includes(name.toLowerCase());
  } catch {
    return false;
  }
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
    : String(raw.id || `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`).trim();
  const profile = String(raw.profile || existing?.profile || "").trim();
  const page = String(raw.page || existing?.page || "main").trim();
  const label = String(raw.label || existing?.label || "").trim();
  const type = String(raw.type || existing?.type || "").trim();
  if (!id || !profile || !page || !label || !type) throw new Error("Tile Daten unvollstaendig");

  const tile = {
    id,
    profile,
    page,
    label,
    subtitle: String(raw.subtitle || ""),
    type,
    builtin: false,
    iconMode: ["auto", "emoji", "image"].includes(raw.iconMode) ? raw.iconMode : "emoji",
    icon: typeof raw.icon === "string" ? raw.icon : "",
    iconData: typeof raw.iconData === "string" ? raw.iconData : ""
  };

  if (typeof raw.target === "string" && raw.target.trim()) tile.target = raw.target.trim();
  if (typeof raw.launcherKey === "string" && raw.launcherKey.trim()) tile.launcherKey = raw.launcherKey.trim();
  if (typeof raw.action === "string" && raw.action.trim()) tile.action = raw.action.trim();
  if (Array.isArray(raw.args)) tile.args = raw.args.map((x) => String(x));
  if (typeof raw.startIn === "string" && raw.startIn.trim()) tile.startIn = raw.startIn.trim();

  const normalized = normalizeTile(tile);
  if (!normalized || normalized.builtin) throw new Error("ungueltige Tile Daten");
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
const app = express();
app.use(express.json({ limit: "6mb" }));
app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: "1h" }));

function requireToken(req, res, next) {
  const header = req.header("x-token");
  const query = typeof req.query.token === "string" ? req.query.token : "";
  const token = header || query;
  if (!token) return res.status(401).json({ ok: false, error: "unauthorized: missing token" });
  if (token !== config.token) return res.status(401).json({ ok: false, error: "unauthorized: token mismatch" });
  next();
}

const rateState = new Map();
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
  if (state.n > max) return res.status(429).json({ ok: false, error: "rate limited" });
  next();
}

app.get("/api/health", requireToken, rateLimit, (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), ts: Date.now() });
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
  const payload = await buildClientTiles();
  res.json({
    ok: true,
    appName: APP_NAME,
    host: config.host,
    port: config.port,
    profiles: config.profiles,
    tiles: payload.tiles,
    wowRunning: payload.wowRunning,
    ts: Date.now()
  });
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
    }
  });
});

app.post("/api/settings/launcher", requireToken, rateLimit, (req, res) => {
  const id = String(req.body?.id || "").trim();
  const newPath = expandEnv(String(req.body?.path || "").trim());
  if (!id) return res.status(400).json({ ok: false, error: "id fehlt" });
  if (!config.launchers[id]) return res.status(404).json({ ok: false, error: "launcher nicht gefunden" });
  config.launchers[id].path = newPath;
  try {
  persistConfig();
} catch (error) {
  console.warn('config write warning:', error.message);
}
  res.json({ ok: true, launcher: { id, ...config.launchers[id] } });
});

app.post("/api/settings/wow-folder", requireToken, rateLimit, (req, res) => {
  const key = String(req.body?.key || "").trim();
  const newPath = expandEnv(String(req.body?.path || "").trim());
  if (!["addons", "logs", "wtf"].includes(key)) {
    return res.status(400).json({ ok: false, error: "ungueltiger key" });
  }
  config.wow.folders[key] = newPath;
  try {
  persistConfig();
} catch (error) {
  console.warn('config write warning:', error.message);
}
  res.json({ ok: true, key, path: newPath });
});

app.post("/api/settings/wow-process", requireToken, rateLimit, (req, res) => {
  const processName = String(req.body?.processName || "").trim();
  if (!processName) return res.status(400).json({ ok: false, error: "processName fehlt" });
  config.wow.processName = processName;
  try {
  persistConfig();
} catch (error) {
  console.warn('config write warning:', error.message);
}
  res.json({ ok: true, processName });
});

app.post("/api/settings/autodetect", requireToken, rateLimit, (req, res) => {
  const launcherId = String(req.body?.launcherId || "").trim();
  const changed = autodetectLaunchers(config, launcherId || "");
  if (changed) try {
  persistConfig();
} catch (error) {
  console.warn('config write warning:', error.message);
}
  res.json({ ok: true, changed });
});

app.post("/api/settings/browse", requireToken, rateLimit, async (req, res) => {
  try {
    const kind = String(req.body?.kind || "file").trim();
    const title = String(req.body?.title || "").trim();
    const selected = await browsePath(kind, title);
    res.json({ ok: true, path: selected || "" });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/icon", requireToken, rateLimit, async (req, res) => {
  const targetPath = String(req.body?.path || "").trim();
  if (!targetPath) return res.status(400).json({ ok: false, error: "path fehlt" });
  const iconData = await extractIconDataUrl(targetPath);
  if (!iconData) return res.status(404).json({ ok: false, error: "kein icon" });
  res.json({ ok: true, iconData });
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
    try {
  persistConfig();
} catch (error) {
  console.warn('config write warning:', error.message);
}
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
  try {
  persistConfig();
} catch (error) {
  console.warn('config write warning:', error.message);
}
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
    console.error("run error:", error);
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.listen(config.port, config.host, () => {
  console.log(`Listening on http://${config.host}:${config.port}`);
  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Profiles: ${config.profiles.map((p) => p.id).join(", ")}`);
});


