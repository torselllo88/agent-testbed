import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTestbedVersion } from "../config/version.js";
import type { Db } from "../persistence/db.js";
import type { ProviderRegistry } from "../llm/registry.js";
import { HttpError, requireJsonContentType, sendJson, serveStatic } from "./http.js";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "gui", "public");

export interface AppDeps {
  db: Db;
  providers: ProviderRegistry;
}

interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: string[];
  url: URL;
  deps: AppDeps;
}

interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  pattern: RegExp;
  handle(ctx: RouteContext): Promise<void> | void;
}

const ROUTES: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/meta$/,
    handle: ({ res, deps }) =>
      sendJson(res, 200, {
        testbedVersion: getTestbedVersion(),
        providers: deps.providers.status(),
        stubModels: deps.providers.stub.models(),
      }),
  },
];

function errorStatusAndMessage(err: unknown): { status: number; message: string } {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  return { status: 500, message: err instanceof Error ? err.message : String(err) };
}

export function createApp(deps: AppDeps): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    void (async () => {
      try {
        if (req.method === "POST" || req.method === "PUT") requireJsonContentType(req);

        for (const route of ROUTES) {
          if (route.method !== req.method) continue;
          const match = route.pattern.exec(url.pathname);
          if (match) return await route.handle({ req, res, params: match.slice(1), url, deps });
        }

        if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });
        if (req.method === "GET") return serveStatic(res, PUBLIC_DIR, url.pathname);
        sendJson(res, 405, { error: "Method not allowed" });
      } catch (err) {
        const { status, message } = errorStatusAndMessage(err);
        if (status >= 500) console.error(err);
        if (!res.headersSent) sendJson(res, status, { error: message });
      }
    })();
  });
}
