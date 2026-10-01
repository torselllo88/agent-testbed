import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { z } from "zod";
import { InvalidCommandError } from "../experiment/runner.js";
import { InteractionError } from "../interaction/service.js";
import { RoomApiError, type ExternalRoomService } from "../rooms/service.js";
import { decodeRouteParam, HttpError, readJsonBody, requireJsonContentType, sendJson } from "./http.js";

/**
 * The External Room API listener (docs/external-room-api.md). A separate
 * server from the operator UI: it serves ONLY /api/external/*, always behind
 * a bearer token, so the operator UI can stay on loopback while this one is
 * reachable by an external room adapter. The token is not encryption: put
 * TLS (reverse proxy) or a private network in front of it for remote use.
 *
 * Errors: { "error": { "code": "...", "message": "...", ...details } }.
 */

const ID = "([^/]+)";
const nonEmpty = z.string().trim().min(1);

const StartBody = z.object({
  scenarioId: nonEmpty,
  room: z.object({ provider: nonEmpty.max(100), roomId: nonEmpty.max(500) }),
  participants: z.array(z.object({ participantId: nonEmpty.max(100), externalUserId: nonEmpty.max(500) })).min(1).max(100),
  overrides: z.object({ conversationLanguage: nonEmpty.max(35).optional() }).strict().optional(),
});

const AckBody = z.object({
  acks: z
    .array(z.object({ messageId: nonEmpty.max(200), externalEventId: z.string().max(500).nullable().optional() }))
    .min(1)
    .max(500),
});

const InboundBody = z.object({
  externalEventId: nonEmpty.max(500),
  sender: z.object({ externalUserId: nonEmpty.max(500), displayName: nonEmpty.max(100) }),
  body: nonEmpty.max(4000),
  replyToExternalEventId: z.string().max(500).nullable().optional(),
  mentions: z.array(z.string().max(500)).max(20).optional(),
  timestamp: z.string().max(100).optional(),
});

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: string[];
  rooms: ExternalRoomService;
}

async function body<T>(req: http.IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    throw new RoomApiError(400, "INVALID_REQUEST", "Invalid request body", {
      problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    });
  }
  return parsed.data;
}

const intParam = (url: URL, name: string, fallback: number, max: number) => {
  const value = Number.parseInt(url.searchParams.get(name) ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, max) : fallback;
};

const ROUTES: Array<{ method: "GET" | "POST"; pattern: RegExp; handle(ctx: Ctx): Promise<void> | void }> = [
  {
    method: "GET",
    pattern: /^\/api\/external\/scenarios$/,
    handle: ({ res, rooms }) => sendJson(res, 200, { scenarios: rooms.listScenarios() }),
  },
  {
    method: "POST",
    pattern: /^\/api\/external\/bindings$/,
    handle: async ({ req, res, rooms }) => sendJson(res, 201, { binding: rooms.start(await body(req, StartBody)) }),
  },
  {
    method: "GET",
    pattern: /^\/api\/external\/bindings$/,
    handle: ({ res, url, rooms }) => {
      const provider = url.searchParams.get("provider");
      const roomId = url.searchParams.get("roomId");
      if (!provider || !roomId) throw new RoomApiError(400, "INVALID_REQUEST", "provider and roomId query parameters are required");
      sendJson(res, 200, { bindings: rooms.find(provider, roomId, url.searchParams.get("active") === "true") });
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/external/bindings/${ID}$`),
    handle: ({ res, params, rooms }) => sendJson(res, 200, { binding: rooms.view(decodeRouteParam(params[0]!)) }),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/external/bindings/${ID}/events$`),
    handle: async ({ req, res, url, params, rooms }) => {
      const abort = new AbortController();
      req.on("close", () => abort.abort());
      const result = await rooms.events(
        decodeRouteParam(params[0]!),
        intParam(url, "after", 0, Number.MAX_SAFE_INTEGER),
        intParam(url, "limit", 100, 500) || 100,
        intParam(url, "waitMs", 0, 25_000),
        abort.signal
      );
      if (!res.destroyed) sendJson(res, 200, result);
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/external/bindings/${ID}/acks$`),
    handle: async ({ req, res, params, rooms }) => sendJson(res, 200, rooms.ack(decodeRouteParam(params[0]!), (await body(req, AckBody)).acks)),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/external/bindings/${ID}/inbound$`),
    handle: async ({ req, res, params, rooms }) => {
      const result = await rooms.inbound(decodeRouteParam(params[0]!), await body(req, InboundBody));
      sendJson(res, result.status === "duplicate" ? 200 : 202, result);
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/external/bindings/${ID}/stop$`),
    handle: ({ req, res, params, rooms }) => {
      requireJsonContentType(req);
      sendJson(res, 200, { binding: rooms.stop(decodeRouteParam(params[0]!)) });
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/external/bindings/${ID}/close$`),
    handle: ({ req, res, params, rooms }) => {
      requireJsonContentType(req);
      sendJson(res, 200, { binding: rooms.close(decodeRouteParam(params[0]!)) });
    },
  },
];

const digest = (s: string) => createHash("sha256").update(s).digest();

function authorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  return Boolean(match) && timingSafeEqual(digest(match![1]!), digest(token));
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string, details: Record<string, unknown> = {}): void {
  if (res.headersSent) return;
  if (status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="external-room-api"');
  sendJson(res, status, { error: { code, message, ...details } });
}

export function createExternalApp(deps: { rooms: ExternalRoomService; token: string }): http.Server {
  return http.createServer(externalRequestHandler(deps));
}

/** The External Room API's request handler: its own listener, or mounted on the operator one (EXTERNAL_API_LISTENER=main). */
export function externalRequestHandler(deps: { rooms: ExternalRoomService; token: string }): http.RequestListener {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void (async () => {
      try {
        if (!url.pathname.startsWith("/api/external/")) return sendError(res, 404, "NOT_FOUND", "Not found");
        if (!authorized(req, deps.token)) return sendError(res, 401, "UNAUTHORIZED", "Missing or invalid bearer token");
        for (const route of ROUTES) {
          if (route.method !== req.method) continue;
          const match = route.pattern.exec(url.pathname);
          if (match) return await route.handle({ req, res, url, params: match.slice(1), rooms: deps.rooms });
        }
        sendError(res, 404, "NOT_FOUND", "Not found");
      } catch (err) {
        if (err instanceof RoomApiError) return sendError(res, err.status, err.code, err.message, err.details);
        if (err instanceof InteractionError) return sendError(res, err.status, err.status === 404 ? "NOT_FOUND" : "CONFLICT", err.message);
        if (err instanceof InvalidCommandError) return sendError(res, 409, "CONFLICT", err.message);
        if (err instanceof HttpError) return sendError(res, err.status, err.status === 415 ? "UNSUPPORTED_MEDIA_TYPE" : "INVALID_REQUEST", err.message);
        if (err instanceof Error && /^Experiment not found:/.test(err.message)) return sendError(res, 404, "NOT_FOUND", err.message);
        console.error(err);
        sendError(res, 500, "INTERNAL", err instanceof Error ? err.message : String(err));
      }
    })();
  };
}
