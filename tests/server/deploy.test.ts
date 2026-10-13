import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveListener } from "../../src/config/env.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb, ownerAlive } from "../../src/persistence/db.js";
import { ScenarioRepository } from "../../src/persistence/scenarioRepository.js";
import { BUILTIN_SCENARIOS, createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { createApp, type AppDeps } from "../../src/server/app.js";
import { composeTestbed } from "../../src/server/compose.js";
import { createExternalApp, externalRequestHandler } from "../../src/server/externalApp.js";

/** Running on a platform host (e.g. Railway): operator token, health check, one public port, container pids. */

const OPERATOR_TOKEN = "operator-token-0123456789";
const EXTERNAL_TOKEN = "external-token-0123456789abcdef";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function start(extra: Partial<AppDeps> | ((t: ReturnType<typeof composeTestbed>) => Partial<AppDeps>) = {}) {
  const db = createInMemoryDb();
  new ScenarioRepository(db).syncBuiltins(BUILTIN_SCENARIOS);
  const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider()));
  const evaluators = createEvaluatorRegistry();
  const t = composeTestbed({ db, providers, evaluators, externalScenarios: ["station-kestrel"] });
  const server = createApp({ db, providers, evaluators, ...t, ...(typeof extra === "function" ? extra(t) : extra) });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });
  return { db, t, get };
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("OPERATOR_TOKEN", () => {
  it("rejects malformed URLs before auth and keeps serving requests", async () => {
    const { get, t } = await start({ operatorToken: OPERATOR_TOKEN });
    expect((await get("//[")).status).toBe(400);
    expect((await get("/api/meta")).status).toBe(401);
    expect((await get("/healthz")).status).toBe(200);

    const external = createExternalApp({ rooms: t.rooms!, token: EXTERNAL_TOKEN });
    servers.push(external);
    await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
    const port = (external.address() as AddressInfo).port;
    const rawGet = (path: string) => new Promise<number>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
    });
    expect(await rawGet("//[")).toBe(400);
    expect(await rawGet("/api/external/scenarios")).toBe(401);
  });
  it("guards the UI and the operator API: Basic (any user) or Bearer; nothing without it", async () => {
    const { get } = await start({ operatorToken: OPERATOR_TOKEN });
    const denied = await get("/api/meta");
    expect(denied.status).toBe(401);
    expect(denied.headers["www-authenticate"]).toMatch(/^Basic realm=/);
    expect((await get("/", {})).status).toBe(401); // the UI itself too
    expect((await get("/api/meta", { Authorization: basic("anyone", "wrong") })).status).toBe(401);
    expect((await get("/api/meta", { Authorization: basic("anyone", OPERATOR_TOKEN) })).status).toBe(200);
    expect((await get("/api/meta", { Authorization: `Bearer ${OPERATOR_TOKEN}` })).status).toBe(200);
  });

  it("unset: no authentication, as before (loopback use)", async () => {
    const { get } = await start();
    expect((await get("/api/meta")).status).toBe(200);
  });
});

describe("health check", () => {
  it("/healthz answers for any Host and without auth; nothing else does", async () => {
    const { get } = await start({ operatorToken: OPERATOR_TOKEN });
    const health = await get("/healthz", { Host: "healthcheck.railway.app" });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true });
    expect((await get("/api/meta", { Host: "healthcheck.railway.app", Authorization: basic("x", OPERATOR_TOKEN) })).status).toBe(421);
  });
});

describe("External Room API on the main listener (EXTERNAL_API_LISTENER=main)", () => {
  it("is served under /api/external with its own bearer token, for any Host, without the operator token", async () => {
    const mounted = await start((t) => ({ operatorToken: OPERATOR_TOKEN, externalApi: externalRequestHandler({ rooms: t.rooms!, token: EXTERNAL_TOKEN }) }));
    const ok = await mounted.get("/api/external/scenarios", { Host: "my-app.up.railway.app", Authorization: `Bearer ${EXTERNAL_TOKEN}` });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).scenarios.map((s: { id: string }) => s.id)).toContain("station-kestrel");
    const noToken = await mounted.get("/api/external/scenarios", { Host: "my-app.up.railway.app" });
    expect(noToken.status).toBe(401);
    expect(JSON.parse(noToken.body).error.code).toBe("UNAUTHORIZED");
    // The operator token is not an external token, and vice versa.
    expect((await mounted.get("/api/external/scenarios", { Authorization: `Bearer ${OPERATOR_TOKEN}` })).status).toBe(401);
    expect((await mounted.get("/api/meta", { Authorization: `Bearer ${EXTERNAL_TOKEN}` })).status).toBe(401);
  });
});

describe("process leases in a container", () => {
  it("another owner recorded with our own pid on this host is a previous process (pid 1 after a redeploy): gone at once", async () => {
    const { db } = await start();
    db.prepare(`INSERT INTO process_leases (owner_id, pid, host, heartbeat_at) VALUES ('proc_previous', ?, ?, ?)`).run(process.pid, os.hostname(), new Date().toISOString());
    expect(ownerAlive(db, "proc_previous")).toBe(false);
  });
});

describe("where the server listens", () => {
  it("GUI_HOST or HOST wins; Railway defaults to 0.0.0.0 and serves its generated domain; elsewhere loopback", () => {
    expect(resolveListener({})).toMatchObject({ host: "127.0.0.1", hostExplicit: false, platform: null, allowedHosts: [] });
    expect(resolveListener({ HOST: "0.0.0.0" })).toMatchObject({ host: "0.0.0.0", hostExplicit: true });
    expect(resolveListener({ GUI_HOST: "::", HOST: "0.0.0.0" }).host).toBe("::");
    const railway = resolveListener({ RAILWAY_ENVIRONMENT: "production", RAILWAY_PUBLIC_DOMAIN: "my-app.up.railway.app", GUI_ALLOWED_HOSTS: "lab.example.org" });
    expect(railway).toMatchObject({ host: "0.0.0.0", hostExplicit: false, platform: "railway", publicDomain: "my-app.up.railway.app" });
    expect(railway.allowedHosts).toEqual(["lab.example.org", "my-app.up.railway.app"]);
  });

  async function boot(env: Record<string, string>) {
    const port = await new Promise<number>((resolve) => {
      const probe = http.createServer().listen(0, "127.0.0.1", () => {
        const p = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-testbed-deploy-"));
    const child = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
      env: { ...process.env, OPENROUTER_API_KEY: "", OPERATOR_TOKEN: "", GUI_HOST: "", HOST: "", EXTERNAL_API_TOKEN: "", DATA_DIR: dataDir, PORT: String(port), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const cleanup = async () => {
      if (child.exitCode === null) {
        child.kill();
        await exited;
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    };
    return { port, child, exited, log: () => log, cleanup };
  }

  it("on Railway without OPERATOR_TOKEN it refuses to serve publicly, and says why", async () => {
    const s = await boot({ RAILWAY_ENVIRONMENT: "production" });
    const code = await s.exited;
    await s.cleanup();
    expect(code).toBe(1);
    expect(s.log()).toContain("without OPERATOR_TOKEN — refusing to serve publicly");
  }, 60_000);

  it("on Railway with OPERATOR_TOKEN it listens on all interfaces and serves the generated domain", async () => {
    const s = await boot({ RAILWAY_ENVIRONMENT: "production", RAILWAY_PUBLIC_DOMAIN: "my-app.up.railway.app", OPERATOR_TOKEN: "operator-token-0123456789" });
    try {
      // The startup block ends with the authentication line: wait for it, not for the first line.
      for (let i = 0; i < 100 && !s.log().includes("Operator authentication:"); i++) await new Promise((r) => setTimeout(r, 200));
      expect(s.log()).toContain("listening on 0.0.0.0:");
      expect(s.log()).toContain("Public URL: https://my-app.up.railway.app");
      const res = await fetch(`http://127.0.0.1:${s.port}/api/meta`, { headers: { Host: "my-app.up.railway.app", Authorization: "Bearer operator-token-0123456789" } });
      expect(res.status).toBe(200);
    } finally {
      await s.cleanup();
    }
  }, 60_000);
});
