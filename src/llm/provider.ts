/**
 * Model-provider abstraction. Deliberately a raw "messages in, text out"
 * call rather than a typed structured-output helper: parsing, validation
 * and parse-retries live in the experiment's agent runtime, so every single
 * attempt — including one whose output fails to parse — is visible to the
 * caller with its own token usage and can be recorded in the trace.
 */

export type ProviderId = "openrouter" | "azure" | "stub";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A JSON Schema the provider should enforce natively when it can. */
export interface JsonResponseFormat {
  name: string;
  schema: Record<string, unknown>;
}

export interface CompletionRequest {
  /** Provider-specific model id (OpenRouter model id, Azure deployment name, stub script name). */
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  /** Best-effort only — providers honor it very differently, so it is recorded, never relied upon. */
  seed?: number;
  maxOutputTokens?: number;
  responseFormat?: JsonResponseFormat;
  signal?: AbortSignal;
  /**
   * Opaque caller context (e.g. which agent, which phase). Real providers
   * ignore it; the stub provider uses it to pick a scripted response.
   */
  context?: Record<string, unknown>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface CompletionResult {
  text: string;
  requestedModel: string;
  /** The model that actually served the request, as reported by the provider (aliases resolve here). */
  servedModel: string;
  /** null when the provider did not report usage. */
  usage: TokenUsage | null;
  /** Provider-reported cost, when available (OpenRouter reports it) — preferred over pricing-table estimates. */
  reportedCostUsd?: number;
  finishReason?: string;
  /** Non-secret provider details worth keeping in the trace (upstream provider name, generation id, ...). */
  providerMeta?: Record<string, unknown>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    /** Transient failures (rate limit, 5xx, network) are worth retrying; a 4xx request error is not. */
    public readonly retryable: boolean,
    public readonly status?: number
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface LlmProvider {
  readonly id: ProviderId;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

/** Shared by the OpenAI-SDK-based providers: maps an SDK/network error onto ProviderError. */
export function toProviderError(err: unknown, label: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const status = (err as { status?: unknown })?.status;
  const numericStatus = typeof status === "number" ? status : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const retryable = numericStatus === undefined || numericStatus === 408 || numericStatus === 429 || numericStatus >= 500;
  return new ProviderError(`${label}: ${message}`, retryable, numericStatus);
}
