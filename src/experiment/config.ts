import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The serializable experiment configuration — everything a run needs,
 * editable from the UI's raw-JSON view, and snapshotted verbatim on every
 * run. Credentials never appear here: a model reference names a provider id,
 * and the provider's key lives only in .env (see llm/registry.ts).
 */

const idPattern = /^[a-z0-9][a-z0-9_-]*$/;

const slugList = z.array(z.string().trim().min(1)).min(1);

/**
 * OpenRouter upstream-provider routing (OpenRouter-specific; rejected for any
 * other provider). A typed subset of OpenRouter's request `provider` object:
 * the same nominal model can behave materially differently depending on the
 * backend that serves it, so controlled runs may want to constrain it. Omitted
 * = OpenRouter chooses automatically. Values are provider slugs as OpenRouter
 * expects them (e.g. "deepinfra", "together").
 */
export const OpenRouterRoutingSchema = z
  .object({
    /** Try these providers first, in this order. */
    order: slugList.optional(),
    /** Only ever use these providers. */
    only: slugList.optional(),
    /** Never use these providers. */
    ignore: slugList.optional(),
    /** Whether OpenRouter may fall back to other providers when the preferred ones are unavailable (OpenRouter default: true). */
    allowFallbacks: z.boolean().optional(),
    /**
     * Only route to providers supporting every request parameter. Effective
     * default: true when structuredOutput is "native" (routing to a backend
     * without response_format support contradicts that mode), otherwise
     * OpenRouter's own default.
     */
    requireParameters: z.boolean().optional(),
    sort: z.enum(["price", "throughput", "latency"]).optional(),
    /** e.g. ["fp16", "bf16"] */
    quantizations: slugList.optional(),
    dataCollection: z.enum(["allow", "deny"]).optional(),
  })
  .strict();
export type OpenRouterRouting = z.infer<typeof OpenRouterRoutingSchema>;

export const ModelRefSchema = z.object({
  provider: z.enum(["openrouter", "azure", "stub"]),
  /** OpenRouter model id, Azure deployment name, or stub script name. */
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  /** Best-effort only — recorded, never relied upon for reproducibility. */
  seed: z.number().int().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /**
   * "native": ask the provider to enforce the response JSON schema.
   * "prompt": describe the schema in the prompt only — for models whose
   * provider route rejects response_format. Either way the response is parsed
   * and validated by the runtime.
   */
  structuredOutput: z.enum(["native", "prompt"]).default("native"),
  /** OpenRouter only: upstream-provider routing. Omit for automatic routing. */
  routing: OpenRouterRoutingSchema.optional(),
}).superRefine((ref, ctx) => {
  if (ref.routing && ref.provider !== "openrouter") {
    ctx.addIssue({ code: "custom", path: ["routing"], message: `routing is OpenRouter-specific and has no meaning for provider "${ref.provider}"` });
  }
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

/**
 * The routing actually sent to OpenRouter: the configured routing plus the
 * one effective default — requireParameters: true for native structured
 * output, unless explicitly overridden. Null when there is nothing to send.
 */
export function effectiveOpenRouterRouting(ref: ModelRef): OpenRouterRouting | null {
  if (ref.provider !== "openrouter") return null;
  const routing: OpenRouterRouting = { ...(ref.routing ?? {}) };
  if (routing.requireParameters === undefined && ref.structuredOutput === "native") routing.requireParameters = true;
  return Object.keys(routing).length ? routing : null;
}

export const AgentConfigSchema = z.object({
  id: z.string().regex(idPattern, "agent id must be a lowercase slug"),
  name: z.string().min(1),
  role: z.string().min(1),
  model: ModelRefSchema,
  systemPrompt: z.string().default(""),
  /** Visible only to this agent — never published to the room by the runtime. */
  privateContext: z.string().default(""),
  /** Reserved for tool integrations; no tools are implemented yet. */
  tools: z.array(z.string()).default([]),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const SchedulerConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("round_robin"),
    startAgentId: z.string().optional(),
  }),
  z.object({
    type: z.literal("hybrid"),
    startAgentId: z.string().optional(),
    /** LLM used to pick the next speaker when no valid explicit target was given; null skips straight to the fallback. */
    classifier: ModelRefSchema.nullable().default(null),
    /** How many of the most recent room messages the classifier sees. */
    classifierWindow: z.number().int().positive().default(12),
  }),
]);
export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;

export const ConsensusConfigSchema = z.object({
  rule: z.enum(["unanimity", "majority"]),
});
export type ConsensusConfig = z.infer<typeof ConsensusConfigSchema>;

export const DecisionConfigSchema = z.object({
  /** The agent asked to produce the formal proposal once discussion ends. */
  proposerId: z.string(),
  maxProposalAttempts: z.number().int().positive().default(2),
  /** Extra proposer activations, with the schema errors fed back, after a proposal fails schema validation. */
  maxProposalFormatRetries: z.number().int().min(0).default(1),
});
export type DecisionConfig = z.infer<typeof DecisionConfigSchema>;

export const LimitsConfigSchema = z.object({
  /** Soft: reaching it moves DISCUSSION -> decision. Not a failure by itself. */
  discussionTurnLimit: z.number().int().positive().default(24),
  /** Soft, per return to DISCUSSION after a failed proposal attempt. */
  rediscussionTurnLimit: z.number().int().positive().default(8),
  /** Hard safety fuse over every agent activation in every phase. */
  globalTurnLimit: z.number().int().positive().default(80),
  /** Hard experimental budget for agent tokens (plus orchestration tokens if countOrchestrationTokens). null = unlimited. */
  agentTokenLimit: z.number().int().positive().nullable().default(null),
  countOrchestrationTokens: z.boolean().default(false),
  /** Hard absolute safety caps over agents + orchestration. null = unlimited. */
  totalTokenCap: z.number().int().positive().nullable().default(null),
  totalCostCapUsd: z.number().positive().nullable().default(null),
  /** Hard wall-clock limit, excluding time spent paused by the operator. null = unlimited. */
  timeLimitSeconds: z.number().positive().nullable().default(null),
});
export type LimitsConfig = z.infer<typeof LimitsConfigSchema>;

/**
 * What the runtime tells agents about the protocol's own state. Part of the
 * coordination protocol, not presentation: an agent that sees "21 of 24
 * turns used" hurries and agrees sooner. Off by default for baseline
 * research runs; the runtime and UI always know these numbers regardless.
 */
export const AgentVisibilityConfigSchema = z.object({
  /** Show agents the discussion turns used / limit and the proposal attempt number. */
  discussionBudget: z.boolean().default(false),
});
export type AgentVisibilityConfig = z.infer<typeof AgentVisibilityConfigSchema>;

export const RuntimeConfigSchema = z.object({
  /** Re-asks for the same activation when the response is not parseable JSON of the expected shape. */
  maxParseRetries: z.number().int().min(0).default(1),
  /** Retries of transient provider failures (rate limit, 5xx, network). */
  maxProviderRetries: z.number().int().min(0).default(2),
  providerRetryDelayMs: z.number().int().min(0).default(2000),
  callTimeoutSeconds: z.number().positive().default(120),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export const TransportConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local") }),
  z.object({ type: z.literal("chums"), room: z.string().optional() }),
]);
export type TransportConfig = z.infer<typeof TransportConfigSchema>;

export const ExperimentConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1),
    description: z.string().default(""),
    task: z.object({
      description: z.string().min(1),
      /** Given to every agent. */
      sharedContext: z.string().default(""),
    }),
    agents: z.array(AgentConfigSchema).min(2),
    scheduler: SchedulerConfigSchema,
    consensus: ConsensusConfigSchema,
    decision: DecisionConfigSchema,
    limits: LimitsConfigSchema.default({}),
    agentVisibility: AgentVisibilityConfigSchema.default({}),
    runtime: RuntimeConfigSchema.default({}),
    evaluator: z.object({
      id: z.string().min(1),
      params: z.record(z.unknown()).default({}),
    }),
    transport: TransportConfigSchema.default({ type: "local" }),
  })
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>();
    for (const [i, agent] of cfg.agents.entries()) {
      if (ids.has(agent.id)) ctx.addIssue({ code: "custom", path: ["agents", i, "id"], message: `duplicate agent id "${agent.id}"` });
      ids.add(agent.id);
    }
    if (!ids.has(cfg.decision.proposerId)) {
      ctx.addIssue({ code: "custom", path: ["decision", "proposerId"], message: `unknown agent "${cfg.decision.proposerId}"` });
    }
    const start = cfg.scheduler.startAgentId;
    if (start !== undefined && !ids.has(start)) {
      ctx.addIssue({ code: "custom", path: ["scheduler", "startAgentId"], message: `unknown agent "${start}"` });
    }
  });
export type ExperimentConfig = z.infer<typeof ExperimentConfigSchema>;

export class ConfigValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(`Invalid experiment config: ${issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    this.name = "ConfigValidationError";
  }
}

/** Parses and fills defaults; throws ConfigValidationError listing every problem. */
export function parseExperimentConfig(raw: unknown): ExperimentConfig {
  const result = ExperimentConfigSchema.safeParse(raw);
  if (!result.success) throw new ConfigValidationError(result.error.issues);
  return result.data;
}

/** JSON with object keys sorted recursively — the stable form hashes are computed over. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Hash of the fully-resolved (defaults filled) config, so two configs that differ only in omitted defaults hash equal. */
export function configHash(config: ExperimentConfig): string {
  return sha256(canonicalJson(config));
}
