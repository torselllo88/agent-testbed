import type { z } from "zod";
import { estimateCostUsd } from "../llm/pricing.js";
import { ProviderError, type ChatMessage, type CompletionResult, type ProviderId } from "../llm/provider.js";
import type { ProviderRegistry } from "../llm/registry.js";
import type { BudgetTracker, UsageCategory } from "./budget.js";
import { effectiveOpenRouterRouting, modelProviderKey, type ModelRef, type RuntimeConfig } from "./config.js";
import { EventType } from "./events.js";
import { termination, TerminateRun } from "./outcome.js";
import { parseWithSchema } from "./parseJson.js";
import { PROTOCOL_FEEDBACK } from "./protocol.js";

export type CallPurpose = "discussion" | "proposal" | "vote" | "router";

/**
 * Where every call attempt is recorded, and what it is budgeted against. For
 * a run these are its EventLog and BudgetTracker; a subsystem outside the
 * experiment (e.g. the post-run debrief) passes its own, so its calls never
 * enter the experiment's trace or usage.
 */
export interface CallLog {
  append(type: typeof EventType.LLM_CALL, payload: Record<string, unknown>, agentId: string | null): unknown;
}
export type CallBudget = Pick<BudgetTracker, "recordCall" | "remainingMs" | "checkTimeLimit">;

export interface LlmCallSpec<T> {
  category: UsageCategory;
  /** A run's calls use CallPurpose; other callers name their own purposes. */
  purpose: CallPurpose | (string & {});
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

/** A delay in ms as timers accept it: a whole number within Node's 32-bit timer range (fractional or huge values throw or fire at once). */
export function timerMs(ms: number): number {
  return Math.min(2_147_483_647, Math.max(1, Math.ceil(ms)));
}

/** Resolves after ms, or as soon as the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, timerMs(ms));
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

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
    private readonly log: CallLog,
    private readonly budget: CallBudget,
    private readonly runtime: RuntimeConfig,
    /** Aborted by the runner on operator stop; its reason is a TerminateRun. */
    private readonly runSignal: AbortSignal,
    /** A separate provider request pool (see ProviderRegistryOptions.poolLimits); experiments use the default one. */
    private readonly pool?: string
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
            content: PROTOCOL_FEEDBACK.parseRetry(lastError),
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
    const providerKey = modelProviderKey(spec.modelRef) as ProviderId;
    const provider = this.providers.get(providerKey);
    const native = spec.modelRef.structuredOutput === "native";
    const routing = effectiveOpenRouterRouting(spec.modelRef);

    for (let providerAttempt = 0; ; providerAttempt++) {
      this.throwIfStopped();
      this.throwIfOutOfTime();

      // Process-wide provider request gate. The slot is taken BEFORE the
      // call's own timeout starts, so queueing never eats into it; the wait
      // is recorded separately so provider latency stays measurable.
      const queuedAt = Date.now();
      const release = await this.acquireSlot(providerKey);
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
        // Serving options of a self-hosted endpoint, as sent (null: the server's default).
        think: spec.modelRef.think ?? null,
        contextLength: spec.modelRef.contextLength ?? null,
        structuredOutput: spec.modelRef.structuredOutput,
        responseFormat: spec.response.name,
        parseAttempt,
        providerAttempt,
        queueWaitMs,
        // Requested (as configured) and effective (with defaults applied) routing; the backend
        // that actually served the call is in providerMeta.upstreamProvider (a display name,
        // not a slug — never compared to these by string).
        routing: routing ? { requested: spec.modelRef.routing ?? null, effective: routing } : null,
        messages,
      };

      const signal = this.callSignal();
      try {
        const result = await provider.complete({
          model: spec.modelRef.model,
          messages,
          temperature: spec.modelRef.temperature,
          seed: spec.modelRef.seed,
          maxOutputTokens: spec.modelRef.maxOutputTokens,
          think: spec.modelRef.think,
          contextLength: spec.modelRef.contextLength,
          responseFormat: native ? { name: spec.response.name, schema: spec.response.jsonSchema } : undefined,
          routing: routing ?? undefined,
          signal,
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
        // Our own signals first: a provider SDK may wrap the abort in its own error type.
        const timedOut = !stopped && !outOfTime && signal.aborted;
        const providerError = stopped
          ? new ProviderError("Call aborted: experiment stopped by operator", false)
          : outOfTime
            ? new ProviderError("Call aborted: experiment time limit reached", false)
            : timedOut
              ? new ProviderError(`Call timed out after ${this.runtime.callTimeoutSeconds}s`, true)
              : err instanceof ProviderError
                ? err
                : isAbortError(err)
                  ? new ProviderError(`Call timed out after ${this.runtime.callTimeoutSeconds}s`, true)
                  : new ProviderError(err instanceof Error ? err.message : String(err), true);
        const billed = err instanceof ProviderError ? err.billed : undefined;
        const billedCost = billed ? resolveCost(billed) : { costUsd: undefined, costSource: "unknown" as const };

        this.budget.recordCall(spec.category, billed?.usage ?? null, billedCost.costUsd);
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
            usage: billed?.usage ?? null,
            costUsd: billedCost.costUsd ?? null,
            costSource: billedCost.costSource,
            ...(billed ? { servedModel: billed.servedModel, finishReason: billed.finishReason ?? null, providerMeta: billed.providerMeta ?? null } : {}),
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
        // Backoff: cut short by stop, and never past the time limit (the next attempt then ends as TIMEOUT).
        const remaining = this.budget.remainingMs();
        await sleep(Math.min(this.runtime.providerRetryDelayMs * 2 ** providerAttempt, remaining ?? Infinity), this.runSignal);
      }
    }
  }

  /** Waits for a request slot; a stop or the experiment time limit ends the wait (queued time counts as experiment time). */
  private async acquireSlot(providerId: ProviderId): Promise<() => void> {
    const gate = this.providers.gate(providerId, this.pool);
    if (!gate) return () => {};
    try {
      const remaining = this.budget.remainingMs();
      const signal = remaining === null ? this.runSignal : AbortSignal.any([this.runSignal, AbortSignal.timeout(timerMs(remaining))]);
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
    return AbortSignal.any([this.runSignal, AbortSignal.timeout(timerMs(Math.min(this.runtime.callTimeoutSeconds * 1000, remaining ?? Infinity)))]);
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
