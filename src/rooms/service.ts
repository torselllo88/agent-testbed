import { randomUUID } from "node:crypto";
import type { ConsensusResult } from "../consensus/index.js";
import type { EvaluatorRegistry } from "../evaluation/registry.js";
import { parseExperimentConfig, type ExperimentConfig } from "../experiment/config.js";
import type { ExperimentEvent } from "../experiment/events.js";
import type { RunExtension, RunExtensionContext, RunExtensionFactory } from "../experiment/extensions.js";
import { checkRunnable, ConfigNotRunnableError, InvalidCommandError } from "../experiment/runner.js";
import type { ExperimentService } from "../experiment/service.js";
import type { HumanInteractionService, OutletMessage, RoomOutlet } from "../interaction/service.js";
import { agentDisplayName, noticeSenderName } from "../interaction/strings.js";
import type { ProviderRegistry } from "../llm/registry.js";
import type { Db } from "../persistence/db.js";
import { ExperimentRepository, type ExperimentRecord } from "../persistence/experimentRepository.js";
import { RoomRepository, type OutboxEvent, type RoomBindingRecord, type RoomParticipantBinding } from "../persistence/roomRepository.js";
import { ScenarioRepository, type ScenarioRecord } from "../persistence/scenarioRepository.js";
import { renderProposalCard } from "../presentation/proposalCard.js";

/**
 * External Room API — a run projected into a room the testbed does not own
 * (docs/external-room-api.md). Scenario- and vendor-agnostic: participants
 * come from the scenario, `provider` is an opaque string, and nothing here
 * knows Matrix or any chat product.
 *
 * The experiment stays authoritative. Its own room (the local transport) is
 * where agents coordinate; the external room is an asynchronous projection:
 *
 *   visible messages (agents, narration, protocol notices)  -> run extension
 *   notices and debrief answers (human-interaction layer)   -> RoomOutlet
 *   run / debrief state                                      -> run.state
 *
 * all written to one persistent, ordered outbox per binding. The consumer
 * reads it with a cursor, publishes strictly in order, and acknowledges each
 * event with the external event id it produced. Human messages come back
 * through inbound(), deduplicated by external event id, and go to the
 * human-interaction layer like any other room's messages. Nothing a
 * consumer does can reach the experiment itself; delivery lag never blocks it.
 */

export const SYSTEM_PARTICIPANT_ID = "system";

export type BindingState = "ACTIVE" | "DEBRIEF" | "COMPLETED" | "INTERRUPTED" | "CLOSED";

export class RoomApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "RoomApiError";
  }
}

export interface ExternalRoomDeps {
  db: Db;
  providers: ProviderRegistry;
  evaluators: EvaluatorRegistry;
  experiments: ExperimentService;
  interaction: HumanInteractionService;
  /** Scenarios that may be started externally: built-in ids or library scenario ids. Default-deny. */
  allowedScenarios: string[];
  now?: () => number;
}

export interface ParticipantDescriptor {
  id: string;
  kind: "agent" | "system";
  displayName: string;
  role: string;
  required: true;
}

export interface StartBindingInput {
  scenarioId: string;
  room: { provider: string; roomId: string };
  participants: RoomParticipantBinding[];
  overrides?: { conversationLanguage?: string };
}

const MAX_WAIT_MS = 25_000;

/** Short localized line for a proposal when the scenario has no presentation template. */
function proposalFallback(language: string, proposerName: string, attempt: number): string {
  return language.toLowerCase().startsWith("ru")
    ? `${proposerName} выносит итоговое предложение №${attempt} на голосование.`
    : `${proposerName} puts final proposal #${attempt} to the vote.`;
}

function configOf(record: { config: ExperimentConfig }): ExperimentConfig {
  try {
    return parseExperimentConfig(record.config);
  } catch {
    return record.config;
  }
}

export class ExternalRoomService implements RoomOutlet {
  private readonly rooms: RoomRepository;
  private readonly experimentsRepo: ExperimentRepository;
  private readonly scenarios: ScenarioRepository;
  private readonly now: () => number;
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly deps: ExternalRoomDeps) {
    this.rooms = new RoomRepository(deps.db);
    this.experimentsRepo = new ExperimentRepository(deps.db);
    this.scenarios = new ScenarioRepository(deps.db);
    this.now = deps.now ?? Date.now;
    // Debrief state, mirrored as run.state for bound runs.
    deps.interaction.subscribe((experimentId, event) => {
      if (event.type !== "debrief_started" && event.type !== "debrief_closed") return;
      const binding = this.rooms.bindingForExperiment(experimentId);
      if (!binding) return;
      if (event.type === "debrief_started") this.appendState(binding, "debrief_open", { session: event.payload.number });
      else this.appendState(binding, "debrief_closed", { reason: event.payload.reason });
    });
  }

  // ---------------------------------------------------------------- discovery

  /** Scenarios this deployment allows to be started externally — only those that can actually run here. */
  listScenarios() {
    return this.deps.allowedScenarios.flatMap((id) => {
      const scenario = this.resolveScenario(id);
      if (!scenario) return [];
      const config = configOf(scenario);
      try {
        checkRunnable(this.deps, config);
      } catch {
        return [];
      }
      return [this.describeScenario(id, scenario, config)];
    });
  }

  private resolveScenario(id: string): ScenarioRecord | undefined {
    return this.scenarios.getBuiltin(id) ?? this.scenarios.get(id);
  }

  private describeScenario(id: string, scenario: ScenarioRecord, config: ExperimentConfig) {
    return {
      id,
      name: config.name,
      description: config.description,
      version: scenario.version,
      participants: this.participantsOf(config),
      allowedOverrides: {
        conversationLanguage: { type: "enum", values: this.languagesOf(config), default: config.conversation.language },
      },
      humanInteraction: { profile: config.humanInteraction?.profile ?? "OBSERVE" },
    };
  }

  private participantsOf(config: ExperimentConfig): ParticipantDescriptor[] {
    return [
      ...config.agents.map((a) => ({ id: a.id, kind: "agent" as const, displayName: agentDisplayName(config, a.id), role: a.role, required: true as const })),
      { id: SYSTEM_PARTICIPANT_ID, kind: "system" as const, displayName: noticeSenderName(config), role: "Narration and room notices", required: true as const },
    ];
  }

  private languagesOf(config: ExperimentConfig): string[] {
    return [...new Set([config.conversation.language, ...Object.keys(config.presentation.strings)])];
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Binds a new run to an external room and starts it. The binding exists
   * before the run does, so even the very first visible message (the opening
   * narration) is in the outbox.
   */
  start(input: StartBindingInput) {
    if (!this.deps.allowedScenarios.includes(input.scenarioId)) {
      throw new RoomApiError(403, "SCENARIO_NOT_ALLOWED", `Scenario "${input.scenarioId}" is not available through the External Room API`);
    }
    const scenario = this.resolveScenario(input.scenarioId);
    if (!scenario) throw new RoomApiError(404, "SCENARIO_NOT_FOUND", `Scenario "${input.scenarioId}" does not exist`);
    const config = configOf(scenario);

    const declared = this.participantsOf(config).map((p) => p.id);
    const given = input.participants.map((p) => p.participantId);
    const unknown = given.filter((id) => !declared.includes(id));
    const missing = declared.filter((id) => !given.includes(id));
    // Several participants may share one external identity (a room system that can only post as one bot);
    // each participant id must still be mapped exactly once.
    const duplicates = [...new Set(given.filter((id, i) => given.indexOf(id) !== i))];
    if (unknown.length || missing.length || duplicates.length) {
      throw new RoomApiError(400, "INVALID_PARTICIPANTS", "participants must map every declared participant id exactly once", {
        missing,
        unknown,
        duplicates,
      });
    }

    const language = input.overrides?.conversationLanguage;
    if (language !== undefined && !this.languagesOf(config).includes(language)) {
      throw new RoomApiError(400, "OVERRIDE_NOT_ALLOWED", `conversationLanguage "${language}" is not offered by this scenario`, { allowed: this.languagesOf(config) });
    }

    const busy = this.busyBinding(input.room.provider, input.room.roomId);
    if (busy) {
      throw new RoomApiError(409, "ROOM_BUSY", `The room already has a binding that is ${busy.reason === "active" ? "active" : "not fully delivered"}`, {
        reason: busy.reason,
        bindingId: busy.binding.id,
      });
    }

    try {
      checkRunnable(this.deps, config);
    } catch (err) {
      if (err instanceof ConfigNotRunnableError) throw new RoomApiError(422, "SCENARIO_NOT_RUNNABLE", err.message, { problems: err.problems });
      throw err;
    }

    const experimentId = randomUUID();
    const binding = this.rooms.createBindingForStart({
      id: `rb_${randomUUID()}`,
      experimentId,
      provider: input.room.provider,
      roomId: input.room.roomId,
      participants: input.participants,
      createdAt: new Date(this.now()).toISOString(),
    });
    try {
      this.deps.experiments.start({
        id: experimentId,
        config: scenario.config,
        scenarioId: scenario.id,
        scenarioVersion: scenario.version,
        origin: "external",
        overrides: language ? { language } : undefined,
      });
    } catch (err) {
      this.rooms.discardBinding(binding.id);
      throw err;
    }
    return this.view(binding.id);
  }

  /** Ends whatever is live — the mission or the debrief — leaving the binding readable (COMPLETED). */
  stop(bindingId: string) {
    const binding = this.binding(bindingId);
    if (this.deps.experiments.isRunning(binding.experimentId)) {
      try {
        this.deps.experiments.control(binding.experimentId, { type: "stop" });
      } catch (err) {
        if (!(err instanceof InvalidCommandError)) throw err; // it finished in the meantime — nothing to stop
      }
    }
    if (this.deps.interaction.isDebriefOpen(binding.experimentId)) this.deps.interaction.closeDebrief(binding.experimentId, "external stop");
    return this.view(bindingId);
  }

  /**
   * Why a debrief may not open for this experiment now (null: it may).
   *  - automatic: not once its binding is closed;
   *  - by the operator (also after COMPLETED / INTERRUPTED): only while its binding is still the latest
   *    open one of its room — a room holds one run at a time, and the adapter follows the newest binding.
   * A closed binding detached the experiment from its room: an operator debrief is then local only.
   */
  debriefBlocked(experimentId: string, openedBy: "auto" | "operator"): string | null {
    const binding = this.rooms.bindingForExperiment(experimentId);
    if (!binding) return null;
    if (binding.closedAt) return openedBy === "auto" ? "its external room binding is closed" : null;
    const bindings = this.rooms.bindingsForRoom(binding.provider, binding.roomId);
    const newer = bindings.slice(bindings.findIndex((b) => b.id === binding.id) + 1).some((b) => !b.closedAt);
    return newer ? "its external room is already held by a newer binding" : null;
  }

  /** An automatic debrief after the run opens only while the binding is not closed. */
  mayOpenDebrief(experimentId: string): boolean {
    return this.debriefBlocked(experimentId, "auto") === null;
  }

  /** The experiment's binding while it is not closed: people then talk to it in that room, not elsewhere. */
  openBindingFor(experimentId: string): { bindingId: string; provider: string; roomId: string; state: string } | null {
    const binding = this.rooms.bindingForExperiment(experimentId);
    if (!binding || binding.closedAt) return null;
    return { bindingId: binding.id, provider: binding.provider, roomId: binding.roomId, state: this.view(binding.id).state };
  }

  /** Closes the binding for good: stops anything live; inbound is refused afterwards. The outbox stays readable. */
  close(bindingId: string) {
    // Closed first, so nothing that the stop triggers (an ending, a debrief) lands in this binding's outbox.
    this.rooms.closeBinding(bindingId, new Date(this.now()).toISOString());
    this.stop(bindingId);
    this.notify(bindingId);
    return this.view(bindingId);
  }

  /**
   * After recovery: a run cut off by a crash has no final message from the
   * runner, so its binding gets an explicit run.state "interrupted" — once,
   * whatever followed it (an operator's debrief on the finished run). A closed
   * binding's outbox is final and gets nothing.
   */
  recoverInterrupted(): number {
    const bindings = this.rooms.bindingsMissingInterrupted();
    for (const binding of bindings) this.appendState(binding, "interrupted", { outcome: "INTERRUPTED" });
    return bindings.length;
  }

  /** Before an experiment is deleted: its binding, outbox and inbound record go with it. */
  forgetExperiment(experimentId: string): void {
    const binding = this.rooms.bindingForExperiment(experimentId);
    if (binding) this.rooms.discardBinding(binding.id);
  }

  // ---------------------------------------------------------------- read side

  find(provider: string, roomId: string, activeOnly: boolean) {
    return this.rooms
      .bindingsForRoom(provider, roomId)
      .map((b) => this.view(b.id))
      .filter((v) => !activeOnly || v.state === "ACTIVE" || v.state === "DEBRIEF");
  }

  view(bindingId: string) {
    const binding = this.binding(bindingId);
    const record = this.experimentsRepo.getOrThrow(binding.experimentId);
    return {
      bindingId: binding.id,
      experimentId: binding.experimentId,
      room: { provider: binding.provider, roomId: binding.roomId },
      participants: binding.participants,
      state: this.stateOf(binding, record),
      scenario: { id: record.scenarioId, version: record.scenarioVersion, name: record.config.name },
      conversationLanguage: record.config.conversation.language,
      outcome: record.outcome,
      createdAt: binding.createdAt,
      closedAt: binding.closedAt,
      delivery: this.rooms.deliveryState(binding.id),
    };
  }

  /** The outbox after a cursor; with waitMs, long-polls until something arrives or the wait ends. */
  async events(bindingId: string, afterSeq: number, limit: number, waitMs: number, signal?: AbortSignal) {
    this.binding(bindingId);
    const read = () => this.rooms.listOutbox(bindingId, afterSeq, limit).map(toWire);
    let events = read();
    if (events.length === 0 && waitMs > 0) {
      await this.waitFor(bindingId, Math.min(waitMs, MAX_WAIT_MS), signal);
      events = read();
    }
    return { events, nextAfter: events.at(-1)?.seq ?? afterSeq, state: this.stateOf(this.binding(bindingId)) };
  }

  /** Idempotent acknowledgements: repeating the same ack is harmless; a different external id for an acked event is a conflict. */
  ack(bindingId: string, acks: Array<{ messageId: string; externalEventId?: string | null }>) {
    this.binding(bindingId);
    const results = acks.map(({ messageId, externalEventId = null }) => {
      const event = this.rooms.outboxByMessageId(bindingId, messageId);
      if (!event) return { messageId, status: "unknown" as const };
      if (event.ackedAt) {
        return event.externalEventId === externalEventId
          ? { messageId, status: "duplicate" as const }
          : { messageId, status: "conflict" as const, externalEventId: event.externalEventId };
      }
      this.rooms.ack(bindingId, messageId, externalEventId, new Date(this.now()).toISOString());
      return { messageId, status: "acked" as const };
    });
    return { results, delivery: this.rooms.deliveryState(bindingId) };
  }

  // ---------------------------------------------------------------- inbound

  /** A new text message a person posted in the external room. Deduplicated by its external event id. */
  async inbound(
    bindingId: string,
    input: {
      externalEventId: string;
      sender: { externalUserId: string; displayName: string };
      body: string;
      replyToExternalEventId?: string | null;
      mentions?: string[];
    }
  ) {
    const binding = this.binding(bindingId);
    if (binding.closedAt) throw new RoomApiError(409, "BINDING_CLOSED", "The binding is closed");

    const previous = this.rooms.inbound(bindingId, input.externalEventId);
    if (previous) return { ...previous.result, status: "duplicate" };

    // Never treat our own publications as human input.
    const own = binding.participants.some((p) => p.externalUserId === input.sender.externalUserId)
      ? "bound_identity"
      : this.rooms.outboxByExternalEventId(bindingId, input.externalEventId)
        ? "own_event"
        : null;
    if (own) {
      const result = { status: "ignored", reason: own };
      this.rooms.recordInbound(bindingId, input.externalEventId, null, result, new Date(this.now()).toISOString());
      return result;
    }

    const messageId = `h_${randomUUID()}`;
    // Reserve the event id synchronously, before any await: a concurrent retry sees it and has no second effect.
    this.rooms.recordInbound(bindingId, input.externalEventId, messageId, { status: "accepted", messageId, pending: true }, new Date(this.now()).toISOString());

    const replyTo = input.replyToExternalEventId ? this.internalIdOf(bindingId, input.replyToExternalEventId) : null;
    const mentions = (input.mentions ?? []).flatMap((u) => {
      const agents = binding.participants.filter((p) => p.externalUserId === u && p.participantId !== SYSTEM_PARTICIPANT_ID);
      return agents.length === 1 ? [agents[0]!.participantId] : []; // a shared identity names nobody in particular
    });
    let received: Awaited<ReturnType<HumanInteractionService["receive"]>>;
    try {
      received = await this.deps.interaction.receive(binding.experimentId, {
        messageId,
        senderId: input.sender.externalUserId,
        displayName: input.sender.displayName,
        text: input.body,
        replyTo,
        mentions,
      });
    } catch (err) {
      this.rooms.deleteInbound(bindingId, input.externalEventId);
      throw err;
    }
    const result = {
      status: "accepted",
      messageId,
      disposition: received.disposition,
      queued: received.queued ?? null,
      rejected: received.rejected ?? null,
    };
    this.rooms.updateInboundResult(bindingId, input.externalEventId, result);
    return result;
  }

  /** External event id -> the internal id of the message it refers to (one of ours, or an earlier human message). */
  private internalIdOf(bindingId: string, externalEventId: string): string | null {
    const ours = this.rooms.outboxByExternalEventId(bindingId, externalEventId);
    if (ours) return ours.internalMessageId;
    return this.rooms.inbound(bindingId, externalEventId)?.internalMessageId ?? null;
  }

  // ---------------------------------------------------------------- RoomOutlet (human-interaction layer -> room)

  async post(experimentId: string, message: OutletMessage): Promise<string> {
    const binding = this.rooms.bindingForExperiment(experimentId);
    const messageId = `om_${randomUUID()}`;
    if (!binding || binding.closedAt) return messageId; // not (or no longer) externally bound: the local viewer reads the interaction log
    const config = configOf(this.experimentsRepo.getOrThrow(experimentId));
    const agent = message.sender.kind === "agent" ? message.sender.agentId : null;
    const replyToExternalEventId = message.replyTo ? (this.rooms.inboundByInternalId(binding.id, message.replyTo)?.externalEventId ?? null) : null;
    this.appendMessage(binding, {
      messageId,
      internalMessageId: messageId,
      kind: agent ? "debrief_answer" : "room_notice",
      participantId: agent ?? SYSTEM_PARTICIPANT_ID,
      displayName: agent ? agentDisplayName(config, agent) : message.sender.kind === "notice" ? message.sender.name : noticeSenderName(config),
      body: message.text,
      replyToExternalEventId,
      data: message.noticeKind ? { noticeType: message.noticeKind } : undefined,
    });
    return messageId;
  }

  // ---------------------------------------------------------------- projection of the run (a run extension)

  /** Attach to runs as an extension; it does nothing for runs that are not externally bound. */
  readonly extensions: RunExtensionFactory = () => [this.projection()];

  private projection(): RunExtension {
    return {
      name: "external-room",
      attach: (ctx) => {
        const binding = this.rooms.bindingForExperiment(ctx.experimentId);
        if (!binding) return;
        const projector = new RunProjector(binding, ctx, this);
        ctx.subscribe((event) => projector.observe(event));
      },
    };
  }

  /** @internal used by RunProjector */
  appendMessage(
    bindingRecord: RoomBindingRecord,
    m: {
      messageId?: string;
      internalMessageId: string | null;
      kind: string;
      participantId: string;
      displayName: string;
      body: string;
      replyToExternalEventId?: string | null;
      data?: Record<string, unknown>;
    }
  ): void {
    const binding = this.rooms.getBinding(bindingRecord.id);
    if (!binding || binding.closedAt) return; // a closed binding's outbox is final
    const externalUserId = binding.participants.find((p) => p.participantId === m.participantId)?.externalUserId ?? null;
    this.rooms.appendOutbox(binding.id, {
      messageId: m.messageId ?? `om_${randomUUID()}`,
      type: "message",
      internalMessageId: m.internalMessageId,
      createdAt: new Date(this.now()).toISOString(),
      payload: {
        kind: m.kind,
        sender: { participantId: m.participantId, externalUserId, displayName: m.displayName },
        body: m.body,
        replyToMessageId: null,
        replyToExternalEventId: m.replyToExternalEventId ?? null,
        ...(m.data ? { data: m.data } : {}),
      },
    });
    this.notify(binding.id);
  }

  /** @internal used by RunProjector */
  appendState(bindingRecord: RoomBindingRecord, state: string, data?: Record<string, unknown>): void {
    const binding = this.rooms.getBinding(bindingRecord.id);
    if (!binding || binding.closedAt) return; // a closed binding's outbox is final
    this.rooms.appendOutbox(binding.id, {
      messageId: `os_${randomUUID()}`,
      type: "run.state",
      internalMessageId: null,
      createdAt: new Date(this.now()).toISOString(),
      payload: { state, ...(data ? { data } : {}) },
    });
    this.notify(binding.id);
  }

  // ---------------------------------------------------------------- helpers

  private binding(id: string): RoomBindingRecord {
    const binding = this.rooms.getBinding(id);
    if (!binding) throw new RoomApiError(404, "BINDING_NOT_FOUND", `Binding not found: ${id}`);
    return binding;
  }

  private stateOf(binding: RoomBindingRecord, record?: ExperimentRecord): BindingState {
    if (binding.closedAt) return "CLOSED";
    if (this.deps.experiments.isRunning(binding.experimentId)) return "ACTIVE";
    if (this.deps.interaction.isDebriefOpen(binding.experimentId)) return "DEBRIEF";
    const outcome = (record ?? this.experimentsRepo.get(binding.experimentId))?.outcome;
    return outcome === "INTERRUPTED" ? "INTERRUPTED" : "COMPLETED";
  }

  private busyBinding(provider: string, roomId: string): { binding: RoomBindingRecord; reason: "active" | "undelivered" } | null {
    for (const binding of this.rooms.bindingsForRoom(provider, roomId)) {
      const state = this.stateOf(binding);
      if (state === "ACTIVE" || state === "DEBRIEF") return { binding, reason: "active" };
      if (state !== "CLOSED" && this.rooms.deliveryState(binding.id).unacked.length > 0) return { binding, reason: "undelivered" };
    }
    return null;
  }

  private notify(bindingId: string): void {
    const set = this.waiters.get(bindingId);
    if (!set) return;
    this.waiters.delete(bindingId);
    for (const wake of set) wake();
  }

  private waitFor(bindingId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const set = this.waiters.get(bindingId) ?? new Set<() => void>();
      this.waiters.set(bindingId, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0 && this.waiters.get(bindingId) === set) this.waiters.delete(bindingId);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      set.add(done);
    });
  }
}

/** One bound run: turns the run's visible messages and phases into outbox events. */
class RunProjector {
  private readonly proposals = new Map<string, { proposerId: string; body: unknown; rationale: string; attempt: number }>();
  private lastConsensus: (ConsensusResult & { votes?: Array<{ agentId: string; vote: string; reason: string }> }) | null = null;
  private started = false;

  constructor(
    private readonly binding: RoomBindingRecord,
    private readonly ctx: RunExtensionContext,
    private readonly rooms: ExternalRoomService
  ) {}

  observe(event: ExperimentEvent): void {
    const p = event.payload as Record<string, any>;
    const config = this.ctx.config;
    switch (event.type) {
      case "phase_changed": {
        if (!this.started && p.to === "DISCUSSION") {
          this.started = true;
          this.rooms.appendState(this.binding, "run_started");
        }
        // FINISHED is announced as run_finished (with the outcome) on experiment_finished.
        if (p.to !== "FINISHED") this.rooms.appendState(this.binding, String(p.to).toLowerCase());
        return;
      }
      case "proposal_frozen":
        this.proposals.set(String(p.id), { proposerId: String(p.proposerId), body: p.body, rationale: String(p.rationale ?? ""), attempt: Number(p.attempt) });
        return;
      case "consensus_result":
        this.lastConsensus = p as ConsensusResult;
        return;
      case "experiment_finished":
        this.rooms.appendState(this.binding, "run_finished", { outcome: p.termination?.outcome, status: p.termination?.status });
        return;
      case "message_posted":
        break;
      default:
        return;
    }

    const sender = p.sender as { kind: string; agentId?: string; name?: string };
    const internalMessageId = String(p.messageId);
    if (sender.kind === "agent") {
      this.rooms.appendMessage(this.binding, {
        internalMessageId,
        kind: "agent_message",
        participantId: sender.agentId!,
        displayName: agentDisplayName(config as ExperimentConfig, sender.agentId!),
        body: String(p.text),
      });
      return;
    }
    const systemName = noticeSenderName(config as ExperimentConfig);
    if (sender.kind === "narrator") {
      this.rooms.appendMessage(this.binding, {
        internalMessageId,
        kind: "narration",
        participantId: SYSTEM_PARTICIPANT_ID,
        displayName: sender.name ?? systemName,
        body: String(p.text),
        data: p.narration ? { source: p.narration.source, ...(p.narration.part ? { part: p.narration.part, of: p.narration.of } : {}) } : undefined,
      });
      return;
    }

    // Protocol notices: people get a readable body plus structured data; the exact text agents read stays inside.
    const notice = p.notice as { kind?: string; proposalId?: string } | undefined;
    if (notice?.kind === "proposal_submitted" && notice.proposalId && this.proposals.has(notice.proposalId)) {
      const proposal = this.proposals.get(notice.proposalId)!;
      const proposer = agentDisplayName(config as ExperimentConfig, proposal.proposerId);
      this.rooms.appendMessage(this.binding, {
        internalMessageId,
        kind: "protocol_notice",
        participantId: SYSTEM_PARTICIPANT_ID,
        displayName: systemName,
        body: renderProposalCard(config as ExperimentConfig, proposal, proposer) ?? proposalFallback(config.conversation.language, proposer, proposal.attempt),
        data: { noticeType: "proposal_submitted", proposalId: notice.proposalId, attempt: proposal.attempt, proposerId: proposal.proposerId, proposal: proposal.body },
      });
      return;
    }
    const consensus = this.lastConsensus;
    this.rooms.appendMessage(this.binding, {
      internalMessageId,
      kind: "protocol_notice",
      participantId: SYSTEM_PARTICIPANT_ID,
      displayName: systemName,
      body: String(p.text),
      data:
        notice?.kind === "proposal_not_approved" && consensus
          ? {
              noticeType: "proposal_not_approved",
              proposalId: notice.proposalId,
              approvals: consensus.approvals,
              eligible: consensus.eligible,
              required: consensus.required,
              rule: consensus.rule,
              votes: (consensus.votes ?? []).map((v) => ({ participantId: v.agentId, vote: v.vote, reason: v.reason })),
            }
          : notice?.kind
            ? { noticeType: notice.kind }
            : undefined,
    });
  }
}

/** The consumer-facing shape of an outbox event. */
function toWire(e: OutboxEvent) {
  return { seq: e.seq, messageId: e.messageId, type: e.type, createdAt: e.createdAt, ...e.payload };
}
