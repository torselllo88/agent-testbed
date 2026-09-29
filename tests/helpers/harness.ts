import type { ExperimentConfig } from "../../src/experiment/config.js";
import type { ExperimentEvent } from "../../src/experiment/events.js";
import type { RunExtensionFactory } from "../../src/experiment/extensions.js";
import { ExperimentRunner } from "../../src/experiment/runner.js";
import { presentationExtensions } from "../../src/presentation/index.js";
import type { CompletionRequest, LlmProvider } from "../../src/llm/provider.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider, type StubResponder } from "../../src/llm/stubProvider.js";
import { createInMemoryDb, type Db } from "../../src/persistence/db.js";
import { EventRepository } from "../../src/persistence/eventRepository.js";
import { ExperimentRepository } from "../../src/persistence/experimentRepository.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { spaceStationConfig } from "../../src/scenarios/spaceStation/config.js";

/** Space Station config with test-friendly runtime settings (no retry delays). */
export function testConfig(mutate?: (c: ExperimentConfig) => void, agentModel?: string): ExperimentConfig {
  const config = spaceStationConfig(agentModel);
  config.runtime.providerRetryDelayMs = 0;
  mutate?.(config);
  return config;
}

/** Points every agent at one stub script. */
export function useModel(config: ExperimentConfig, model: string): void {
  for (const agent of config.agents) agent.model = { provider: "stub", model, structuredOutput: "native" };
}

export interface Harness {
  db: Db;
  stub: StubProvider;
  providers: ProviderRegistry;
  runner(config: unknown): ExperimentRunner;
  events(experimentId: string): ExperimentEvent[];
  record(experimentId: string): ReturnType<ExperimentRepository["getOrThrow"]>;
}

export function createHarness(
  opts: {
    providers?: LlmProvider[];
    secrets?: string[];
    scripts?: Record<string, StubResponder>;
    maxConcurrentRequests?: number;
    /** Presentation extensions, as the app wires them; pass null for the bare experiment core. */
    extensions?: RunExtensionFactory | null;
  } = {}
): Harness {
  const db = createInMemoryDb();
  const stub = registerBuiltinStubs(new StubProvider());
  for (const [model, responder] of Object.entries(opts.scripts ?? {})) stub.register(model, responder);
  const providers = new ProviderRegistry(opts.providers ?? [], stub, { secrets: opts.secrets, maxConcurrentRequests: opts.maxConcurrentRequests });
  const evaluators = createEvaluatorRegistry();
  return {
    db,
    stub,
    providers,
    runner: (config) =>
      new ExperimentRunner({ db, providers, evaluators, extensions: opts.extensions === null ? undefined : (opts.extensions ?? presentationExtensions) }, config),
    events: (id) => new EventRepository(db).list(id),
    record: (id) => new ExperimentRepository(db).getOrThrow(id),
  };
}

export const ctxOf = (req: CompletionRequest) => req.context ?? {};

export function turnJson(t: { message?: string; target?: string | null; ready?: boolean; pass?: boolean }): string {
  const pass = t.pass ?? !t.message;
  return JSON.stringify({ message: t.message ?? "", pass, target: t.target ?? null, intent: null, readyToCommit: t.ready ?? false });
}

export const SAFE_PLAN = {
  shed_loads: ["research_labs", "external_communications"],
  coolant_loop: "B",
  coolant_power_kw: 30,
  scram_reactor: true,
  life_support_power_kw: 40,
  vent_reactor_section: false,
};

/**
 * A generic scripted agent: `discussion(agentId, agentTurn)` returns the turn
 * (defaults to PASS + ready), proposals return SAFE_PLAN, everyone approves.
 */
export function script(parts: {
  discussion?: (agentId: string, agentTurn: number, req: CompletionRequest) => string;
  proposal?: (req: CompletionRequest) => string;
  vote?: (agentId: string, req: CompletionRequest) => string;
}): StubResponder {
  return (req) => {
    const ctx = ctxOf(req);
    const agentId = String(ctx.agentId);
    if (ctx.purpose === "discussion") {
      return parts.discussion?.(agentId, Number(ctx.agentTurn), req) ?? turnJson({ pass: true, ready: true });
    }
    if (ctx.purpose === "proposal") return parts.proposal?.(req) ?? JSON.stringify({ rationale: "plan", proposal: SAFE_PLAN });
    if (ctx.purpose === "vote") return parts.vote?.(agentId, req) ?? JSON.stringify({ vote: "APPROVE", reason: "ok" });
    throw new Error(`unexpected purpose ${String(ctx.purpose)}`);
  };
}

export const ofType = (events: ExperimentEvent[], type: string) => events.filter((e) => e.type === type);
