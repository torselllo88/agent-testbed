import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProviderRegistryFromEnv } from "../../src/llm/registry.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { createApp } from "../../src/server/app.js";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApp({ db: createInMemoryDb(), providers: createProviderRegistryFromEnv() });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("HTTP app", () => {
  it("serves /api/meta with provider status and testbed version", async () => {
    const res = await fetch(`${baseUrl}/api/meta`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: Array<{ id: string; configured: boolean }>; testbedVersion: { packageVersion: string } };
    expect(body.providers.map((p) => p.id)).toEqual(["openrouter", "azure", "stub"]);
    expect(body.testbedVersion.packageVersion).toBe("0.1.0");
  });

  it("serves the SPA shell", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Agent Testbed</title>");
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const res = await fetch(`${baseUrl}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("refuses POST without a JSON content type (no preflight-free cross-origin writes)", async () => {
    const res = await fetch(`${baseUrl}/api/meta`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(res.status).toBe(415);
  });
});
