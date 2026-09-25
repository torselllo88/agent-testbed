import fs from "node:fs";
import type http from "node:http";
import path from "node:path";

/**
 * Tiny HTTP helpers over Node's built-in http module — no framework: the
 * route surface is small and this keeps request handling fully visible.
 */

/** Thrown for a client-caused request problem — mapped straight to its own status code instead of a generic 500. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// A cross-origin <form enctype="text/plain"> POST needs no CORS preflight.
// Requiring the exact application/json content type this app's own frontend
// sends forces any cross-origin attempt through a preflight instead — which
// this server never opts into, so the browser blocks it. Checked for every
// POST/PUT, including body-less action routes.
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(;.*)?$/i;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export function requireJsonContentType(req: http.IncomingMessage): void {
  const contentType = (req.headers["content-type"] ?? "").trim();
  if (!JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
}

export async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  requireJsonContentType(req);

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += (chunk as Buffer).length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new HttpError(413, `Request body exceeds the ${MAX_BODY_BYTES}-byte limit`);
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

/** Guards every percent-decoded route param — a malformed sequence (e.g. a lone "%") throws URIError, which would otherwise surface as a 500. */
export function decodeRouteParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "Malformed URL segment");
  }
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export function serveStatic(res: http.ServerResponse, publicDir: string, urlPath: string): void {
  const relative = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const filePath = path.join(publicDir, relative);

  // Refuse to resolve outside publicDir (e.g. "..%2f..").
  if (!filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  });
}
