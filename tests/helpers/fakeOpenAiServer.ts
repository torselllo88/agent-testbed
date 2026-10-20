import http from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

/**
 * A stand-in for a self-hosted OpenAI-compatible model server (vLLM, TGI, …):
 * GET /v1/models and POST /v1/chat/completions over real HTTP, answering the
 * testbed's protocol deterministically — every agent declares ready, the
 * proposer submits the Space Station's safe plan, everyone approves. Used by
 * the unit tests in-process and, run as a script, by the browser checks.
 *
 *   node --import tsx tests/helpers/fakeOpenAiServer.ts --port 8000
 */

export const FAKE_MODELS = ["lab/fake-model-7b", "lab/fake-model-70b"];

const SAFE_PLAN = {
  shed_loads: ["research_labs", "external_communications"],
  coolant_loop: "B",
  coolant_power_kw: 30,
  scram_reactor: true,
  life_support_power_kw: 40,
  vent_reactor_section: false,
};

interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  response_format?: { type: string; json_schema?: { name?: string } };
}

/** What the testbed asked for: the schema name when sent natively, otherwise inferred from the prompt. */
function kindOf(req: ChatRequest): string {
  const named = req.response_format?.json_schema?.name;
  if (named) return named;
  const text = req.messages.map((m) => m.content).join("\n");
  if (text.includes("VOTING phase")) return "vote";
  if (text.includes("submit the room's final proposal")) return "final_proposal";
  if (text.includes("Choose the next speaker from")) return "next_speaker";
  return "agent_turn";
}

function answer(req: ChatRequest): Record<string, unknown> {
  switch (kindOf(req)) {
    case "final_proposal":
      return { rationale: "Shed both nonessential loads and run loop B.", proposal: SAFE_PLAN };
    case "vote":
      return { vote: "APPROVE", reason: "The plan is safe as written." };
    case "next_speaker": {
      const user = req.messages.at(-1)?.content ?? "";
      const candidates = /Choose the next speaker from: ([^.\n]+)/.exec(user)?.[1]?.split(",").map((s) => s.trim()) ?? [];
      return { nextAgentId: candidates[0] ?? "", reason: "next in line" };
    }
    case "debrief_route":
      return { agentId: null, confident: false, reason: "no clear addressee" };
    case "debrief_answer":
      return { message: "We pooled our facts and the plan held." };
    default:
      return { message: "", pass: true, target: null, intent: null, readyToCommit: true };
  }
}

export interface FakeOpenAiServer {
  url: string;
  /** Every chat-completion request received (model, schema name or inferred kind, auth header). */
  requests: Array<{ model: string; kind: string; native: boolean; authorization: string | undefined }>;
  close(): Promise<void>;
}

export async function startFakeOpenAiServer(port = 0, host = "127.0.0.1"): Promise<FakeOpenAiServer> {
  const requests: FakeOpenAiServer["requests"] = [];
  let seq = 0;
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/v1/models") {
      return send(200, { object: "list", data: FAKE_MODELS.map((id) => ({ id, object: "model", owned_by: "lab" })) });
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return send(404, { error: { message: "not found" } });
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as ChatRequest;
      requests.push({ model: body.model, kind: kindOf(body), native: Boolean(body.response_format), authorization: req.headers.authorization });
      if (!FAKE_MODELS.includes(body.model)) return send(404, { error: { message: `model "${body.model}" is not served here`, type: "NotFoundError" } });
      const content = JSON.stringify(answer(body));
      seq += 1;
      send(200, {
        id: `chatcmpl-fake-${seq}`,
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Run as a script: the browser checks start it as a separate process.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 8000;
  const fake = await startFakeOpenAiServer(port);
  console.log(`fake OpenAI-compatible server at ${fake.url}`);
}
