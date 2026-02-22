"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProcess(proc, timeoutMs = 5000) {
  if (!proc || proc.exitCode !== null) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (proc.exitCode === null && Date.now() < deadline) {
    await sleep(50);
  }
  if (proc.exitCode === null) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore if already exited
    }
  }
}

function waitForServerStart(proc, expectedPort, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const expected = `Listening on http://127.0.0.1:${expectedPort}`;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout.off("data", onStdout);
      proc.stderr.off("data", onStderr);
      proc.off("exit", onExit);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };

    const onStdout = (buf) => {
      stdout += String(buf || "");
      if (stdout.includes(expected)) finish();
    };
    const onStderr = (buf) => {
      stderr += String(buf || "");
    };
    const onExit = (code) => {
      finish(new Error(`Server exited early with code ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    };

    const timer = setTimeout(() => {
      finish(new Error(`Server did not start within ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, timeoutMs);

    proc.stdout.on("data", onStdout);
    proc.stderr.on("data", onStderr);
    proc.on("exit", onExit);
  });
}

async function requestJson(baseUrl, token, route, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (token) headers["X-Token"] = token;

  const req = {
    method: init.method || "GET",
    headers
  };

  if (init.body !== undefined) {
    req.body = JSON.stringify(init.body);
    req.headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${route}`, req);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

test("API smoke: auth, tile lifecycle, dry-run execution", { timeout: 40000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "streamdeck-remote-test-"));
  const configPath = path.join(tmpDir, "config.json");
  const port = 19000 + Math.floor(Math.random() * 400);
  const token = "TEST_TOKEN_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  const initialConfig = {
    host: "127.0.0.1",
    port,
    token,
    workspaceDir: tmpDir,
    rateLimit: { windowMs: 2000, max: 200 },
    wow: {
      processName: "DefinitelyNotRunning.exe",
      folders: {
        addons: tmpDir,
        logs: tmpDir,
        wtf: tmpDir
      }
    },
    logging: {
      enabled: false,
      dir: "",
      maxFiles: 7
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2), "utf8");

  const child = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      STREAMDECK_CONFIG_PATH: configPath,
      STREAMDECK_DRY_RUN: "1",
      STREAMDECK_DISABLE_AUTODETECT: "1"
    }
  });

  try {
    await waitForServerStart(child, port);
    const baseUrl = `http://127.0.0.1:${port}`;

    const unauthorized = await fetch(`${baseUrl}/api/health`);
    assert.equal(unauthorized.status, 401);

    const health = await requestJson(baseUrl, token, "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.body?.ok, true);
    assert.equal(health.body?.features?.dryRun, true);
    assert.equal(health.body?.features?.tileDetails, true);
    assert.equal(health.body?.features?.launcherAutodetect, false);

    const settings = await requestJson(baseUrl, token, "/api/settings");
    assert.equal(settings.status, 200);
    assert.equal(settings.body?.ok, true);
    assert.equal(typeof settings.body?.wow?.processName, "string");

    const createTile = await requestJson(baseUrl, token, "/api/tiles/upsert", {
      method: "POST",
      body: {
        tile: {
          profile: "work",
          page: "main",
          label: "CI Tile",
          subtitle: "initial",
          type: "action",
          action: "terminal",
          iconMode: "emoji",
          icon: "CI"
        }
      }
    });
    assert.equal(createTile.status, 200);
    assert.equal(createTile.body?.ok, true);
    const tileId = createTile.body?.tile?.id;
    assert.ok(typeof tileId === "string" && tileId.length > 0);

    const tileDetails = await requestJson(baseUrl, token, `/api/tiles/${encodeURIComponent(tileId)}`);
    assert.equal(tileDetails.status, 200);
    assert.equal(tileDetails.body?.tile?.label, "CI Tile");
    assert.equal(tileDetails.body?.tile?.type, "action");

    const updateTile = await requestJson(baseUrl, token, "/api/tiles/upsert", {
      method: "POST",
      body: {
        tile: {
          id: tileId,
          profile: "work",
          page: "main",
          label: "CI Tile Edited",
          subtitle: "updated",
          type: "action",
          action: "powershell",
          iconMode: "emoji",
          icon: "OK"
        }
      }
    });
    assert.equal(updateTile.status, 200);
    assert.equal(updateTile.body?.tile?.label, "CI Tile Edited");

    const runTile = await requestJson(baseUrl, token, "/api/run", {
      method: "POST",
      body: { tileId }
    });
    assert.equal(runTile.status, 200);
    assert.equal(runTile.body?.ok, true);

    const deleteTile = await requestJson(baseUrl, token, "/api/tiles/delete", {
      method: "POST",
      body: { id: tileId }
    });
    assert.equal(deleteTile.status, 200);
    assert.equal(deleteTile.body?.ok, true);

    const missingTile = await requestJson(baseUrl, token, `/api/tiles/${encodeURIComponent(tileId)}`);
    assert.equal(missingTile.status, 404);

    const logs = await requestJson(baseUrl, token, "/api/logs/recent?lines=25");
    assert.equal(logs.status, 200);
    assert.ok(Array.isArray(logs.body?.lines));

    const api404 = await requestJson(baseUrl, token, "/api/does-not-exist");
    assert.equal(api404.status, 404);
    assert.equal(api404.body?.ok, false);
    assert.equal(api404.body?.error, "api route not found");
  } finally {
    await stopProcess(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

