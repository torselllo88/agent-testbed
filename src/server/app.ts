import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BatchValidationError, type BatchService } from "../batch/service.js";
import { CONSENSUS_RULES } from "../consensus/index.js";
import { getTestbedVersion } from "../config/version.js";
import type { EvaluatorRegistry } from "../evaluation/registry.js";
import { ConfigValidationError, HUMAN_INTERACTION_PROFILES, parseExperimentConfig, RunOverridesSchema, taskDefinitionHash, type RunOverrides } from "../experiment/config.js";
import { COMMON_LANGUAGES } from "../experiment/languages.js";
import { AUTHORED_PROTOCOL_LANGUAGES } from "../experiment/protocolStrings.js";
import { toJsonSchema } from "../experiment/jsonSchema.js";
import { OUTCOMES } from "../experiment/outcome.js";
import { checkRunnable, ConfigNotRunnableError, InvalidCommandError, type OperatorCommand } from "../experiment/runner.js";
import type { ExperimentService } from "../experiment/service.js";
import { InteractionError, type HumanInteractionService } from "../interaction/service.js";
import type { ExternalRoomService } from "../rooms/service.js";
import type { OpenRouterModelCatalog } from "../llm/openRouterModels.js";
import type { ProviderRegistry } from "../llm/registry.js";
import type { Db } from "../persistence/db.js";
import { EventRepository } from "../persistence/eventRepository.js";
import { ExperimentRepository, type ExperimentRecord } from "../persistence/experimentRepository.js";
import { ReadOnlyScenarioError, ScenarioRepository, type ScenarioRecord } from "../persistence/scenarioRepository.js";
import { BUILTIN_SCENARIOS } from "../scenarios/index.js";
import { SCHEDULER_TYPES } from "../scheduling/index.js";
import { decodeRouteParam, HttpError, readJsonBody, requireJsonContentType, sendJson, serveStatic } from "./http.js";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "gui", "public");

export interface AppDeps {
  db: Db;
  providers: ProviderRegistry;
  evaluators: EvaluatorRegistry;
  service: ExperimentService;
  batches: BatchService;
  interaction: HumanInteractionService;
  /** External room bindings; optional so the operator app can run without them (tests). */
  rooms?: ExternalRoomService;
  /** Host names served besides loopback (GUI_ALLOWED_HOSTS) — e.g. the machine's name when bound to 0.0.0.0. */
  allowedHosts?: string[];
  /** OpenRouter model list for the editor; omitted = not offered. */
  openRouterModels?: OpenRouterModelCatalog;
}

interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: string[];
  url: URL;
  deps: AppDeps;
  scenarios: ScenarioRepository;
  experiments: ExperimentRepository;
  events: EventRepository;
}

interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  pattern: RegExp;
  handle(ctx: RouteContext): Promise<void> | void;
}

const ID = "([^/]+)";

const ConfigBody = z.object({ config: z.unknown() });
const CreateScenarioBody = z.union([z.object({ builtin: z.string() }), ConfigBody]);
const StartExperimentBody = z.object({ config: z.unknown(), scenarioId: z.string().optional(), overrides: RunOverridesSchema.optional() });
const RunScenarioBody = z.object({ overrides: RunOverridesSchema.optional() });
const BatchBody = z.object({ spec: z.unknown() });
/** A person's text message in the room — chat only; it can never carry an operator command. */
const HumanMessageBody = z.object({
  senderId: z.string().trim().min(1).max(100),
  displayName: z.string().trim().min(1).max(60),
  text: z.string().trim().min(1).max(2000),
  replyTo: z.string().max(200).nullable().optional(),
  mentions: z.array(z.string().max(100)).max(10).optional(),
});
const DebriefBody = z.object({ action: z.enum(["open", "close"]) });
const ControlBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("step") }),
  z.object({ type: z.literal("select_next"), agentId: z.string() }),
  z.object({ type: z.literal("force_decision") }),
  z.object({ type: z.literal("stop") }),
]);

async function body<T>(req: http.IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readJsonBody(req));
  if (!parsed.success) throw new HttpError(400, `Invalid request body: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

function scenarioSummary(s: ScenarioRecord, evaluators: EvaluatorRegistry) {
  const evaluator = evaluators.list().find((e) => e.id === s.config.evaluator?.id);
  const builtin = s.builtin ? BUILTIN_SCENARIOS.find((b) => b.id === s.builtin!.id) : undefined;
  return {
    id: s.id,
    name: s.name,
    version: s.version,
    builtin: s.builtin,
    readOnly: Boolean(s.builtin),
    summary: builtin?.summary ?? s.config.description ?? "",
    configHash: s.configHash,
    // With the evaluator version that would judge a run started now — what its runs record.
    taskDefinitionHash: taskDefinitionHash(s.config, evaluator?.version ?? null),
    agents: s.config.agents?.length ?? 0,
    agentNames: (s.config.agents ?? []).map((a) => a.name),
    scheduler: s.config.scheduler?.type,
    consensus: s.config.consensus?.rule,
    language: s.config.conversation?.language ?? "en",
    presentationLanguages: Object.keys(s.config.presentation?.strings ?? {}),
    narrated: Boolean(s.config.presentation?.narrator),
    paced: Boolean(s.config.presentation?.pacing && (s.config.presentation.pacing.minVisibleIntervalMs > 0 || s.config.presentation.pacing.perCharMs > 0)),
    updatedAt: s.updatedAt,
  };
}

function experimentSummary(e: ExperimentRecord, running: boolean) {
  const summary = (e.summary ?? {}) as Record<string, any>;
  return {
    id: e.id,
    name: e.config.name,
    scenarioId: e.scenarioId,
    scenarioVersion: e.scenarioVersion,
    batchId: e.batchId,
    conditionKey: e.conditionKey,
    phase: e.phase,
    status: e.status,
    outcome: e.outcome,
    intervened: e.intervened,
    running,
    createdAt: e.createdAt,
    finishedAt: e.finishedAt,
    turns: summary.turns?.total ?? null,
    tokens: summary.tokens?.total ?? null,
    costUsd: summary.costUsd?.total ?? null,
    durationMs: summary.durationMs?.active ?? null,
  };
}

/** Starting a run and validating a config report the same problems in the same shape. */
function startExperiment(ctx: RouteContext, config: unknown, scenario?: ScenarioRecord, overrides?: RunOverrides) {
  const { runner } = ctx.deps.service.start({
    config,
    scenarioId: scenario?.id ?? null,
    scenarioVersion: scenario?.version ?? null,
    overrides,
  });
  sendJson(ctx.res, 201, { id: runner.id, state: runner.state() });
}

const ROUTES: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/meta$/,
    handle: ({ res, deps }) =>
      sendJson(res, 200, {
        testbedVersion: getTestbedVersion(),
        providers: deps.providers.status(),
        stubModels: deps.providers.stub.models(),
        evaluators: deps.evaluators.list().map((e) => ({
          id: e.id,
          version: e.version,
          description: e.description,
          proposalSchema: toJsonSchema(e.proposalSchema, "proposal"),
        })),
        schedulers: SCHEDULER_TYPES,
        consensusRules: Object.keys(CONSENSUS_RULES),
        outcomes: OUTCOMES,
        builtinScenarios: BUILTIN_SCENARIOS.map((s) => ({ id: s.id, name: s.name, version: s.version, summary: s.summary })),
        languages: { suggested: COMMON_LANGUAGES, authoredProtocol: AUTHORED_PROTOCOL_LANGUAGES },
        humanInteraction: { profiles: HUMAN_INTERACTION_PROFILES },
        runningExperiments: deps.service.runningIds(),
      }),
  },

  {
    method: "GET",
    pattern: /^\/api\/providers\/openrouter\/models$/,
    handle: async ({ res, deps }) => {
      if (!deps.openRouterModels) throw new HttpError(404, "OpenRouter model list is not available");
      try {
        sendJson(res, 200, await deps.openRouterModels.get());
      } catch (err) {
        throw new HttpError(502, `Could not load the OpenRouter model list: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },

  // ------------------------------------------------------------ scenarios
  {
    method: "GET",
    pattern: /^\/api\/scenarios$/,
    handle: ({ res, scenarios, deps }) => sendJson(res, 200, { scenarios: scenarios.list().map((s) => scenarioSummary(s, deps.evaluators)) }),
  },
  {
    method: "POST",
    pattern: /^\/api\/scenarios$/,
    handle: async ({ req, res, scenarios }) => {
      const input = await body(req, CreateScenarioBody);
      let config: unknown;
      if ("builtin" in input) {
        const builtin = BUILTIN_SCENARIOS.find((s) => s.id === input.builtin);
        if (!builtin) throw new HttpError(404, `Unknown builtin scenario "${input.builtin}"`);
        config = builtin.config();
      } else {
        config = input.config;
      }
      sendJson(res, 201, { scenario: scenarios.create(config) });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/scenarios\/validate$/,
    handle: async ({ req, res, deps }) => {
      const { config } = await body(req, ConfigBody);
      try {
        const resolved = parseExperimentConfig(config);
        checkRunnable(deps, resolved);
        sendJson(res, 200, { ok: true, config: resolved, problems: [] });
      } catch (err) {
        if (err instanceof ConfigValidationError) {
          return sendJson(res, 200, { ok: false, problems: err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) });
        }
        if (err instanceof ConfigNotRunnableError) return sendJson(res, 200, { ok: false, problems: err.problems });
        throw err;
      }
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/scenarios/${ID}$`),
    handle: ({ res, params, scenarios }) => sendJson(res, 200, { scenario: scenarios.getOrThrow(decodeRouteParam(params[0]!)) }),
  },
  {
    method: "PUT",
    pattern: new RegExp(`^/api/scenarios/${ID}$`),
    handle: async ({ req, res, params, scenarios }) => {
      const { config } = await body(req, ConfigBody);
      sendJson(res, 200, { scenario: scenarios.update(decodeRouteParam(params[0]!), config) });
    },
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/api/scenarios/${ID}$`),
    handle: ({ res, params, scenarios }) => {
      scenarios.delete(decodeRouteParam(params[0]!));
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/scenarios/${ID}/duplicate$`),
    handle: ({ res, params, scenarios }) => sendJson(res, 201, { scenario: scenarios.duplicate(decodeRouteParam(params[0]!)) }),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/scenarios/${ID}/run$`),
    handle: async (ctx) => {
      const scenario = ctx.scenarios.getOrThrow(decodeRouteParam(ctx.params[0]!));
      const { overrides } = await body(ctx.req, RunScenarioBody);
      startExperiment(ctx, scenario.config, scenario, overrides);
    },
  },

  // ------------------------------------------------------------ experiments
  {
    method: "GET",
    pattern: /^\/api\/experiments$/,
    handle: ({ res, url, experiments, deps }) => {
      const list = experiments.list({
        scenarioId: url.searchParams.get("scenarioId") ?? undefined,
        batchId: url.searchParams.get("batchId") ?? undefined,
        taskDefinitionHash: url.searchParams.get("taskDefinitionHash") ?? undefined,
        excludeBatches: url.searchParams.get("batches") === "exclude",
        limit: Number(url.searchParams.get("limit")) || undefined,
      });
      sendJson(res, 200, { experiments: list.map((e) => experimentSummary(e, deps.service.isRunning(e.id))) });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/experiments$/,
    handle: async (ctx) => {
      const input = await body(ctx.req, StartExperimentBody);
      const scenario = input.scenarioId ? ctx.scenarios.getOrThrow(input.scenarioId) : undefined;
      startExperiment(ctx, input.config, scenario, input.overrides);
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/experiments/${ID}$`),
    handle: ({ res, params, experiments, deps }) => {
      const id = decodeRouteParam(params[0]!);
      sendJson(res, 200, { experiment: experiments.getOrThrow(id), running: deps.service.isRunning(id), live: deps.service.liveState(id) });
    },
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/api/experiments/${ID}$`),
    handle: ({ res, params, experiments, deps }) => {
      const id = decodeRouteParam(params[0]!);
      experiments.getOrThrow(id);
      if (deps.service.isRunning(id)) throw new HttpError(409, "Stop the experiment before deleting it");
      deps.interaction.forget(id);
      deps.rooms?.forgetExperiment(id);
      experiments.delete(id);
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/experiments/${ID}/events$`),
    handle: ({ res, params, url, experiments, events }) => {
      const id = decodeRouteParam(params[0]!);
      experiments.getOrThrow(id);
      const after = Number(url.searchParams.get("after")) || 0;
      sendJson(res, 200, { events: events.list(id, after) });
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/experiments/${ID}/control$`),
    handle: async ({ req, res, params, experiments, deps }) => {
      const id = decodeRouteParam(params[0]!);
      experiments.getOrThrow(id);
      const command = (await body(req, ControlBody)) as OperatorCommand;
      sendJson(res, 200, { live: deps.service.control(id, command) });
    },
  },
  // ------------------------------------------------------------ human interaction (outside the experiment)
  {
    method: "GET",
    pattern: new RegExp(`^/api/experiments/${ID}/interaction$`),
    handle: ({ res, params, url, deps }) => {
      const after = Number(url.searchParams.get("after")) || 0;
      sendJson(res, 200, deps.interaction.view(decodeRouteParam(params[0]!), after));
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/experiments/${ID}/room/messages$`),
    handle: async ({ req, res, params, deps }) => {
      const input = await body(req, HumanMessageBody);
      const result = await deps.interaction.receive(decodeRouteParam(params[0]!), {
        ...input,
        replyTo: input.replyTo ?? null,
        mentions: input.mentions ?? [],
      });
      sendJson(res, 201, result);
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/experiments/${ID}/debrief$`),
    handle: async ({ req, res, params, deps }) => {
      const id = decodeRouteParam(params[0]!);
      const { action } = await body(req, DebriefBody);
      const session = action === "open" ? await deps.interaction.openDebrief(id, "operator") : deps.interaction.closeDebrief(id);
      sendJson(res, 200, { session });
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/experiments/${ID}/rerun$`),
    handle: (ctx) => {
      const source = ctx.experiments.getOrThrow(decodeRouteParam(ctx.params[0]!));
      const { runner } = ctx.deps.service.start({
        config: source.config,
        scenarioId: source.scenarioId,
        scenarioVersion: source.scenarioVersion,
      });
      sendJson(ctx.res, 201, { id: runner.id, state: runner.state() });
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/experiments/${ID}/export$`),
    handle: ({ res, params, experiments, events }) => {
      const id = decodeRouteParam(params[0]!);
      const experiment = experiments.getOrThrow(id);
      res.setHeader("Content-Disposition", `attachment; filename="experiment-${id}.json"`);
      sendJson(res, 200, { exportedAt: new Date().toISOString(), experiment, events: events.list(id) });
    },
  },

  // ------------------------------------------------------------ batches
  {
    method: "POST",
    pattern: /^\/api\/batches\/preview$/,
    handle: async ({ req, res, deps }) => {
      const { spec } = await body(req, BatchBody);
      try {
        const resolved = deps.batches.resolve(spec);
        sendJson(res, 200, { ok: true, conditions: resolved.conditions, totalRuns: resolved.totalRuns, spec: resolved.spec, problems: [] });
      } catch (err) {
        if (err instanceof BatchValidationError) return sendJson(res, 200, { ok: false, problems: err.problems });
        throw err;
      }
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/batches$/,
    handle: async ({ req, res, deps }) => {
      const { spec } = await body(req, BatchBody);
      sendJson(res, 201, { batch: deps.batches.start(spec) });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/batches$/,
    handle: ({ res, deps }) =>
      sendJson(res, 200, {
        batches: deps.batches.list().map(({ batch, progress }) => ({
          id: batch.id,
          name: batch.name,
          status: batch.status,
          createdAt: batch.createdAt,
          finishedAt: batch.finishedAt,
          conditions: batch.resolved.conditions.length,
          repetitions: batch.resolved.spec.repetitions,
          progress,
        })),
      }),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/batches/${ID}$`),
    handle: ({ res, params, deps }) => sendJson(res, 200, deps.batches.view(decodeRouteParam(params[0]!))),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/batches/${ID}/cancel$`),
    handle: ({ res, params, deps }) => {
      const id = decodeRouteParam(params[0]!);
      const { batch } = deps.batches.view(id); // 404 for an unknown batch
      if (!deps.batches.isRunning(id)) {
        // Marked running in the database, but its owner is gone: record it as interrupted.
        if (deps.batches.closeOrphan(id)) return sendJson(res, 200, { ok: true, interrupted: true });
        if (batch.status === "running") throw new HttpError(409, "Batch is running in another process (e.g. a CLI batch) — stop it there");
        throw new HttpError(409, "Batch is not running");
      }
      deps.batches.cancel(id);
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/batches/${ID}/export$`),
    handle: ({ res, params, url, deps }) => {
      const id = decodeRouteParam(params[0]!);
      const view = deps.batches.view(id);
      if (url.searchParams.get("format") === "csv") {
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="batch-${id}.csv"` });
        res.end(deps.batches.csv(id));
        return;
      }
      res.setHeader("Content-Disposition", `attachment; filename="batch-${id}.json"`);
      sendJson(res, 200, {
        exportedAt: new Date().toISOString(),
        ...view,
        runs: deps.batches.runs(id).map((r) => ({
          id: r.id,
          conditionKey: r.conditionKey,
          repetition: r.repetition,
          outcome: r.outcome,
          status: r.status,
          intervened: r.intervened,
          configHash: r.configHash,
          summary: r.summary,
        })),
      });
    },
  },
];

function errorStatusAndMessage(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
  if (err instanceof InteractionError) return { status: err.status, body: { error: err.message } };
  if (err instanceof ConfigValidationError) {
    return { status: 400, body: { error: err.message, problems: err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) } };
  }
  if (err instanceof ConfigNotRunnableError) return { status: 400, body: { error: err.message, problems: err.problems } };
  if (err instanceof BatchValidationError) return { status: 400, body: { error: err.message, problems: err.problems } };
  if (err instanceof InvalidCommandError || err instanceof ReadOnlyScenarioError) return { status: 409, body: { error: err.message } };
  if (err instanceof Error && /^(Scenario|Experiment|Batch) not found:/.test(err.message)) return { status: 404, body: { error: err.message } };
  return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
}

/**
 * DNS-rebinding guard for this unauthenticated API: a page on another domain
 * that rebinds its name to 127.0.0.1 is same-origin to the browser, but its
 * requests still carry that domain in Host. Only loopback names (any port)
 * and explicitly configured names are served.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function hostAllowed(hostHeader: string | undefined, extraHosts: readonly string[] = []): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(host) || extraHosts.some((h) => h.toLowerCase() === host);
}

export function createApp(deps: AppDeps): http.Server {
  const repos = {
    scenarios: new ScenarioRepository(deps.db),
    experiments: new ExperimentRepository(deps.db),
    events: new EventRepository(deps.db),
  };

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    void (async () => {
      try {
        if (!hostAllowed(req.headers.host, deps.allowedHosts)) {
          return sendJson(res, 421, { error: `Host "${req.headers.host ?? ""}" is not served. Add it to GUI_ALLOWED_HOSTS if you reach the testbed under that name.` });
        }
        if (req.method === "POST" || req.method === "PUT") requireJsonContentType(req);

        for (const route of ROUTES) {
          if (route.method !== req.method) continue;
          const match = route.pattern.exec(url.pathname);
          if (match) return await route.handle({ req, res, params: match.slice(1), url, deps, ...repos });
        }

        if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });
        if (req.method === "GET") return serveStatic(res, PUBLIC_DIR, url.pathname);
        sendJson(res, 405, { error: "Method not allowed" });
      } catch (err) {
        const { status, body: errorBody } = errorStatusAndMessage(err);
        if (status >= 500) console.error(err);
        if (!res.headersSent) sendJson(res, status, errorBody);
      }
    })();
  });
}
