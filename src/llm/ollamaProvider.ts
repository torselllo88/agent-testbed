import { ProviderError, toProviderError, type ChatMessage, type CompletionRequest, type CompletionResult, type LlmProvider, type ProviderId } from "./provider.js";

export interface OllamaEndpointConfig {
  /** Logical name used in experiment configs ("endpoint": "lab-gpu"). */
  name: string;
  /** The Ollama server, e.g. http://localhost:11434 (a trailing /v1 is ignored). */
  baseUrl: string;
  /** Test seam: replaces fetch. */
  fetch?: typeof fetch;
}

/** Ollama's /api/chat response (the fields the testbed reads). Durations are in nanoseconds. */
interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string; thinking?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

const ms = (ns: number | undefined) => (typeof ns === "number" ? Math.round(ns / 1e6) : null);

/**
 * Whether a prompt probably did not fit the context window. Ollama truncates
 * an over-long prompt from the start without an error — dropping the system
 * prompt and an agent's private facts first — so this is worth flagging even
 * as a heuristic: the prompt is longer than the window even at an optimistic
 * 4 characters per token, or the evaluated prompt (as reported) all but fills
 * the window. It cannot prove the absence of truncation (a cached prompt
 * prefix is not counted in prompt_eval_count).
 */
export function contextOverflowSuspected(messages: ChatMessage[], contextLength: number | undefined, promptTokens: number | undefined): boolean {
  if (contextLength === undefined) return false;
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return chars / 4 > contextLength || (promptTokens !== undefined && promptTokens >= contextLength * 0.95);
}

/**
 * A self-hosted Ollama server, through its own chat API (/api/chat) rather
 * than its OpenAI-compatible one: only the native API takes per-request
 * thinking control ("think"), the context window ("num_ctx") and the seed
 * reliably — and a run must record these, not depend on how the server
 * happens to be configured. Registered like any self-hosted endpoint
 * ("openai-compatible:<name>"), with OPENAI_COMPATIBLE_<NAME>_API=ollama.
 */
export class OllamaProvider implements LlmProvider {
  readonly id: ProviderId;
  readonly endpoint: string;
  readonly baseUrl: string;
  readonly api = "ollama" as const;
  private readonly root: string;
  private readonly fetch: typeof fetch;

  constructor(config: OllamaEndpointConfig) {
    this.id = `openai-compatible:${config.name}`;
    this.endpoint = config.name;
    this.baseUrl = config.baseUrl;
    this.root = config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    this.fetch = config.fetch ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const label = `Ollama endpoint "${this.endpoint}" (model: ${request.model})`;
    const options: Record<string, number> = {};
    if (request.temperature !== undefined) options.temperature = request.temperature;
    if (request.seed !== undefined) options.seed = request.seed;
    if (request.maxOutputTokens !== undefined) options.num_predict = request.maxOutputTokens;
    if (request.contextLength !== undefined) options.num_ctx = request.contextLength;
    const body = {
      model: request.model,
      messages: request.messages,
      stream: false,
      ...(request.think !== undefined ? { think: request.think } : {}),
      ...(request.responseFormat ? { format: request.responseFormat.schema } : {}),
      ...(Object.keys(options).length ? { options } : {}),
    };

    let data: OllamaChatResponse;
    try {
      const res = await this.fetch(`${this.root}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: request.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const status = res.status;
        throw new ProviderError(`${label} request failed: HTTP ${status}: ${errorMessage(text)}`, status === 408 || status === 429 || status >= 500, status);
      }
      data = JSON.parse(text) as OllamaChatResponse;
    } catch (err) {
      throw toProviderError(err, `${label} request failed`);
    }

    const promptTokens = data.prompt_eval_count;
    const completionTokens = data.eval_count;
    const thinking = data.message?.thinking;
    const overflow = contextOverflowSuspected(request.messages, request.contextLength, promptTokens);
    return {
      text: data.message?.content ?? "",
      requestedModel: request.model,
      servedModel: data.model || request.model,
      usage:
        promptTokens !== undefined || completionTokens !== undefined
          ? { promptTokens: promptTokens ?? 0, completionTokens: completionTokens ?? 0 }
          : null,
      finishReason: data.done_reason,
      providerMeta: {
        endpoint: this.endpoint,
        api: "ollama",
        contextLength: request.contextLength ?? null,
        ...(overflow ? { contextOverflowSuspected: true } : {}),
        // Thinking the model did anyway (e.g. think was not switched off): kept, never parsed as the answer.
        ...(thinking ? { thinking } : {}),
        durationsMs: { total: ms(data.total_duration), load: ms(data.load_duration), promptEval: ms(data.prompt_eval_duration), eval: ms(data.eval_duration) },
      },
    };
  }

  /** The models the server has pulled (GET /api/tags) — offered in the editor. */
  async listModels(): Promise<string[]> {
    try {
      const res = await this.fetch(`${this.root}/api/tags`);
      const text = await res.text();
      if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${errorMessage(text)}`, res.status >= 500, res.status);
      const data = JSON.parse(text) as { models?: Array<{ name?: string; model?: string }> };
      return (data.models ?? []).map((m) => m.name ?? m.model ?? "").filter(Boolean).sort();
    } catch (err) {
      throw toProviderError(err, `Ollama endpoint "${this.endpoint}": listing models failed`);
    }
  }
}

function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // not JSON
  }
  return body.slice(0, 300) || "(empty response)";
}
