#!/usr/bin/env node
// Browser end-to-end checks: starts two keyless testbed servers (one plain, one behind OPERATOR_TOKEN) on free
// ports with throw-away databases, a headless Chrome, then runs every suite in tests/e2e/suites and the reference
// room adapter (src/cli/roomMock.ts). Never reads your .env keys, never calls a real provider.
//
//   npm run test:e2e                 all suites
//   npm run test:e2e -- debrief auth only these
//   CHROME_PATH=/path/to/chrome      if Chrome is not found automatically
//   E2E_OUT=dir                      screenshots (default .e2e-out)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUITES_DIR = path.join(ROOT, "tests", "e2e", "suites");
const OUT = path.resolve(process.env.E2E_OUT ?? path.join(ROOT, ".e2e-out"));
const EXT_TOKEN = "e2e-external-token-0123456789abcdef";
const OPERATOR_TOKEN = "e2e-operator-token-0123456789";
const SUITE_TIMEOUT_MS = 6 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
const tempDirs = [];

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates =
    process.platform === "win32"
      ? [
          `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
        : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const c of candidates) {
    if (path.isAbsolute(c) ? fs.existsSync(c) : spawnSync("which", [c]).status === 0) return c;
  }
  throw new Error("Chrome not found — set CHROME_PATH");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-testbed-e2e-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

/** A keyless server: every credential set to empty, so .env never fills it in (dotenv does not override). */
function startServer(label, env) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "",
      AZURE_OPENAI_API_KEY: "",
      AZURE_OPENAI_ENDPOINT: "",
      OPENAI_COMPATIBLE_ENDPOINTS: "",
      OPERATOR_TOKEN: "",
      EXTERNAL_API_TOKEN: "",
      EXTERNAL_API_LISTENER: "",
      GUI_ALLOWED_HOSTS: "",
      GUI_HOST: "127.0.0.1",
      STUB_LATENCY_MS: "300",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  children.push(child);
  return { child, label, log: () => log };
}

async function waitUntil(url, label, timeoutMs = 60_000, init) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url, init)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  throw new Error(`${label} did not come up (${url})`);
}

function run(label, args, env, timeoutMs = SUITE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => {
      output += `\nTIMEOUT after ${timeoutMs / 1000}s`;
      child.kill();
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ label, ok: code === 0, output });
    });
  });
}

function killAll() {
  for (const child of children) {
    if (child.exitCode !== null || child.killed) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else {
      try {
        process.kill(-child.pid, "SIGKILL"); // Chrome runs in its own process group
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
}

async function main() {
  const only = process.argv.slice(2);
  const suites = fs
    .readdirSync(SUITES_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => f.slice(0, -4))
    .sort()
    .filter((name) => only.length === 0 || only.includes(name));
  const withRoomMock = only.length === 0 || only.includes("room-mock");
  fs.mkdirSync(OUT, { recursive: true });

  const [appPort, extPort, securePort, cdpPort, modelPort] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
  const app = `http://127.0.0.1:${appPort}`;
  const secureApp = `http://127.0.0.1:${securePort}`;
  const cdp = `http://127.0.0.1:${cdpPort}`;

  // A stand-in for a lab's self-hosted OpenAI-compatible model server (tests/helpers/fakeOpenAiServer.ts).
  const fakeModels = spawn(process.execPath, ["--import", "tsx", "tests/helpers/fakeOpenAiServer.ts", "--port", String(modelPort)], { cwd: ROOT, stdio: "ignore" });
  children.push(fakeModels);

  const servers = [
    startServer("server", {
      OPENAI_COMPATIBLE_ENDPOINTS: "lab-fake",
      OPENAI_COMPATIBLE_LAB_FAKE_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      DATA_DIR: tempDir("data"),
      GUI_PORT: String(appPort),
      PORT: String(appPort),
      EXTERNAL_API_TOKEN: EXT_TOKEN,
      EXTERNAL_API_PORT: String(extPort),
      EXTERNAL_SCENARIOS: "station-kestrel",
    }),
    startServer("secure server", { DATA_DIR: tempDir("secure"), GUI_PORT: String(securePort), PORT: String(securePort), OPERATOR_TOKEN }),
  ];
  const chrome = spawn(
    findChrome(),
    [
      "--headless=new",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${tempDir("chrome")}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      ...(process.env.CI ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: "ignore", detached: process.platform !== "win32" }
  );
  children.push(chrome);

  try {
    await waitUntil(`http://127.0.0.1:${modelPort}/v1/models`, "fake model server");
    await waitUntil(`${app}/healthz`, "server");
    await waitUntil(`${secureApp}/healthz`, "secure server");
    await waitUntil(`${cdp}/json/version`, "Chrome");
  } catch (err) {
    for (const s of servers) console.error(`--- ${s.label} log ---\n${s.log()}`);
    throw err;
  }

  const env = {
    E2E_APP: app,
    E2E_CDP: cdp,
    E2E_EXT: `http://127.0.0.1:${extPort}/api/external`,
    E2E_EXT_TOKEN: EXT_TOKEN,
    E2E_SECURE_APP: secureApp,
    E2E_OPERATOR_TOKEN: OPERATOR_TOKEN,
    E2E_OUT: OUT,
  };
  const results = [];
  for (const name of suites) {
    process.stdout.write(`▶ ${name} … `);
    const result = await run(name, [path.join(SUITES_DIR, `${name}.mjs`)], env);
    console.log(result.ok ? "ok" : "FAILED");
    console.log(result.output.trim().replace(/^/gm, "    "));
    results.push(result);
  }
  if (withRoomMock) {
    process.stdout.write("▶ room-mock (reference adapter) … ");
    const result = await run("room-mock", ["--import", "tsx", "src/cli/roomMock.ts", "--url", `http://127.0.0.1:${extPort}`], { EXTERNAL_API_TOKEN: EXT_TOKEN });
    result.ok &&= /outcome SUCCESS, binding closed/.test(result.output);
    console.log(result.ok ? "ok" : "FAILED");
    console.log(result.output.trim().split("\n").slice(-3).join("\n").replace(/^/gm, "    "));
    results.push(result);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` — failed: ${failed.map((r) => r.label).join(", ")} (screenshots in ${OUT})` : ""}`);
  if (failed.length) for (const s of servers) console.log(`--- ${s.label} log (tail) ---\n${s.log().split("\n").slice(-30).join("\n")}`);
  return failed.length ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(err);
} finally {
  killAll();
  await sleep(500);
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      // Chrome on Windows may hold its profile a moment longer; the OS temp dir cleans up eventually.
    }
  }
}
process.exit(code);
