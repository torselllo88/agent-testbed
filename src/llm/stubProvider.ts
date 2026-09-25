import { ProviderError, type CompletionRequest, type CompletionResult, type LlmProvider } from "./provider.js";

/**
 * Returns the raw response text for one call. Receives the full request, so
 * a script can branch on `request.context` (agent id, phase, turn index) —
 * never on hidden evaluator state, which it has no access to.
 */
export type StubResponder = (request: CompletionRequest) => string;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

/** Rough chars/4 heuristic — lets token budgets behave realistically in stub runs and tests. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Deterministic, network-free provider. `model` names a registered script
 * (e.g. "space-station/cooperative"), so a scenario can ship scripted agents
 * that run end-to-end with no API key — used by tests, CI and offline demos.
 */
export class StubProvider implements LlmProvider {
  readonly id = "stub" as const;
  private readonly scripts = new Map<string, StubResponder>();

  /** Artificial per-call latency, so a stub run can be watched live in the UI. 0 in tests. */
  constructor(private readonly latencyMs = 0) {}

  get latency(): number {
    return this.latencyMs;
  }

  /** Same scripts, different latency — e.g. batch runs at 0 ms regardless of the web demo's setting. */
  withLatency(latencyMs: number): StubProvider {
    const copy = new StubProvider(latencyMs);
    for (const [model, responder] of this.scripts) copy.register(model, responder);
    return copy;
  }

  register(model: string, responder: StubResponder): this {
    this.scripts.set(model, responder);
    return this;
  }

  models(): string[] {
    return [...this.scripts.keys()].sort();
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const responder = this.scripts.get(request.model);
    if (!responder) {
      throw new ProviderError(`Stub provider: no script registered for model "${request.model}"`, false, 400);
    }
    if (this.latencyMs > 0) await delay(this.latencyMs, request.signal);
    const text = responder(request);
    const promptText = request.messages.map((m) => m.content).join("\n");
    return {
      text,
      requestedModel: request.model,
      servedModel: `stub/${request.model}`,
      usage: { promptTokens: estimateTokens(promptText), completionTokens: estimateTokens(text) },
      finishReason: "stop",
    };
  }
}
