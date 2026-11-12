import http from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { answer } from "./fakeOpenAiServer.js";

/**
 * A stand-in for an Ollama server's own API: GET /api/tags and POST /api/chat
 * over real HTTP, answering the testbed's protocol like the fake
 * OpenAI-compatible server (everyone ready, the Space Station's safe plan,
 * everyone approves). It records every request body as sent, so tests can
 * check what reached the server (think, options, format).
 *
 *   node --import tsx tests/helpers/fakeOllamaServer.ts --port 11434
 */

export const FAKE_OLLAMA_MODELS = ["qwen-fake:27b", "qwen-fake:14b"];

export interface OllamaChatBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  think?: boolean;
  format?: unknown;
  options?: Record<string, number>;
}

export interface FakeOllamaServer {
  url: string;
  requests: OllamaChatBody[];
  /** Replaces the next responses: a status and body, or extra fields merged into a normal answer. */
  respondWith(next: { status?: number; body?: unknown; extra?: Record<string, unknown> }): void;
  close(): Promise<void>;
}

export async function startFakeOllamaServer(port = 0, host = "127.0.0.1"): Promise<FakeOllamaServer> {
  const requests: OllamaChatBody[] = [];
  const queued: Array<{ status?: number; body?: unknown; extra?: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/api/tags") {
      return send(200, { models: FAKE_OLLAMA_MODELS.map((name) => ({ name, model: name, size: 1 })) });
    }
    if (req.method !== "POST" || req.url !== "/api/chat") return send(404, { error: "not found" });
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as OllamaChatBody;
      requests.push(body);
      const next = queued.shift();
      if (next?.status) return send(next.status, next.body ?? { error: "failure" });
      if (!FAKE_OLLAMA_MODELS.includes(body.model)) return send(404, { error: `model "${body.model}" not found, try pulling it first` });
      send(200, {
        model: body.model,
        created_at: "2000-01-01T00:00:00Z",
        message: { role: "assistant", content: JSON.stringify(answer(body)) },
        done: true,
        done_reason: "stop",
        total_duration: 2_500_000_000,
        load_duration: 1_000_000_000,
        prompt_eval_count: 900,
        prompt_eval_duration: 500_000_000,
        eval_count: 40,
        eval_duration: 1_000_000_000,
        ...(next?.extra ?? {}),
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}`,
    requests,
    respondWith: (next) => queued.push(next),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const portArg = process.argv.indexOf("--port");
  const fake = await startFakeOllamaServer(portArg >= 0 ? Number(process.argv[portArg + 1]) : 11434);
  console.log(`fake Ollama server at ${fake.url}`);
}
