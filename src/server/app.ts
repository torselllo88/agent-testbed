import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CONSENSUS_RULES } from "../consensus/index.js";
import { getTestbedVersion } from "../config/version.js";
import type { EvaluatorRegistry } from "../evaluation/registry.js";
import { ConfigValidationError, parseExperimentConfig } from "../experiment/config.js";
import { toJsonSchema } from "../experiment/jsonSchema.js";
import { OUTCOMES } from "../experiment/outcome.js";
import { checkRunnable, ConfigNotRunnableError, InvalidCommandError, type OperatorCommand } from "../experiment/runner.js";
import type { ExperimentService } from "../experiment/service.js";
import type { ProviderRegistry } from "../llm/registry.js";
import type { Db } from "../persistence/db.js";
import { EventRepository } from "../persistence/eventRepository.js";
import { ExperimentRepository, type ExperimentRecord } from "../persistence/experimentRepository.js";
import { ScenarioRepository, type ScenarioRecord } from "../persistence/scenarioRepository.js";
import { BUILTIN_SCENARIOS } from "../scenarios/index.js";
import { SCHEDULER_TYPES } from "../scheduling/index.js";
import { decodeRouteParam, HttpError, readJsonBody, requireJsonContentType, sendJson, serveStatic } from "./http.js";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "gui", "public");

export interface AppDeps {
  db: Db;
  providers: ProviderRegistry;
  evaluators: EvaluatorRegistry;
  service: ExperimentService;
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
const StartExperimentBody = z.object({ config: z.unknown(), scenarioId: z.string().optional() });
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

function scenarioSummary(s: ScenarioRecord) {
  return {
    id: s.id,
    name: s.name,
    version: s.version,
    configHash: s.configHash,
    agents: s.config.agents.length,
    scheduler: s.config.scheduler.type,
    consensus: s.config.consensus.rule,
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
function startExperiment(ctx: RouteContext, config: unknown, scenario?: ScenarioRecord) {
  const { runner } = ctx.deps.service.start({
    config,
    scenarioId: scenario?.id ?? null,
    scenarioVersion: scenario?.version ?? null,
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
        builtinScenarios: BUILTIN_SCENARIOS.map((s) => ({ id: s.id, name: s.name })),
        runningExperiments: deps.service.runningIds(),
      }),
  },

  // ------------------------------------------------------------ scenarios
  {
    method: "GET",
    pattern: /^\/api\/scenarios$/,
    handle: ({ res, scenarios }) => sendJson(res, 200, { scenarios: scenarios.list().map(scenarioSummary) }),
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
    handle: (ctx) => {
      const scenario = ctx.scenarios.getOrThrow(decodeRouteParam(ctx.params[0]!));
      startExperiment(ctx, scenario.config, scenario);
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
      startExperiment(ctx, input.config, scenario);
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
];

function errorStatusAndMessage(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
  if (err instanceof ConfigValidationError) {
    return { status: 400, body: { error: err.message, problems: err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) } };
  }
  if (err instanceof ConfigNotRunnableError) return { status: 400, body: { error: err.message, problems: err.problems } };
  if (err instanceof InvalidCommandError) return { status: 409, body: { error: err.message } };
  if (err instanceof Error && /^(Scenario|Experiment) not found:/.test(err.message)) return { status: 404, body: { error: err.message } };
  return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
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
