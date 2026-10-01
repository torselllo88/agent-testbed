import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb, ownerAlive } from "../../src/persistence/db.js";
import { ScenarioRepository } from "../../src/persistence/scenarioRepository.js";
import { BUILTIN_SCENARIOS, createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { createApp, type AppDeps } from "../../src/server/app.js";
import { composeTestbed } from "../../src/server/compose.js";
import { externalRequestHandler } from "../../src/server/externalApp.js";

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
