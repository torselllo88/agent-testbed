import { randomUUID } from "node:crypto";
import { createConsensusRule, type CastVote, type ConsensusResult, type ConsensusRule } from "../consensus/index.js";
import { getTestbedVersion } from "../config/version.js";
import type { EvaluatorRegistry } from "../evaluation/registry.js";
import type { ScenarioEvaluator } from "../evaluation/types.js";
import type { ProviderRegistry } from "../llm/registry.js";
import { sqliteSynchronousMode, type Db } from "../persistence/db.js";
import { EventRepository } from "../persistence/eventRepository.js";
import { ExperimentRepository } from "../persistence/experimentRepository.js";
import { createScheduler, type RoutingDecision, type Scheduler } from "../scheduling/index.js";
import type { LastTurn } from "../scheduling/types.js";
import { agentVisible, createTransport, type RoomMessage, type Transport } from "../transport/index.js";
import { BudgetTracker, type UsageTotals } from "./budget.js";
import {
  applyRunOverrides,
  canonicalJson,
  configHash,
  HUMAN_INTERACTION_PROFILES,
  parseExperimentConfig,
  supportedProfiles,
  RunOverridesSchema,
  sha256,
  taskDefinitionHash,
  type AgentConfig,
  type ExperimentConfig,
  type RunOverrides,
} from "./config.js";
import type { EvaluationResult } from "../evaluation/types.js";
import type { NarratorSender, RunExtension, RunExtensionContext, RunExtensionFactory } from "./extensions.js";
import { protocolStrings, type ProtocolStrings } from "./protocolStrings.js";
import { EventLog, EventType, redactSecrets } from "./events.js";
import { LlmCaller } from "./llmCaller.js";
import { computeMetrics, type ExperimentMetrics } from "./metrics.js";
import { termination, TerminateRun, type Termination } from "./outcome.js";
import { formatZodError } from "./parseJson.js";
import { assertTransition, Phase } from "./phases.js";
import {
  ProposalEnvelopeSchema,
  proposalJsonSchema,
  renderDiscussionPrompt,
  renderProposalPrompt,
  renderSystemPrompt,
  renderVotePrompt,
  TURN_JSON_SCHEMA,
  TurnResponseSchema,
  VOTE_JSON_SCHEMA,
  VoteResponseSchema,
} from "./protocol.js";
import { ReadinessTracker, type AgentReadiness, type ReadinessChange } from "./readiness.js";

export interface RunnerDeps {
  db: Db;
  providers: ProviderRegistry;
  evaluators: EvaluatorRegistry;
  /** Override for tests; defaults to the transport named in the config. */
  createTransport?: (config: ExperimentConfig) => Transport;
  /**
   * Product / demo features (narration, viewer pacing, ...) attached through
   * the extension interface. Omitted = the pure experiment core.
   */
  extensions?: RunExtensionFactory;
}

export interface RunOptions {
  id?: string;
  scenarioId?: string | null;
  scenarioVersion?: number | null;
  batchId?: string | null;
  conditionKey?: string | null;
  repetition?: number | null;
  origin?: RunEnvironment["origin"];
  /** Per-run settings applied on top of the scenario config (e.g. conversation language). */
  overrides?: RunOverrides;
  /**
   * Nobody watches this run live (batch, CLI). Passed to extensions only
   * (e.g. no viewer pacing); it never changes the experiment or its config.
   */
  headless?: boolean;
}

/** Recorded on experiment_started. The stub latency matters: it changes every duration metric. */
export interface RunEnvironment {
  stubLatencyMs: number;
  /** "external": started through the External Room API (src/rooms). */
  origin: "interactive" | "batch" | "cli" | "external";
  /** Effective SQLite durability mode of the trace database (read back from SQLite). */
  sqliteSynchronous: string;
  /** Process-wide cap on simultaneous requests per real provider; null = unlimited. */
  maxConcurrentRequests: number | null;
  /** Effective conversation language of this run, and whether it came from a per-run override. */
  conversationLanguage: string;
  languageOverridden: boolean;
  scenarioDefaultLanguage: string;
  /** Nobody watched this run live (batch, CLI): add-ons such as viewer pacing were told so. */
  headless: boolean;
}

export type OperatorCommand =
  | { type: "pause" }
  | { type: "resume" }
  /** While paused: let exactly one more activation run, then pause again. */
  | { type: "step" }
  | { type: "select_next"; agentId: string }
  | { type: "force_decision" }
  | { type: "stop" };

/** The only events an extension may add to the trace — never the experiment's own (votes, evaluation, ...). */
const EXTENSION_EVENT_TYPES: ReadonlySet<EventType> = new Set([EventType.PRESENTATION_DELAY, EventType.EXTENSION_NOTE]);
/** Narration posted from a publish hook nests one level; anything deeper is a runaway extension. */
const MAX_PUBLISH_DEPTH = 4;

/** Commands that change what happens in the run (not just when) — they mark the run as intervened. */
const FLOW_ALTERING: ReadonlySet<OperatorCommand["type"]> = new Set(["select_next", "force_decision", "stop"]);

export class InvalidCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCommandError";
  }
}

export interface FrozenProposal {
  readonly id: string;
  readonly attempt: number;
  readonly proposerId: string;
  readonly rationale: string;
  readonly body: unknown;
  /** sha256 of the canonical JSON body — every vote references it. */
  readonly hash: string;
}

export interface LiveState {
  experimentId: string;
  phase: Phase;
  paused: boolean;
  currentAgentId: string | null;
  pendingNextAgentId: string | null;
  turn: number;
  globalTurnLimit: number;
  discussion: { segment: number; turnsUsed: number; turnLimit: number };
  proposalAttempt: number;
  maxProposalAttempts: number;
  readiness: Record<string, AgentReadiness>;
  lastRouting: RoutingDecision | null;
  usage: UsageTotals;
  activeElapsedMs: number;
  /** Viewer pacing waited so far (excluded from activeElapsedMs). */
  presentationDelayMs: number;
  termination: Termination | null;
}

type DiscussionEnd = "all_ready" | "discussion_turn_limit" | "operator";

/**
 * Runs one experiment from INITIALIZING to FINISHED. Owns the lifecycle —
 * phases, turn assignment, budgets, the proposal -> vote -> commit sequence,
 * operator controls — and nothing else: every substantive decision is made
 * by the agents, and correctness is judged afterwards by the evaluator.
 * Manual runs and batch runs go through exactly this class.
 */
export class ExperimentRunner {
  readonly id: string;
  readonly config: ExperimentConfig;

  private readonly experiments: ExperimentRepository;
  private readonly log: EventLog;
  private readonly budget: BudgetTracker;
  private readonly llm: LlmCaller;
  private readonly scheduler: Scheduler;
  private readonly consensus: ConsensusRule;
  private readonly evaluator: ScenarioEvaluator;
  private readonly evaluatorParams: unknown;
  private readonly transport: Transport;
  private readonly readiness: ReadinessTracker;
  private readonly agents: Map<string, AgentConfig>;
  private readonly abort = new AbortController();

  private phase: Phase = Phase.INITIALIZING;
  private started = false;
  private finished: Termination | null = null;
  /** The outcome is decided (execute() settled); only the add-ons' ending (e.g. narration) is still running. */
  private outcomeDecided = false;
  private currentAgentId: string | null = null;
  private lastTurn: LastTurn | null = null;
  private lastRouting: RoutingDecision | null = null;
  private readonly lastActivatedTurn = new Map<string, number>();
  private readonly discussionTurnsByAgent = new Map<string, number>();
  private discussion = { segment: 1, turnsUsed: 0, turnLimit: 0 };
  private proposalAttempt = 1;
  /** Agent-visible messages published so far (the experiment transcript). */
  private transcriptLength = 0;
  private publishDepth = 0;
  private readonly environment: RunEnvironment;
  private readonly strings: ProtocolStrings;
  private evaluation: EvaluationResult | null = null;
  private lastConsensus: ConsensusResult | null = null;
  private readonly extensions: RunExtension[];
  private readonly extensionContext: RunExtensionContext;

  // Operator control state.
  private paused = false;
  private stepsAllowed = 0;
  private stopRequested = false;
  private forceDecisionRequested = false;
  private pendingNextAgentId: string | null = null;
  private wake: (() => void) | null = null;

  /** Validates everything that can be validated up front, so a broken config fails before a run record exists. */
  constructor(
    private readonly deps: RunnerDeps,
    rawConfig: unknown,
    options: RunOptions = {}
  ) {
    const scenarioConfig = parseExperimentConfig(rawConfig);
    const overrides = options.overrides ? RunOverridesSchema.parse(options.overrides) : undefined;
    // What the run snapshots and executes; the saved scenario itself is never modified.
    // Frozen for the whole run: nothing (an extension included) can change what agents are given or how the run is budgeted.
    this.config = deepFreeze(applyRunOverrides(scenarioConfig, overrides));
    this.id = options.id ?? randomUUID();
    this.strings = protocolStrings(this.config.conversation.language);
    this.agents = new Map(this.config.agents.map((a) => [a.id, a]));

    const runnable = checkRunnable(deps, this.config);
    this.evaluator = runnable.evaluator;
    this.evaluatorParams = runnable.evaluatorParams;

    this.experiments = new ExperimentRepository(deps.db);
    this.log = new EventLog(this.id, new EventRepository(deps.db), deps.providers.secretValues(), () => this.phase);
    this.budget = new BudgetTracker(this.config.limits);
    this.llm = new LlmCaller(deps.providers, this.log, this.budget, this.config.runtime, this.abort.signal);
    this.scheduler = createScheduler(this.config.scheduler, { llm: this.llm });
    this.consensus = createConsensusRule(this.config.consensus);
    const headless = options.headless ?? false;
    this.extensions = deps.extensions?.(this.config, { headless }) ?? [];
    this.extensionContext = {
      experimentId: this.id,
      config: this.config,
      options: { headless },
      // Checked at runtime, not only by the types: an extension may post narration only, never as an agent or the moderator.
      post: async (sender: NarratorSender, text: string, meta?: Record<string, unknown>) => {
        if (sender?.kind !== "narrator" || typeof sender.name !== "string") throw new Error("extensions may only post as the narrator");
        return this.publish({ kind: "narrator", name: sender.name }, String(text), meta);
      },
      log: (type, payload) => {
        if (!EXTENSION_EVENT_TYPES.has(type)) throw new Error(`extensions may only log add-on events (${[...EXTENSION_EVENT_TYPES].join(", ")}), not "${type}"`);
        this.log.append(type, payload);
      },
      holdClock: async (fn) => {
        this.budget.beginHold();
        try {
          return await fn();
        } finally {
          this.budget.endHold();
        }
      },
      stopSignal: this.abort.signal,
      subscribe: (listener) => this.log.subscribe(listener),
    };
    // The experiment's own room. Extensions never get hold of it, so they cannot change what agents read.
    this.transport = (deps.createTransport ?? ((c) => createTransport(c.transport)))(this.config);
    this.readiness = new ReadinessTracker(this.config.agents.map((a) => a.id));
    this.discussion.turnLimit = this.config.limits.discussionTurnLimit;
    this.environment = {
      stubLatencyMs: deps.providers.stub.latency,
      origin: options.origin ?? "interactive",
      sqliteSynchronous: sqliteSynchronousMode(deps.db),
      maxConcurrentRequests: deps.providers.maxConcurrentRequests,
      conversationLanguage: this.config.conversation.language,
      languageOverridden: this.config.conversation.language !== scenarioConfig.conversation.language,
      scenarioDefaultLanguage: scenarioConfig.conversation.language,
      headless,
    };

    this.experiments.create({
      id: this.id,
      scenarioId: options.scenarioId,
      scenarioVersion: options.scenarioVersion,
      config: this.config,
      configHash: configHash(this.config),
      taskDefinitionHash: taskDefinitionHash(this.config),
      batchId: options.batchId,
      conditionKey: options.conditionKey,
      repetition: options.repetition,
      testbedVersion: getTestbedVersion(),
    });
    // After the run record exists, so an extension's failure can be traced.
    for (const ext of this.extensions) {
      try {
        ext.attach?.(this.extensionContext);
      } catch (err) {
        this.log.append(EventType.ERROR, { message: `extension "${ext.name}" failed in attach: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }

  // ---------------------------------------------------------------- public API

  async run(): Promise<ExperimentMetrics> {
    if (this.started) throw new Error("ExperimentRunner.run() can only be called once");
    this.started = true;

    let outcome: Termination;
    try {
      outcome = await this.execute();
    } catch (err) {
      if (err instanceof TerminateRun) {
        outcome = err.termination;
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.log.append(EventType.ERROR, { message, stack: err instanceof Error ? err.stack : undefined });
        outcome = termination("ERROR", message);
      }
    }
    this.outcomeDecided = true;
    await this.notifyExtensions("onRunEnded", (ext) =>
      ext.onRunEnded?.(this.extensionContext, {
        termination: outcome,
        evaluation: this.evaluation,
        evaluatorParams: this.evaluatorParams,
        consensus: this.lastConsensus,
      })
    );
    await this.transport.close().catch(() => undefined);
    return this.finish(outcome);
  }

  control(command: OperatorCommand): void {
    if (this.finished) throw new InvalidCommandError("Experiment has already finished");
    if (this.outcomeDecided) {
      // Only the ending presentation is still running: stop just cuts it short. Not an intervention.
      if (command.type !== "stop") throw new InvalidCommandError("The outcome is already decided");
      this.stopRequested = true;
      this.abort.abort(new TerminateRun(termination("STOPPED_BY_OPERATOR", "Stopped by operator")));
      this.log.append(EventType.OPERATOR_INTERVENTION, { command, turn: this.budget.turnsUsed(), flowAltering: false, afterOutcome: true });
      return;
    }
    switch (command.type) {
      case "pause":
        if (this.paused) throw new InvalidCommandError("Already paused");
        this.paused = true;
        break;
      case "resume":
        if (!this.paused) throw new InvalidCommandError("Not paused");
        this.paused = false;
        this.stepsAllowed = 0; // an unused step never carries over into a later pause
        break;
      case "step":
        if (!this.paused) throw new InvalidCommandError("Step is only available while paused");
        this.stepsAllowed += 1;
        break;
      case "select_next":
        if (!this.agents.has(command.agentId)) throw new InvalidCommandError(`Unknown agent "${command.agentId}"`);
        if (this.phase !== Phase.DISCUSSION && this.phase !== Phase.INITIALIZING) {
          throw new InvalidCommandError("Selecting the next agent is only possible during discussion");
        }
        this.pendingNextAgentId = command.agentId;
        break;
      case "force_decision":
        if (this.phase !== Phase.DISCUSSION) throw new InvalidCommandError("Forcing the decision is only possible during discussion");
        this.forceDecisionRequested = true;
        break;
      case "stop":
        this.stopRequested = true;
        this.abort.abort(new TerminateRun(termination("STOPPED_BY_OPERATOR", "Stopped by operator")));
        break;
    }

    const intervened = FLOW_ALTERING.has(command.type);
    this.log.append(EventType.OPERATOR_INTERVENTION, { command, turn: this.budget.turnsUsed(), flowAltering: intervened });
    if (intervened) this.experiments.update(this.id, { intervened: true });
    this.wake?.();
  }

  state(): LiveState {
    return {
      experimentId: this.id,
      phase: this.phase,
      paused: this.paused,
      currentAgentId: this.currentAgentId,
      pendingNextAgentId: this.pendingNextAgentId,
      turn: this.budget.turnsUsed(),
      globalTurnLimit: this.config.limits.globalTurnLimit,
      discussion: { ...this.discussion },
      proposalAttempt: this.proposalAttempt,
      maxProposalAttempts: this.config.decision.maxProposalAttempts,
      readiness: this.readiness.snapshot(),
      lastRouting: this.lastRouting,
      usage: this.budget.totals(),
      activeElapsedMs: this.budget.activeElapsedMs(),
      presentationDelayMs: this.budget.heldMs(),
      termination: this.finished,
    };
  }

  isFinished(): boolean {
    return this.finished !== null;
  }

  // ---------------------------------------------------------------- lifecycle

  private async execute(): Promise<Termination> {
    const { config } = this;
    this.experiments.update(this.id, { startedAt: new Date().toISOString() });
    this.log.append(EventType.EXPERIMENT_STARTED, {
      config,
      configHash: configHash(config),
      taskDefinitionHash: taskDefinitionHash(config),
      testbedVersion: getTestbedVersion(),
      environment: this.environment,
      evaluator: { id: this.evaluator.id, version: this.evaluator.version },
      transport: this.transport.kind,
      scheduler: this.scheduler.type,
      consensusRule: this.consensus.id,
      agents: config.agents.map((a) => ({ id: a.id, name: a.name, role: a.role, model: a.model })),
    });
    this.budget.start();

    await this.transport.open({
      experimentId: this.id,
      participants: config.agents.map((a) => ({ agentId: a.id, displayName: a.name })),
    });
    await this.notifyExtensions("onRoomOpened", (ext) => ext.onRoomOpened?.(this.extensionContext));
    this.transition(Phase.DISCUSSION, { segment: 1, turnLimit: this.discussion.turnLimit });

    for (;;) {
      await this.runDiscussion();

      const proposal = await this.runProposal();
      if (proposal !== "declined") {
        // One step, but N concurrent LLM calls — budget checks happen before and after it, not between the calls.
        this.transition(Phase.VOTING, { proposalId: proposal.id, parallelCalls: config.agents.length });
        const consensus = await this.runVoting(proposal);
        if (consensus.reached) return this.runEvaluation(proposal);
        if (this.proposalAttempt >= config.decision.maxProposalAttempts) {
          throw new TerminateRun(
            termination("CONSENSUS_FAILURE", `No proposal reached ${consensus.rule} after ${this.proposalAttempt} attempt(s)`, {
              lastConsensus: consensus,
            })
          );
        }
      } else if (this.proposalAttempt >= config.decision.maxProposalAttempts) {
        throw new TerminateRun(
          termination("NO_PROPOSAL", `The proposer declined to submit a proposal (attempt ${this.proposalAttempt})`)
        );
      }

      // Budget remains for another attempt: back to discussion with a fresh
      // (shorter) turn allowance and everyone's readiness reset.
      this.proposalAttempt += 1;
      this.readiness.reset();
      this.discussion = { segment: this.discussion.segment + 1, turnsUsed: 0, turnLimit: config.limits.rediscussionTurnLimit };
      this.transition(Phase.DISCUSSION, { segment: this.discussion.segment, turnLimit: this.discussion.turnLimit });
    }
  }

  private async runDiscussion(): Promise<void> {
    let end: DiscussionEnd;
    for (;;) {
      await this.checkpoint();
      if (this.forceDecisionRequested) {
        this.forceDecisionRequested = false;
        end = "operator";
        break;
      }
      if (this.readiness.allReady()) {
        end = "all_ready";
        break;
      }
      if (this.discussion.turnsUsed >= this.discussion.turnLimit) {
        end = "discussion_turn_limit";
        break;
      }
      this.enforceHardLimits(1);

      const decision = await this.route();
      await this.discussionTurn(decision.agentId, decision.source === "readiness_recheck");
      this.discussion.turnsUsed += 1;
    }
    this.pendingNextAgentId = null;
    this.transition(Phase.PROPOSAL, { discussionEnd: end, discussionTurnsUsed: this.discussion.turnsUsed, proposalAttempt: this.proposalAttempt });
  }

  private async route(): Promise<RoutingDecision> {
    let decision: RoutingDecision;
    const stale = this.readiness.staleBlockingConsensus();
    if (this.pendingNextAgentId) {
      decision = { agentId: this.pendingNextAgentId, source: "operator", reason: "selected by operator" };
      this.pendingNextAgentId = null;
    } else if (stale.length > 0) {
      // Everyone has declared readiness, but some declarations predate later
      // information: re-ask exactly those agents. Lifecycle rule, not routing
      // on content.
      decision = { agentId: stale[0]!, source: "readiness_recheck", reason: "readiness went stale after new information", details: { stale } };
    } else {
      decision = await this.scheduler.next({
        config: this.config,
        transcript: await this.agentHistory(),
        lastTurn: this.lastTurn,
        lastActivatedTurn: this.lastActivatedTurn,
        turn: this.budget.turnsUsed() + 1,
      });
    }
    this.lastRouting = decision;
    this.log.append(EventType.ROUTING_DECISION, { ...decision, turn: this.budget.turnsUsed() + 1 }, decision.agentId);
    return decision;
  }

  private async discussionTurn(agentId: string, readinessRecheck = false): Promise<void> {
    const agent = this.agents.get(agentId)!;
    // Why the agent is being asked (lifecycle information, not task content):
    // without it, models answer a re-check with a restated confirmation, which
    // is itself a new message that invalidates everyone else — a loop.
    const declaredAt = this.readiness.get(agentId).declaredAtIndex;
    const turn = this.startTurn(agentId, "discussion");
    const agentTurn = this.discussionTurnsByAgent.get(agentId) ?? 0;
    this.discussionTurnsByAgent.set(agentId, agentTurn + 1);

    const transcript = await this.agentHistory();
    const result = await this.llm.call({
      category: "agent",
      purpose: "discussion",
      agentId,
      modelRef: agent.model,
      messages: [
        { role: "system", content: renderSystemPrompt(this.config, agent) },
        {
          role: "user",
          content: renderDiscussionPrompt(this.config, agent, transcript, {
            discussionTurnsUsed: this.discussion.turnsUsed,
            discussionTurnLimit: this.discussion.turnLimit,
            proposalAttempt: this.proposalAttempt,
            maxProposalAttempts: this.config.decision.maxProposalAttempts,
          }, readinessRecheck ? readinessRecheckNote(transcript, agentId, declaredAt) : undefined),
        },
      ],
      response: { name: "agent_turn", schema: TurnResponseSchema, jsonSchema: TURN_JSON_SCHEMA },
      context: { agentId, purpose: "discussion", agentTurn, turn, segment: this.discussion.segment, proposalAttempt: this.proposalAttempt, readinessRecheck },
      turn,
    });

    if (!result.ok) {
      // The turn happened (it counts), but produced nothing usable: treated
      // like a PASS that leaves the agent's readiness unchanged.
      this.log.append(EventType.PROTOCOL_INCIDENT, { kind: "unparseable_turn", turn, error: result.parseError, rawText: result.rawText }, agentId);
      this.lastTurn = { agentId, pass: true, target: null };
      this.completeTurn(agentId, turn, { kind: "discussion", result: "unparseable" });
      return;
    }

    const response = result.value;
    const pass = response.pass || response.message.trim() === "";
    this.log.append(
      EventType.AGENT_META,
      { turn, pass, target: response.target, intent: response.intent, readyToCommit: response.readyToCommit },
      agentId
    );

    let atIndex = transcript.at(-1)?.index ?? 0;
    if (!pass) {
      const message = await this.publish({ kind: "agent", agentId }, response.message.trim());
      atIndex = message.index;
      this.logReadinessChanges(this.readiness.onSubstantiveMessage(agentId, message.index), "invalidated", message.index);
    }
    const change = this.readiness.declare(agentId, response.readyToCommit, atIndex);
    if (change) this.logReadinessChanges([change], "declared", atIndex);

    this.lastTurn = { agentId, pass, target: pass ? null : response.target };
    this.completeTurn(agentId, turn, { kind: "discussion", result: pass ? "pass" : "message" });
  }

  private async runProposal(): Promise<FrozenProposal | "declined"> {
    const { decision } = this.config;
    const proposer = this.agents.get(decision.proposerId)!;
    const schema = proposalJsonSchema(this.evaluator.proposalSchema);
    this.log.append(EventType.PROPOSAL_REQUESTED, { attempt: this.proposalAttempt, proposerId: proposer.id }, proposer.id);

    let feedback: string | undefined;
    let lastFailure: { kind: "parse" | "schema"; error: string } | null = null;
    for (let formatTry = 0; formatTry <= decision.maxProposalFormatRetries; formatTry++) {
      await this.checkpoint();
      this.enforceHardLimits(1);

      const turn = this.startTurn(proposer.id, "proposal");
      const transcript = await this.agentHistory();
      const result = await this.llm.call({
        category: "agent",
        purpose: "proposal",
        agentId: proposer.id,
        modelRef: proposer.model,
        messages: [
          { role: "system", content: renderSystemPrompt(this.config, proposer) },
          { role: "user", content: renderProposalPrompt(this.config, proposer, transcript, schema, feedback) },
        ],
        response: { name: "final_proposal", schema: ProposalEnvelopeSchema, jsonSchema: schema },
        context: { agentId: proposer.id, purpose: "proposal", proposalAttempt: this.proposalAttempt, formatTry, turn },
        turn,
      });

      if (!result.ok) {
        lastFailure = { kind: "parse", error: result.parseError };
        this.log.append(EventType.PROPOSAL_REJECTED_FORMAT, { attempt: this.proposalAttempt, formatTry, kind: "parse", error: result.parseError, rawText: result.rawText }, proposer.id);
        feedback = `the response was not a JSON object of the required shape (${result.parseError})`;
        this.completeTurn(proposer.id, turn, { kind: "proposal", result: "unparseable" });
        continue;
      }

      const envelope = result.value;
      if (envelope.proposal === null) {
        this.log.append(EventType.PROPOSAL_DECLINED, { attempt: this.proposalAttempt, rationale: envelope.rationale }, proposer.id);
        if (envelope.rationale.trim()) await this.publish({ kind: "agent", agentId: proposer.id }, envelope.rationale.trim());
        this.completeTurn(proposer.id, turn, { kind: "proposal", result: "declined" });
        return "declined";
      }

      // Structure only — never success constraints, which would leak the evaluator.
      const validated = this.evaluator.proposalSchema.safeParse(envelope.proposal);
      if (!validated.success) {
        const error = formatZodError(validated.error);
        lastFailure = { kind: "schema", error };
        this.log.append(
          EventType.PROPOSAL_REJECTED_FORMAT,
          { attempt: this.proposalAttempt, formatTry, kind: "schema", error, proposal: envelope.proposal },
          proposer.id
        );
        feedback = `the proposal does not match the required structure (${error})`;
        this.completeTurn(proposer.id, turn, { kind: "proposal", result: "schema_invalid" });
        continue;
      }

      const frozen: FrozenProposal = deepFreeze({
        id: `${this.id}:p${this.proposalAttempt}`,
        attempt: this.proposalAttempt,
        proposerId: proposer.id,
        rationale: envelope.rationale,
        body: validated.data,
        hash: sha256(canonicalJson(validated.data)),
      });
      this.log.append(EventType.PROPOSAL_FROZEN, { ...frozen }, proposer.id);
      this.completeTurn(proposer.id, turn, { kind: "proposal", result: "frozen" });
      await this.publish(
        { kind: "system" },
        this.strings.proposalSubmitted({
          attempt: frozen.attempt,
          proposerName: proposer.name,
          body: JSON.stringify(frozen.body),
          rationale: frozen.rationale,
        }),
        // Machine-readable: which protocol notice this is, so projections (viewer) can recognize it.
        { notice: { kind: "proposal_submitted", proposalId: frozen.id } }
      );
      return frozen;
    }

    const failure = lastFailure!;
    throw new TerminateRun(
      termination(
        failure.kind === "parse" ? "PROPOSAL_PARSE_FAILED" : "PROPOSAL_INVALID",
        `Proposer ${proposer.id} did not produce a valid proposal after ${decision.maxProposalFormatRetries + 1} submission(s): ${failure.error}`,
        { attempt: this.proposalAttempt, error: failure.error }
      )
    );
  }

  /** Blind and parallel: every agent votes on the same frozen proposal and the same transcript snapshot, without seeing any other vote. */
  private async runVoting(proposal: FrozenProposal): Promise<ConsensusResult> {
    const voters = this.config.agents;
    await this.checkpoint();
    this.enforceHardLimits(voters.length);

    const transcript = await this.agentHistory();
    const proposerName = this.agents.get(proposal.proposerId)!.name;
    const turns = voters.map((voter) => this.startTurn(voter.id, "vote"));

    const settled = await Promise.allSettled(
      voters.map((voter, i) =>
        this.llm.call({
          category: "agent",
          purpose: "vote",
          agentId: voter.id,
          modelRef: voter.model,
          messages: [
            { role: "system", content: renderSystemPrompt(this.config, voter) },
            {
              role: "user",
              content: renderVotePrompt(this.config, voter, transcript, { proposerName, rationale: proposal.rationale, body: proposal.body }),
            },
          ],
          response: { name: "vote", schema: VoteResponseSchema, jsonSchema: VOTE_JSON_SCHEMA },
          context: { agentId: voter.id, purpose: "vote", proposalAttempt: proposal.attempt, proposal: proposal.body, turn: turns[i] },
          turn: turns[i],
        })
      )
    );
    const failure = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failure) throw failure.reason;

    const votes: CastVote[] = voters.map((voter, i) => {
      const result = (settled[i] as PromiseFulfilledResult<Awaited<ReturnType<LlmCaller["call"]>>>).value;
      let vote: CastVote;
      if (result.ok) {
        const value = result.value as { vote: "APPROVE" | "REJECT"; reason: string };
        vote = { agentId: voter.id, vote: value.vote, reason: value.reason };
      } else {
        this.log.append(EventType.PROTOCOL_INCIDENT, { kind: "invalid_vote", turn: turns[i], error: result.parseError, rawText: result.rawText }, voter.id);
        vote = { agentId: voter.id, vote: "INVALID", reason: "" };
      }
      this.log.append(EventType.VOTE_CAST, { proposalId: proposal.id, proposalHash: proposal.hash, vote: vote.vote, reason: vote.reason, turn: turns[i] }, voter.id);
      this.completeTurn(voter.id, turns[i]!, { kind: "vote", result: vote.vote });
      return vote;
    });

    const consensus = this.consensus.decide(votes, voters.map((v) => v.id));
    this.lastConsensus = consensus;
    this.log.append(EventType.CONSENSUS_RESULT, { proposalId: proposal.id, proposalHash: proposal.hash, ...consensus, votes });

    if (!consensus.reached) {
      const reasons = votes
        .filter((v) => v.vote !== "APPROVE")
        .map((v) => this.strings.voteLine({ agentName: this.agents.get(v.agentId)!.name, vote: v.vote, reason: v.reason }))
        .join("\n");
      await this.publish(
        { kind: "system" },
        `${this.strings.proposalNotApproved({
          attempt: proposal.attempt,
          approvals: consensus.approvals,
          eligible: consensus.eligible,
          rule: consensus.rule,
          required: consensus.required,
        })}${reasons ? `\n${reasons}` : ""}`,
        { notice: { kind: "proposal_not_approved", proposalId: proposal.id } }
      );
    }
    return consensus;
  }

  private runEvaluation(proposal: FrozenProposal): Termination {
    this.transition(Phase.COMMITTED, { proposalId: proposal.id, proposalHash: proposal.hash });
    this.transition(Phase.EVALUATION, { evaluator: this.evaluator.id, evaluatorVersion: this.evaluator.version });
    const result = this.evaluator.evaluate(proposal.body, this.evaluatorParams);
    this.evaluation = result;
    this.log.append(EventType.EVALUATION_RESULT, {
      evaluator: this.evaluator.id,
      evaluatorVersion: this.evaluator.version,
      proposalId: proposal.id,
      proposalHash: proposal.hash,
      ...result,
    });
    return result.outcome === "SUCCESS"
      ? termination("SUCCESS", "Committed proposal passed every evaluator check")
      : termination("MISSION_FAILURE", `Committed proposal violated: ${result.violated.join(", ")}`, { violated: result.violated });
  }

  private finish(outcome: Termination): ExperimentMetrics {
    this.finished = outcome;
    this.currentAgentId = null;
    if (this.phase !== Phase.FINISHED) this.transition(Phase.FINISHED, { outcome: outcome.outcome });
    this.log.append(EventType.EXPERIMENT_FINISHED, {
      termination: outcome,
      usage: this.budget.totals(),
      turns: this.budget.turnsUsed(),
      activeElapsedMs: this.budget.activeElapsedMs(),
      pausedMs: this.budget.pausedMs(),
      presentationDelayMs: this.budget.heldMs(),
    });

    const record = this.experiments.getOrThrow(this.id);
    const metrics = computeMetrics(new EventRepository(this.deps.db).list(this.id), { intervened: record.intervened });
    this.experiments.update(this.id, {
      phase: Phase.FINISHED,
      status: outcome.status,
      outcome: outcome.outcome,
      // Provider error texts end up here too: scrub credentials as the event log does.
      outcomeDetail: JSON.parse(
        redactSecrets(JSON.stringify({ category: outcome.category, reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) }), this.deps.providers.secretValues())
      ) as Record<string, unknown>,
      finishedAt: new Date().toISOString(),
      summary: metrics as unknown as Record<string, unknown>,
    });
    return metrics;
  }

  // ---------------------------------------------------------------- helpers

  private transition(to: Phase, payload: Record<string, unknown> = {}): void {
    assertTransition(this.phase, to);
    const from = this.phase;
    this.phase = to;
    this.log.append(EventType.PHASE_CHANGED, { from, to, ...payload });
    this.experiments.update(this.id, { phase: to });
  }

  private startTurn(agentId: string, kind: "discussion" | "proposal" | "vote"): number {
    const turn = this.budget.recordTurn();
    this.currentAgentId = agentId;
    this.log.append(EventType.TURN_STARTED, { turn, kind }, agentId);
    return turn;
  }

  private completeTurn(agentId: string, turn: number, payload: Record<string, unknown>): void {
    this.lastActivatedTurn.set(agentId, turn);
    this.currentAgentId = null;
    this.log.append(EventType.TURN_COMPLETED, { turn, ...payload }, agentId);
  }

  /**
   * The room as agents and schedulers see it — narration is for observers
   * only — numbered by position in the experiment transcript, so what agents
   * read never depends on what else the room shows (narration, humans, ...).
   */
  private async agentHistory(): Promise<RoomMessage[]> {
    return agentVisible(await this.transport.history()).map((m, i) => ({ ...m, index: i + 1 }));
  }

  /** Runs one lifecycle hook on every extension; an extension failure is logged and never changes the run. */
  private async notifyExtensions(hook: string, call: (ext: RunExtension) => Promise<void> | undefined): Promise<void> {
    for (const ext of this.extensions) {
      try {
        await call(ext);
      } catch (err) {
        this.log.append(EventType.ERROR, { message: `extension "${ext.name}" failed in ${hook}: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }

  /**
   * Returns the message with its experiment-transcript index (see
   * agentHistory); narration has none — `index` is null in its event.
   */
  private async publish(sender: RoomMessage["sender"], text: string, extra: Record<string, unknown> = {}): Promise<RoomMessage> {
    // An extension that posts from beforePublish without filtering would recurse forever.
    if (this.publishDepth >= MAX_PUBLISH_DEPTH) throw new Error("publish nested too deeply (an extension posting from its own publish hook?)");
    this.publishDepth += 1;
    try {
      return await this.publishOnce(sender, text, extra);
    } finally {
      this.publishDepth -= 1;
    }
  }

  private async publishOnce(sender: RoomMessage["sender"], text: string, extra: Record<string, unknown>): Promise<RoomMessage> {
    const message = Object.freeze({ sender: Object.freeze({ ...sender }), text });
    for (const ext of this.extensions) {
      if (ext.beforePublish) await this.guarded(ext, "beforePublish", () => ext.beforePublish!(message, this.extensionContext));
    }
    // The room keeps its own copy of the sender: no caller can change a message after it was posted.
    const posted = await this.transport.publish({ sender: { ...sender }, text });
    const index = sender.kind === "narrator" ? null : ++this.transcriptLength;
    this.log.append(
      EventType.MESSAGE_POSTED,
      // Caller metadata first: it can add fields, never overwrite the message's own.
      { ...extra, index, messageId: posted.id, sender: posted.sender, text: posted.text },
      sender.kind === "agent" ? sender.agentId : null
    );
    const result = index === null ? posted : { ...posted, index };
    const frozen = Object.freeze({ ...result, sender: Object.freeze({ ...result.sender }) });
    for (const ext of this.extensions) {
      if (ext.afterPublish) await this.guarded(ext, "afterPublish", () => ext.afterPublish!(frozen, this.extensionContext));
    }
    return result;
  }

  /** Runs one extension hook; a failure is logged and never changes the run. */
  private async guarded(ext: RunExtension, hook: string, call: () => Promise<void> | void): Promise<void> {
    try {
      await call();
    } catch (err) {
      this.log.append(EventType.ERROR, { message: `extension "${ext.name}" failed in ${hook}: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private logReadinessChanges(changes: ReadinessChange[], cause: "declared" | "invalidated", atIndex: number): void {
    for (const change of changes) {
      this.log.append(
        cause === "invalidated" ? EventType.READINESS_INVALIDATED : EventType.READINESS_CHANGED,
        { from: change.from, to: change.to, atIndex },
        change.agentId
      );
    }
  }

  private enforceHardLimits(turnsNeeded: number): void {
    const hit = this.budget.checkHardLimits(turnsNeeded);
    if (hit) throw new TerminateRun(hit);
  }

  /** Step boundary: honors stop, and blocks while paused (paused time does not count against the time limit). */
  private async checkpoint(): Promise<void> {
    // Yield to the event loop between steps. With instant (stub) providers the
    // whole run would otherwise execute in one microtask chain, starving HTTP
    // requests — including the operator's own pause/stop.
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (;;) {
      if (this.stopRequested) throw new TerminateRun(termination("STOPPED_BY_OPERATOR", "Stopped by operator"));
      if (!this.paused) return;
      if (this.stepsAllowed > 0) {
        this.stepsAllowed -= 1;
        return;
      }
      this.budget.pause();
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
      this.budget.resume();
    }
  }
}

/** Prompt note for a readiness re-check turn: which messages arrived since the agent declared readiness. */
function readinessRecheckNote(transcript: RoomMessage[], agentId: string, declaredAt: number | null): string {
  const newer = transcript.filter((m) => m.index > (declaredAt ?? 0) && !(m.sender.kind === "agent" && m.sender.agentId === agentId));
  const range = newer.length ? (newer.length === 1 ? `#${newer[0]!.index}` : `#${newer[0]!.index}–#${newer.at(-1)!.index}`) : "new messages";
  return (
    `You are being asked to re-confirm your readiness: you declared readyToCommit earlier, and ${range} arrived after that. ` +
    "If those messages do not change your view, PASS (pass=true, empty message) with readyToCommit=true — do not post a restating confirmation. " +
    "Post a message only if you have new information or an objection."
  );
}

/** A schema-valid config that still cannot run here (unknown evaluator, bad params, provider not configured, ...). */
export class ConfigNotRunnableError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Config cannot run: ${problems.join("; ")}`);
    this.name = "ConfigNotRunnableError";
  }
}

/**
 * Everything beyond the config schema that must hold for a run to start —
 * checked before a run record is created, and by the editor's validation.
 */
export function checkRunnable(
  deps: Pick<RunnerDeps, "providers" | "evaluators">,
  config: ExperimentConfig
): { evaluator: ScenarioEvaluator; evaluatorParams: unknown } {
  const problems: string[] = [];
  let evaluator: ScenarioEvaluator | undefined;
  let evaluatorParams: unknown;
  try {
    evaluator = deps.evaluators.get(config.evaluator.id);
    const params = evaluator.paramsSchema.safeParse(config.evaluator.params);
    if (params.success) evaluatorParams = params.data;
    else problems.push(`evaluator.params: ${formatZodError(params.error)}`);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }

  const modelRefs: Array<[string, ExperimentConfig["agents"][number]["model"]]> = config.agents.map((a) => [`agent "${a.id}"`, a.model]);
  if (config.scheduler.type === "hybrid" && config.scheduler.classifier) modelRefs.push(["router classifier", config.scheduler.classifier]);
  if (config.humanInteraction?.debrief.router) modelRefs.push(["debrief router", config.humanInteraction.debrief.router]);
  for (const [who, ref] of modelRefs) {
    if (!deps.providers.has(ref.provider)) {
      problems.push(`${who}: LLM provider "${ref.provider}" is not configured`);
    } else if (ref.provider === "stub" && !deps.providers.stub.models().includes(ref.model)) {
      problems.push(`${who}: unknown stub model "${ref.model}" (available: ${deps.providers.stub.models().join(", ")})`);
    }
  }
  // A profile that would change experiment semantics must not silently run as something else.
  const profile = config.humanInteraction?.profile;
  if (profile && !HUMAN_INTERACTION_PROFILES[profile].supported) {
    problems.push(`humanInteraction.profile "${profile}" is not supported yet (supported: ${supportedProfiles().join(", ")})`);
  }

  if (problems.length > 0 || !evaluator) throw new ConfigNotRunnableError(problems);
  return { evaluator, evaluatorParams };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
