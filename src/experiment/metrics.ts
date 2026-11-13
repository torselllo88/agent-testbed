import type { TokenUsage } from "../llm/provider.js";
import { EventType, type ExperimentEvent } from "./events.js";
import type { Termination } from "./outcome.js";
import { communicationMetrics, type CommunicationMetrics } from "./communicationMetrics.js";

interface TokenCount {
  prompt: number;
  completion: number;
  total: number;
}

export interface ExperimentMetrics {
  termination: Termination | null;
  intervened: boolean;
  interventions: Array<{ seq: number; command: unknown; flowAltering: boolean }>;
  /** wall = active + paused + presentation (viewer pacing); only active time drives the time limit. */
  durationMs: { active: number | null; wall: number | null; paused: number | null; presentation: number | null };
  turns: { total: number; byKind: Record<string, number>; byAgent: Record<string, number> };
  messages: { public: number; system: number; narrator: number; byAgent: Record<string, number> };
  passes: { total: number; byAgent: Record<string, number> };
  tokens: {
    agent: number;
    orchestration: number;
    total: number;
    byAgent: Record<string, TokenCount>;
  };
  costUsd: { total: number; agent: number; orchestration: number; callsWithUnknownCost: number };
  llmCalls: {
    total: number;
    failed: number;
    parseFailures: number;
    byPurpose: Record<string, number>;
    /** Calls whose prompt probably did not fit the endpoint's context window (Ollama; a heuristic — see ollamaProvider.ts). */
    contextOverflowSuspected: number;
    /** Calls on which the model reported thinking (e.g. think was meant to be off). */
    withThinking: number;
    /**
     * Ollama: calls served while part of the model was in CPU memory (GET
     * /api/ps right after the call) — slower, and not numerically the same
     * computation as fully on the GPU, so not comparable run to run.
     */
    partialGpuOffload: number;
    /** Ollama: calls whose placement could not be determined (see providerMeta.servingUnknown). */
    servingUnknown: number;
    /** Ollama: the smallest share of the model in GPU memory over the run's calls (1 = fully); null: no call recorded one. */
    minGpuFraction: number | null;
  };
  routing: { decisions: number; bySource: Record<string, number>; invalidExplicitTargets: number; classifierFailures: number };
  readiness: { invalidations: number };
  proposals: {
    attempts: number;
    formatRejections: number;
    declined: number;
    frozen: number;
    final: { id: string; proposerId: string; body: unknown; rationale: string; hash: string } | null;
    /** Every frozen proposal as the evaluator judged it once the outcome was decided, committed or not. */
    evaluated: ProposalEvaluation[];
    /** The first of them — first-proposal correctness, next to the run's outcome. Null: no proposal was frozen (or the run predates this metric). */
    first: ProposalEvaluation | null;
  };
  votes: {
    rounds: Array<{ proposalId: string; reached: boolean; approvals: number; required: number; votes: unknown }>;
    final: Array<{ agentId: string; vote: string; reason: string }> | null;
  };
  consensusReached: boolean;
  evaluation: Record<string, unknown> | null;
  protocolIncidents: Record<string, number>;
  errors: number;
  /** Add-on (extension) failures — integration / presentation problems, not experiment errors. */
  extensionErrors: number;
  /** The version of the evaluator that judged the run (runtime metadata, not part of configHash; part of taskDefinitionHash). */
  evaluatorVersion: string | null;
  /** The shared protocol assets agents read (runtime metadata, like evaluatorVersion). */
  protocolFingerprint: string | null;
  /** Who addressed whom, participation, responsiveness, time to decision (see communicationMetrics.ts). */
  communication: CommunicationMetrics;
}

export interface ProposalEvaluation {
  proposalId: string;
  attempt: number;
  committed: boolean;
  outcome: string;
  violated: string[];
  classification: string | null;
}

const inc = (map: Record<string, number>, key: string, by = 1) => {
  map[key] = (map[key] ?? 0) + by;
};

/**
 * Derives every reported number from the event log alone (the log is the
 * source of truth; the stored summary is just a cache of this). Pure — can be
 * re-run over any stored trace, including traces from older runs.
 */
export function computeMetrics(events: ExperimentEvent[], opts: { intervened?: boolean } = {}): ExperimentMetrics {
  const m: ExperimentMetrics = {
    termination: null,
    intervened: opts.intervened ?? false,
    interventions: [],
    durationMs: { active: null, wall: null, paused: null, presentation: null },
    turns: { total: 0, byKind: {}, byAgent: {} },
    messages: { public: 0, system: 0, narrator: 0, byAgent: {} },
    passes: { total: 0, byAgent: {} },
    tokens: { agent: 0, orchestration: 0, total: 0, byAgent: {} },
    costUsd: { total: 0, agent: 0, orchestration: 0, callsWithUnknownCost: 0 },
    llmCalls: { total: 0, failed: 0, parseFailures: 0, byPurpose: {}, contextOverflowSuspected: 0, withThinking: 0, partialGpuOffload: 0, servingUnknown: 0, minGpuFraction: null },
    routing: { decisions: 0, bySource: {}, invalidExplicitTargets: 0, classifierFailures: 0 },
    readiness: { invalidations: 0 },
    proposals: { attempts: 0, formatRejections: 0, declined: 0, frozen: 0, final: null, evaluated: [], first: null },
    votes: { rounds: [], final: null },
    consensusReached: false,
    evaluation: null,
    protocolIncidents: {},
    errors: 0,
    extensionErrors: 0,
    evaluatorVersion: null,
    protocolFingerprint: null,
    communication: communicationMetrics(events),
  };

  let startedTs: string | null = null;
  let finishedTs: string | null = null;
  const frozenById = new Map<string, Record<string, unknown>>();

  for (const e of events) {
    const p = e.payload;
    switch (e.type) {
      case EventType.EXPERIMENT_STARTED:
        startedTs = e.ts;
        m.evaluatorVersion = (p.evaluator as { version?: string } | undefined)?.version ?? null;
        m.protocolFingerprint = typeof p.protocolFingerprint === "string" ? p.protocolFingerprint : null;
        break;
      case EventType.EXPERIMENT_FINISHED:
        finishedTs = e.ts;
        m.termination = p.termination as Termination;
        m.durationMs.active = typeof p.activeElapsedMs === "number" ? p.activeElapsedMs : null;
        m.durationMs.paused = typeof p.pausedMs === "number" ? p.pausedMs : null;
        m.durationMs.presentation = typeof p.presentationDelayMs === "number" ? p.presentationDelayMs : null;
        break;
      case EventType.TURN_STARTED:
        m.turns.total += 1;
        inc(m.turns.byKind, String(p.kind));
        if (e.agentId) inc(m.turns.byAgent, e.agentId);
        break;
      case EventType.AGENT_META:
        if (p.pass === true && e.agentId) {
          m.passes.total += 1;
          inc(m.passes.byAgent, e.agentId);
        }
        break;
      case EventType.MESSAGE_POSTED: {
        const sender = p.sender as { kind: string; agentId?: string };
        if (sender.kind === "agent" && sender.agentId) {
          m.messages.public += 1;
          inc(m.messages.byAgent, sender.agentId);
        } else if (sender.kind === "narrator") {
          m.messages.narrator += 1;
        } else {
          m.messages.system += 1;
        }
        break;
      }
      case EventType.LLM_CALL: {
        m.llmCalls.total += 1;
        inc(m.llmCalls.byPurpose, String(p.purpose));
        if (p.error) m.llmCalls.failed += 1;
        if (p.parseOk === false) m.llmCalls.parseFailures += 1;
        const meta = (p.providerMeta ?? {}) as Record<string, unknown>;
        if (meta.contextOverflowSuspected === true) m.llmCalls.contextOverflowSuspected += 1;
        if (typeof meta.thinking === "string" && meta.thinking.trim()) m.llmCalls.withThinking += 1;
        if (meta.partialGpuOffload === true) m.llmCalls.partialGpuOffload += 1;
        if (typeof meta.servingUnknown === "string") m.llmCalls.servingUnknown += 1;
        const gpuFraction = (meta.serving as { gpuFraction?: unknown } | null | undefined)?.gpuFraction;
        if (typeof gpuFraction === "number" && typeof meta.servingUnknown !== "string") {
          m.llmCalls.minGpuFraction = Math.min(m.llmCalls.minGpuFraction ?? 1, gpuFraction);
        }
        const usage = p.usage as TokenUsage | null;
        const tokens = usage ? usage.promptTokens + usage.completionTokens : 0;
        const cost = typeof p.costUsd === "number" ? p.costUsd : null;
        if (cost === null) m.costUsd.callsWithUnknownCost += 1;
        if (p.category === "orchestration") {
          m.tokens.orchestration += tokens;
          m.costUsd.orchestration += cost ?? 0;
        } else {
          m.tokens.agent += tokens;
          m.costUsd.agent += cost ?? 0;
          if (e.agentId && usage) {
            const entry = (m.tokens.byAgent[e.agentId] ??= { prompt: 0, completion: 0, total: 0 });
            entry.prompt += usage.promptTokens;
            entry.completion += usage.completionTokens;
            entry.total += tokens;
          }
        }
        break;
      }
      case EventType.ROUTING_DECISION: {
        m.routing.decisions += 1;
        inc(m.routing.bySource, String(p.source));
        const details = (p.details ?? {}) as Record<string, unknown>;
        if (details.invalidExplicitTarget) m.routing.invalidExplicitTargets += 1;
        if (details.classifierFailure) m.routing.classifierFailures += 1;
        break;
      }
      case EventType.READINESS_INVALIDATED:
        m.readiness.invalidations += 1;
        break;
      case EventType.PROPOSAL_REQUESTED:
        m.proposals.attempts += 1;
        break;
      case EventType.PROPOSAL_REJECTED_FORMAT:
        m.proposals.formatRejections += 1;
        break;
      case EventType.PROPOSAL_DECLINED:
        m.proposals.declined += 1;
        break;
      case EventType.PROPOSAL_FROZEN:
        m.proposals.frozen += 1;
        frozenById.set(String(p.id), p);
        break;
      case EventType.CONSENSUS_RESULT: {
        const votes = p.votes as Array<{ agentId: string; vote: string; reason: string }>;
        m.votes.rounds.push({
          proposalId: String(p.proposalId),
          reached: p.reached === true,
          approvals: Number(p.approvals),
          required: Number(p.required),
          votes,
        });
        m.votes.final = votes;
        m.consensusReached = p.reached === true;
        const frozen = frozenById.get(String(p.proposalId));
        if (frozen) {
          m.proposals.final = {
            id: String(frozen.id),
            proposerId: String(frozen.proposerId),
            body: frozen.body,
            rationale: String(frozen.rationale ?? ""),
            hash: String(frozen.hash),
          };
        }
        break;
      }
      case EventType.EVALUATION_RESULT:
        m.evaluation = p;
        break;
      case EventType.PROPOSAL_EVALUATED:
        m.proposals.evaluated.push({
          proposalId: String(p.proposalId),
          attempt: Number(p.attempt),
          committed: p.committed === true,
          outcome: String(p.outcome),
          violated: Array.isArray(p.violated) ? p.violated.map(String) : [],
          classification: typeof p.classification === "string" ? p.classification : null,
        });
        m.proposals.first ??= m.proposals.evaluated[0]!;
        break;
      case EventType.PROTOCOL_INCIDENT:
        inc(m.protocolIncidents, String(p.kind));
        break;
      case EventType.OPERATOR_INTERVENTION:
        m.interventions.push({ seq: e.seq, command: p.command, flowAltering: p.flowAltering === true });
        if (p.flowAltering === true) m.intervened = true;
        break;
      case EventType.ERROR:
        m.errors += 1;
        break;
      case EventType.EXTENSION_ERROR:
        m.extensionErrors += 1;
        break;
      default:
        break;
    }
  }

  m.tokens.total = m.tokens.agent + m.tokens.orchestration;
  m.costUsd.total = m.costUsd.agent + m.costUsd.orchestration;
  if (startedTs && finishedTs) m.durationMs.wall = new Date(finishedTs).getTime() - new Date(startedTs).getTime();
  return m;
}
