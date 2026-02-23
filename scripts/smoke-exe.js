"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(port, token, maxAttempts = 80, delayMs = 250) {
  for (let i = 0; i < maxAttempts; i += 1) {
    await sleep(delayMs);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { "X-Token": token }
      });
      if (!response.ok) continue;
      const body = await response.json();
      if (body?.ok === true) return body;
    } catch {
      // keep polling while process is still starting
    }
  }
  throw new Error(`EXE health check timed out on port ${port}`);
}

async function main() {
  const exePath = path.resolve("dist", "streamdeck_remote.exe");
  if (!fs.existsSync(exePath)) {
    throw new Error(`EXE fehlt: ${exePath}. Bitte zuerst 'npm run build:win' ausfuehren.`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "streamdeck-remote-exe-smoke-"));
  const cfgPath = path.join(tempDir, "config.json");
  const port = 24000 + Math.floor(Math.random() * 1200);
  const token = "EXE_SMOKE_TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  const config = {
    host: "127.0.0.1",
    port,
    token,
    workspaceDir: tempDir,
    rateLimit: { windowMs: 2000, max: 200 },
    wow: {
      processName: "DefinitelyNotRunning.exe",
      folders: { addons: tempDir, logs: tempDir, wtf: tempDir }
    },
    logging: { enabled: false, dir: "", maxFiles: 5, level: "ERROR" },
    launchers: {},
    profiles: [{ id: "work", label: "Work", pages: [{ id: "main", label: "Main" }] }],
    tiles: []
  };
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), "utf8");

  const child = spawn(exePath, [], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      STREAMDECK_CONFIG_PATH: cfgPath,
      STREAMDECK_DRY_RUN: "1",
      STREAMDECK_DISABLE_AUTODETECT: "1"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (buf) => {
    stdout += String(buf || "");
  });
  child.stderr.on("data", (buf) => {
    stderr += String(buf || "");
  });

  try {
    const health = await waitForHealth(port, token);
    if (health?.features?.settingsImportExport !== true) {
      throw new Error(`settingsImportExport feature missing in health payload: ${JSON.stringify(health?.features || {})}`);
    }

    const exportResponse = await fetch(`http://127.0.0.1:${port}/api/settings/export`, {
      headers: { "X-Token": token }
    });
    const exported = await exportResponse.json().catch(() => null);
    if (!exportResponse.ok || !exported?.ok || !exported?.config) {
      throw new Error(`Config export failed: status=${exportResponse.status} body=${JSON.stringify(exported)}`);
    }

    process.stdout.write(`EXE smoke ok | port=${port} | version=${health.version || "?"}\n`);
  } finally {
    if (!child.killed) child.kill("SIGTERM");
    await sleep(300);
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exit(1);
});
