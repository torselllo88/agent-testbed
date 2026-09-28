import type { z } from "zod";
import { estimateCostUsd } from "../llm/pricing.js";
import { ProviderError, type ChatMessage, type CompletionResult } from "../llm/provider.js";
import type { ProviderRegistry } from "../llm/registry.js";
import type { BudgetTracker, UsageCategory } from "./budget.js";
import type { ModelRef, RuntimeConfig } from "./config.js";
import { EventType, type EventLog } from "./events.js";
import { termination, TerminateRun } from "./outcome.js";
import { parseWithSchema } from "./parseJson.js";

export type CallPurpose = "discussion" | "proposal" | "vote" | "router";

export interface LlmCallSpec<T> {
  category: UsageCategory;
  purpose: CallPurpose;
  /** The agent this call is made for; null for orchestration calls (router). */
  agentId: string | null;
  modelRef: ModelRef;
  messages: ChatMessage[];
  response: {
    name: string;
    /** Parses and validates the extracted JSON object. */
    schema: z.ZodType<T, z.ZodTypeDef, unknown>;
    /** Sent to the provider when modelRef.structuredOutput is "native". */
    jsonSchema: Record<string, unknown>;
  };
  /** Opaque context for the stub provider (e.g. { agentId, purpose, agentTurn }). */
  context?: Record<string, unknown>;
  turn?: number;
}

export type LlmCallResult<T> =
  | { ok: true; value: T; rawText: string; attempts: number }
  | { ok: false; parseError: string; rawText: string; attempts: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The one place an LLM is called from during an experiment. Each provider
 * attempt — including transient-failure retries and parse retries — is
 * recorded as its own llm_call event with the full rendered prompt, the raw
 * response and its usage, and counted in the budget. A response that cannot
 * be parsed is re-asked (same activation) up to runtime.maxParseRetries
 * times; the caller decides what a final parse failure means.
 *
 * Provider failures that survive the retries end the run (PROVIDER_ERROR).
 */
export class LlmCaller {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly log: EventLog,
    private readonly budget: BudgetTracker,
    private readonly runtime: RuntimeConfig,
    /** Aborted by the runner on operator stop; its reason is a TerminateRun. */
    private readonly runSignal: AbortSignal
  ) {}

  async call<T>(spec: LlmCallSpec<T>): Promise<LlmCallResult<T>> {
    const messages = [...spec.messages];
    let lastError = "";
    let lastText = "";
    let attempts = 0;

    for (let parseAttempt = 0; parseAttempt <= this.runtime.maxParseRetries; parseAttempt++) {
      if (parseAttempt > 0) {
        messages.push(
          { role: "assistant", content: lastText },
          {
            role: "user",
            content: `Your previous response could not be used (${lastError}). Respond again with ONLY a single JSON object in the required format — no other text.`,
          }
        );
      }

      const completion = await this.completeWithRetries(spec, messages, parseAttempt);
      attempts += completion.providerAttempts;
      lastText = completion.result.text;

      const parsed = parseWithSchema(lastText, spec.response.schema);
      this.log.append(
        EventType.LLM_CALL,
        { ...completion.eventPayload, parseOk: parsed.ok, ...(parsed.ok ? {} : { parseError: parsed.error }) },
        spec.agentId
      );
      if (parsed.ok) return { ok: true, value: parsed.value, rawText: lastText, attempts };
      lastError = parsed.error;
    }

    return { ok: false, parseError: lastError, rawText: lastText, attempts };
  }

  /**
   * Returns the first successful completion (its llm_call event is appended
   * by call(), once parsing is known). Failed provider attempts are logged
   * and budgeted here, as they happen.
   */
  private async completeWithRetries(
    spec: LlmCallSpec<unknown>,
    messages: ChatMessage[],
    parseAttempt: number
  ): Promise<{ result: CompletionResult; providerAttempts: number; eventPayload: Record<string, unknown> }> {
    const provider = this.providers.get(spec.modelRef.provider);
    const native = spec.modelRef.structuredOutput === "native";

    for (let providerAttempt = 0; ; providerAttempt++) {
      this.throwIfStopped();
      this.throwIfOutOfTime();

      // Process-wide provider request gate. The slot is taken BEFORE the
      // call's own timeout starts, so queueing never eats into it; the wait
      // is recorded separately so provider latency stays measurable.
      const queuedAt = Date.now();
      const release = await this.acquireSlot(spec.modelRef.provider);
      const queueWaitMs = Date.now() - queuedAt;

      const startedAt = Date.now();
      const base = {
        category: spec.category,
        purpose: spec.purpose,
        turn: spec.turn ?? null,
        provider: provider.id,
        requestedModel: spec.modelRef.model,
        temperature: spec.modelRef.temperature ?? null,
        seed: spec.modelRef.seed ?? null,
        structuredOutput: spec.modelRef.structuredOutput,
        responseFormat: spec.response.name,
        parseAttempt,
        providerAttempt,
        queueWaitMs,
        messages,
      };

      try {
        const result = await provider.complete({
          model: spec.modelRef.model,
          messages,
          temperature: spec.modelRef.temperature,
          seed: spec.modelRef.seed,
          maxOutputTokens: spec.modelRef.maxOutputTokens,
          responseFormat: native ? { name: spec.response.name, schema: spec.response.jsonSchema } : undefined,
          signal: this.callSignal(),
          context: spec.context,
        });
        release();
        const { costUsd, costSource } = resolveCost(result);
        this.budget.recordCall(spec.category, result.usage, costUsd);
        return {
          result,
          providerAttempts: providerAttempt + 1,
          eventPayload: {
            ...base,
            servedModel: result.servedModel,
            responseText: result.text,
            finishReason: result.finishReason ?? null,
            usage: result.usage,
            costUsd: costUsd ?? null,
            costSource,
            providerMeta: result.providerMeta ?? null,
            durationMs: Date.now() - startedAt,
          },
        };
      } catch (err) {
        release(); // before any retry backoff
        // Every attempt is logged — including one cut short by operator stop
        // or the time limit, which a real provider may still have billed.
        const stopped = this.runSignal.aborted;
        const outOfTime = !stopped && this.budget.checkTimeLimit() !== null;
        const providerError =
          err instanceof ProviderError
            ? err
            : stopped
              ? new ProviderError("Call aborted: experiment stopped by operator", false)
              : outOfTime
                ? new ProviderError("Call aborted: experiment time limit reached", false)
                : isAbortError(err)
                  ? new ProviderError(`Call timed out after ${this.runtime.callTimeoutSeconds}s`, true)
                  : new ProviderError(err instanceof Error ? err.message : String(err), true);

        this.budget.recordCall(spec.category, null, undefined);
        this.log.append(
          EventType.LLM_CALL,
          {
            ...base,
            error: {
              message: providerError.message,
              status: providerError.status ?? null,
              retryable: providerError.retryable,
              aborted: stopped || outOfTime,
            },
            usage: null,
            costUsd: null,
            costSource: "unknown",
            durationMs: Date.now() - startedAt,
          },
          spec.agentId
        );

        this.throwIfStopped();
        this.throwIfOutOfTime();
        if (!providerError.retryable || providerAttempt >= this.runtime.maxProviderRetries) {
          throw new TerminateRun(
            termination("PROVIDER_ERROR", providerError.message, {
              provider: provider.id,
              model: spec.modelRef.model,
              purpose: spec.purpose,
              agentId: spec.agentId,
              attempts: providerAttempt + 1,
              status: providerError.status ?? null,
            })
          );
        }
        await sleep(this.runtime.providerRetryDelayMs * 2 ** providerAttempt);
      }
    }
  }

  /** Waits for a request slot; a stop or the experiment time limit ends the wait (queued time counts as experiment time). */
  private async acquireSlot(providerId: ModelRef["provider"]): Promise<() => void> {
    const gate = this.providers.gate(providerId);
    if (!gate) return () => {};
    const remaining = this.budget.remainingMs();
    const signal = remaining === null ? this.runSignal : AbortSignal.any([this.runSignal, AbortSignal.timeout(Math.max(1, remaining))]);
    try {
      return await gate.acquire(signal);
    } catch {
      this.throwIfStopped();
      this.throwIfOutOfTime();
      throw new TerminateRun(termination("TIMEOUT", "Time limit reached while waiting for a provider request slot"));
    }
  }

  /** Aborts on operator stop, on the per-call timeout, or when the experiment's time limit runs out mid-call. */
  private callSignal(): AbortSignal {
    const remaining = this.budget.remainingMs();
    const timeoutMs = Math.max(1, Math.min(this.runtime.callTimeoutSeconds * 1000, remaining ?? Infinity));
    return AbortSignal.any([this.runSignal, AbortSignal.timeout(timeoutMs)]);
  }

  private throwIfOutOfTime(): void {
    const hit = this.budget.checkTimeLimit();
    if (hit) throw new TerminateRun(hit);
  }

  private throwIfStopped(): void {
    if (this.runSignal.aborted) {
      const reason: unknown = this.runSignal.reason;
      throw reason instanceof TerminateRun ? reason : new TerminateRun(termination("STOPPED_BY_OPERATOR", "Stopped"));
    }
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError" || /abort/i.test(err.message));
}

function resolveCost(result: CompletionResult): { costUsd: number | undefined; costSource: "reported" | "estimated" | "unknown" } {
  if (result.reportedCostUsd !== undefined) return { costUsd: result.reportedCostUsd, costSource: "reported" };
  const estimated = estimateCostUsd(result.servedModel, result.usage) ?? estimateCostUsd(result.requestedModel, result.usage);
  return estimated !== undefined ? { costUsd: estimated, costSource: "estimated" } : { costUsd: undefined, costSource: "unknown" };
}
