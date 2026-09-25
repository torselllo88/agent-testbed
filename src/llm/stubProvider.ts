import { ProviderError, type CompletionRequest, type CompletionResult, type LlmProvider } from "./provider.js";

/**
 * Returns the raw response text for one call. Receives the full request, so
 * a script can branch on `request.context` (agent id, phase, turn index) —
 * never on hidden evaluator state, which it has no access to.
 */
export type StubResponder = (request: CompletionRequest) => string;

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
