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
  /** Identity: the display name other participants and viewers see. */
  name: z.string().min(1),
  /** Operational role — part of the task definition. */
  role: z.string().min(1),
  model: ModelRefSchema,
  /** What this agent is responsible for achieving — part of the task definition. */
  objective: z.string().default(""),
  /**
   * Behavioral layer: personality, tendencies, interpersonal priors. Shapes
   * how the agent communicates, never what it knows — task facts belong in
   * privateContext / task. Not part of the task definition hash, but it does
   * change behavior, so runs differing only in persona are different conditions.
   */
  persona: z.string().default(""),
  /** Free-form extra instructions (behavioral layer, like persona). */
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

/** A language code as models understand it, e.g. "en", "ru", "sr-Latn", "pt-BR". */
const LanguageCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "expected a language code such as en, ru, sr-Latn");

/**
 * The language of everything participants and viewers read: room messages,
 * proposal rationale, vote reasons, moderator notices, narration. Distinct
 * from the UI locale and from the protocol (JSON field names, ids and enum
 * values are never translated). A run may override the scenario default
 * without editing the scenario (see applyRunOverrides).
 */
export const ConversationConfigSchema = z.object({
  language: LanguageCodeSchema.default("en"),
});
export type ConversationConfig = z.infer<typeof ConversationConfigSchema>;

/**
 * Viewer-facing strings for one language. Templates may reference
 * {{outcome}}, {{reason}}, {{derived.<name>}}, {{params.<name>}},
 * {{checks.<name>.detail}} — deterministic values from the runtime and the
 * evaluator, so endings stay grounded in what actually happened.
 */
export const PresentationStringsSchema = z.object({
  title: z.string().optional(),
  narratorName: z.string().optional(),
  opening: z.string().optional(),
  /** Ending per terminal outcome (SUCCESS, CONSENSUS_FAILURE, TIMEOUT, ...), plus optional "default". */
  outcomes: z.record(z.string()).default({}),
  /** MISSION_FAILURE ending per primary violated evaluator check. */
  missionFailure: z.record(z.string()).default({}),
  /**
   * Display labels per agent id for viewers (name, role). Display only: agents,
   * their prompts and the protocol keep the config's names and roles.
   */
  agents: z.record(z.object({ name: z.string().optional(), role: z.string().optional() })).default({}),
  /**
   * Human-readable rendering of a submitted proposal for viewers. Placeholders:
   * {{proposal.<field>}}, {{rationale}}, {{proposer}}, {{attempt}}; `values`
   * maps raw values ("research_labs", "true") or field-qualified values
   * ("scram_reactor.true") to display text. The protocol notice agents read
   * is unchanged.
   */
  proposal: z.object({ template: z.string().min(1), values: z.record(z.string()).default({}) }).optional(),
  /**
   * Room notices of the human-interaction layer (spectators, debrief) —
   * overrides of its built-in defaults. Placeholders: {{name}} (the person
   * addressed), {{position}}, {{limit}}, {{agent}}.
   */
  interaction: z
    .object({
      spectatorNotice: z.string(),
      observeNotice: z.string(),
      debriefOpened: z.string(),
      debriefClosed: z.string(),
      debriefUnavailable: z.string(),
      questionQueued: z.string(),
      userLimit: z.string(),
      queueFull: z.string(),
      budgetReached: z.string(),
      answerFailed: z.string(),
    })
    .partial()
    .optional(),
});
export type PresentationStrings = z.infer<typeof PresentationStringsSchema>;

/**
 * Viewer pacing: before a visible message is published, wait until the
 * viewer has had time to read the previous one —
 *   gap = min(maxGapMs, minVisibleIntervalMs + previousMessageLength × perCharMs)
 * measured from when the previous message appeared, so a slow provider
 * reply needs little or no extra delay. The wait is recorded separately
 * (presentation_delay) and excluded from provider latency and from the
 * experiment's active time.
 */
export const PacingConfigSchema = z.object({
  minVisibleIntervalMs: z.number().int().min(0).default(0),
  perCharMs: z.number().min(0).default(0),
  maxGapMs: z.number().int().min(0).default(10000),
});
export type PacingConfig = z.infer<typeof PacingConfigSchema>;

/**
 * How a run is presented to a human observer. Presentation never changes
 * protocol semantics: agents never see narration, and endings are rendered
 * from evaluator/runtime state, not generated.
 */
export const PresentationConfigSchema = z.object({
  /** Visible narrator posting the opening and the ending; null = no narration. */
  narrator: z.object({ displayName: z.string().min(1) }).nullable().default(null),
  /** Used for any string missing in the conversation language. */
  fallbackLanguage: LanguageCodeSchema.default("en"),
  strings: z.record(PresentationStringsSchema).default({}),
  /** Evaluator checks in narrative priority: the first violated one picks the MISSION_FAILURE ending. */
  missionFailurePriority: z.array(z.string()).default([]),
  pacing: PacingConfigSchema.default({}),
});
export type PresentationConfig = z.infer<typeof PresentationConfigSchema>;

/**
 * What people in the room may do around a run. Humans never take part in an
 * active experiment in the supported profiles:
 *   OBSERVE     humans are spectators, before and after the outcome;
 *   DEBRIEF     spectators during the mission; once the outcome is final, a
 *               separate debrief session lets them question the characters.
 * Future profiles — recognized, but refused by checkRunnable until they exist,
 * because they would change experiment semantics (and must then do so through
 * an explicit core interface, never by special-casing the runner):
 *   ADVISORY    authorized human messages become shared context in safe phases;
 *   TAKE_ROLE   a human supplies one participant's turns.
 *
 * Handled entirely outside the experiment core (src/interaction). Absent =
 * OBSERVE; optional so configs without it keep their configHash.
 */
export const HUMAN_INTERACTION_PROFILES = {
  OBSERVE: { supported: true },
  DEBRIEF: { supported: true },
  ADVISORY: { supported: false },
  TAKE_ROLE: { supported: false },
} as const;
export type HumanInteractionProfile = keyof typeof HUMAN_INTERACTION_PROFILES;

export function supportedProfiles(): HumanInteractionProfile[] {
  return (Object.keys(HUMAN_INTERACTION_PROFILES) as HumanInteractionProfile[]).filter((p) => HUMAN_INTERACTION_PROFILES[p].supported);
}

export const DebriefConfigSchema = z.object({
  /** Who answers a question addressed to nobody in particular when routing is inconclusive. Default: the proposer. */
  defaultAgentId: z.string().optional(),
  /** Per-answer output cap; answers use each character's own mission model. */
  maxOutputTokens: z.number().int().positive().default(250),
  maxPendingPerUser: z.number().int().positive().default(3),
  maxPendingTotal: z.number().int().positive().default(20),
  /** Debrief spend cap per session (separate from every experiment limit); null = none. */
  costCapUsd: z.number().positive().nullable().default(null),
  idleTimeoutMinutes: z.number().positive().default(15),
  /**
   * false: characters learn the outcome as announced (status + the ending
   * narration). true: they also get the evaluator's check results — which can
   * reveal facts only another character knew.
   */
  revealEvaluation: z.boolean().default(false),
  /** Room-wide minimum gap between "the crew cannot answer now" notices. */
  spectatorNoticeCooldownSeconds: z.number().min(0).default(30),
});
export type DebriefConfig = z.infer<typeof DebriefConfigSchema>;

export const HumanInteractionConfigSchema = z.object({
  profile: z.enum(["OBSERVE", "DEBRIEF", "ADVISORY", "TAKE_ROLE"]).default("OBSERVE"),
  debrief: DebriefConfigSchema.default({}),
});
export type HumanInteractionConfig = z.infer<typeof HumanInteractionConfigSchema>;

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
    conversation: ConversationConfigSchema.default({}),
    presentation: PresentationConfigSchema.default({}),
    runtime: RuntimeConfigSchema.default({}),
    evaluator: z.object({
      id: z.string().min(1),
      params: z.record(z.unknown()).default({}),
    }),
    transport: TransportConfigSchema.default({ type: "local" }),
    humanInteraction: HumanInteractionConfigSchema.optional(),
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
    const debriefDefault = cfg.humanInteraction?.debrief.defaultAgentId;
    if (debriefDefault !== undefined && !ids.has(debriefDefault)) {
      ctx.addIssue({ code: "custom", path: ["humanInteraction", "debrief", "defaultAgentId"], message: `unknown agent "${debriefDefault}"` });
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

/**
 * The part of a config that defines the underlying coordination task: shared
 * task facts, each agent's operational role, objective and private
 * information, the decision protocol, and the evaluator with its
 * environment parameters. Excludes identity (display names), persona and
 * free-form system prompts, models, language, presentation, scheduling,
 * limits and runtime settings.
 *
 * Two runs with equal taskDefinitionHash attempt the same problem. They are
 * NOT necessarily the same experimental condition — persona, models and
 * language change behavior; configHash identifies the exact configuration.
 */
export function taskDefinition(config: ExperimentConfig): unknown {
  return {
    task: config.task,
    agents: [...config.agents]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) => ({ id: a.id, role: a.role, objective: a.objective, privateContext: a.privateContext })),
    decision: config.decision,
    consensus: config.consensus,
    evaluator: config.evaluator,
  };
}

export function taskDefinitionHash(config: ExperimentConfig): string {
  return sha256(canonicalJson(taskDefinition(config)));
}

/** Per-run settings that override the saved scenario without editing or versioning it. */
export const RunOverridesSchema = z
  .object({
    /** Conversation language for this run only. */
    language: LanguageCodeSchema.optional(),
    /**
     * "off" disables viewer pacing for this run (headless CLI and batch runs
     * default to it: nobody is watching, and pacing would only add wall time).
     */
    pacing: z.enum(["scenario", "off"]).optional(),
  })
  .strict();
export type RunOverrides = z.infer<typeof RunOverridesSchema>;

/** Applies overrides to a copy of the config; the result is what the run snapshots and executes. */
export function applyRunOverrides(config: ExperimentConfig, overrides: RunOverrides | undefined): ExperimentConfig {
  if (!overrides || Object.keys(overrides).length === 0) return config;
  const next = structuredClone(config);
  if (overrides.language) next.conversation = { ...next.conversation, language: overrides.language };
  if (overrides.pacing === "off") next.presentation = { ...next.presentation, pacing: { ...next.presentation.pacing, minVisibleIntervalMs: 0, perCharMs: 0 } };
  return next;
}
