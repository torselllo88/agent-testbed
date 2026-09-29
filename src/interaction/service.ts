import { randomUUID } from "node:crypto";
import { parseExperimentConfig, type ExperimentConfig, type HumanInteractionConfig, HumanInteractionConfigSchema } from "../experiment/config.js";
import { redactSecrets } from "../experiment/events.js";
import type { ExperimentService } from "../experiment/service.js";
import type { ProviderRegistry } from "../llm/registry.js";
import type { Db } from "../persistence/db.js";
import { EventRepository } from "../persistence/eventRepository.js";
import { ExperimentRepository, type ExperimentRecord } from "../persistence/experimentRepository.js";
import { InteractionRepository, type DebriefSessionRecord, type InteractionEvent } from "../persistence/interactionRepository.js";
import type { HumanRoomMessage } from "../transport/humans.js";
import { DebriefSession } from "./debrief.js";
import { missionRecord, type DebriefExchange, type MissionRecord } from "./debriefPrompt.js";
import { noticeSenderName, noticeText, type NoticeKind } from "./strings.js";

/**
 * Who posts into the room on behalf of the human-interaction layer: notices
 * (in the narrator's voice) and the characters' debrief answers.
 */
export type InteractionSender = { kind: "notice"; name: string } | { kind: "agent"; agentId: string };

/**
 * The room as this layer writes to it. Local rooms need nothing beyond the
 * interaction log (the viewer reads it); a Chums adapter would post to the
 * real room and return its message id.
 */
export interface RoomOutlet {
  post(experimentId: string, message: { sender: InteractionSender; text: string }): Promise<string>;
}

export const localRoomOutlet: RoomOutlet = {
  async post() {
    return `local-h-${randomUUID()}`;
  },
};

export interface HumanInteractionDeps {
  db: Db;
  providers: ProviderRegistry;
  experiments: Pick<ExperimentService, "isRunning" | "onRunFinished">;
  outlet?: RoomOutlet;
  now?: () => number;
}

export class InteractionError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 = 409
  ) {
    super(message);
    this.name = "InteractionError";
  }
}

export type Disposition = "spectator" | "question";

export interface ReceiveResult {
  messageId: string;
  disposition: Disposition;
  /** For questions: queued (with position) or rejected (with reason). */
  queued?: { position: number } | null;
  rejected?: string | null;
}

export type InteractionMode = "mission" | "debrief" | "closed" | "observe";

/**
 * The human side of an experiment's room — everything people do there that
 * is not the experiment:
 *
 *   while the run is active  human messages are spectator chat. They are
 *                            recorded here, answered at most with a
 *                            rate-limited notice, and never reach the run:
 *                            not its agents, scheduler, readiness, budget,
 *                            proposal, votes or trace.
 *   after the outcome        (profile DEBRIEF) a separate DebriefSession
 *                            answers questions, one at a time, in FIFO order.
 *
 * Source-agnostic: the local viewer (HTTP) and, later, a Chums adapter hand
 * new text messages to receive(). Room text is always just chat — it can
 * never invoke an operator control; those exist only as API/UI actions.
 * Persistence is separate from the experiment (interaction_events,
 * debrief_sessions), cross-referenced by experiment id.
 */
export class HumanInteractionService {
  private readonly repo: InteractionRepository;
  private readonly experiments: ExperimentRepository;
  private readonly events: EventRepository;
  private readonly outlet: RoomOutlet;
  private readonly now: () => number;
  /** Open sessions, by experiment id (at most one each). */
  private readonly sessions = new Map<string, DebriefSession>();
  /** Spectator-notice suppression, per experiment and room state. */
  private readonly noticeGates = new Map<string, { notified: Set<string>; lastAt: number }>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: HumanInteractionDeps) {
    this.repo = new InteractionRepository(deps.db);
    this.experiments = new ExperimentRepository(deps.db);
    this.events = new EventRepository(deps.db);
    this.outlet = deps.outlet ?? localRoomOutlet;
    this.now = deps.now ?? Date.now;
    deps.experiments.onRunFinished((id) => this.track(this.onRunFinished(id)));
  }

  // ---------------------------------------------------------------- inbound

  /** A new text message from a person in the experiment's room. */
  async receive(experimentId: string, input: Omit<HumanRoomMessage, "messageId" | "ts"> & { messageId?: string; ts?: string }): Promise<ReceiveResult> {
    const record = this.record(experimentId);
    const config = configOf(record);
    const message: HumanRoomMessage = {
      messageId: input.messageId ?? `human-${randomUUID()}`,
      ts: input.ts ?? new Date(this.now()).toISOString(),
      senderId: input.senderId,
      displayName: input.displayName,
      text: input.text,
      replyTo: input.replyTo ?? null,
      mentions: input.mentions ?? [],
    };
    const running = this.deps.experiments.isRunning(experimentId);
    const session = running ? undefined : this.sessions.get(experimentId);
    const disposition: Disposition = session?.isOpen ? "question" : "spectator";
    this.log(experimentId, session?.record.id ?? null, "human_message", { ...message, disposition, during: running ? "mission" : "after" });

    if (disposition === "question") {
      const result = session!.enqueue(message);
      return result.accepted
        ? { messageId: message.messageId, disposition, queued: { position: result.position }, rejected: null }
        : { messageId: message.messageId, disposition, queued: null, rejected: result.reason };
    }

    const debriefEnabled = this.debriefEnabled(record);
    const kind: NoticeKind = running ? (debriefEnabled ? "spectatorNotice" : "observeNotice") : debriefEnabled ? "debriefUnavailable" : "observeNotice";
    await this.spectatorNotice(experimentId, config, running ? "mission" : "after", kind, message);
    return { messageId: message.messageId, disposition };
  }

  /**
   * At most one notice per person per room state, and none within the
   * cooldown of the last one — which is visible to everyone in the room, so a
   * person arriving during the cooldown counts as told.
   */
  private async spectatorNotice(experimentId: string, config: ExperimentConfig, state: string, kind: NoticeKind, message: HumanRoomMessage): Promise<void> {
    const key = `${experimentId}:${state}:${kind}`;
    const gate = this.noticeGates.get(key) ?? { notified: new Set<string>(), lastAt: -Infinity };
    this.noticeGates.set(key, gate);
    if (gate.notified.has(message.senderId)) return;
    gate.notified.add(message.senderId);
    const cooldownMs = settingsOf(config).debrief.spectatorNoticeCooldownSeconds * 1000;
    if (this.now() - gate.lastAt < cooldownMs) return;
    gate.lastAt = this.now();
    await this.postNotice(experimentId, config, null, kind, { name: message.displayName }, message.messageId);
  }

  // ---------------------------------------------------------------- debrief lifecycle

  private async onRunFinished(experimentId: string): Promise<void> {
    const record = this.experiments.get(experimentId);
    if (!record || !this.debriefEnabled(record) || record.outcome === "INTERRUPTED") return;
    await this.openDebrief(experimentId, "auto");
  }

  /** Opens a new debrief session (never reopens a closed one — historical sessions are immutable). */
  async openDebrief(experimentId: string, openedBy: "auto" | "operator"): Promise<DebriefSessionRecord> {
    const record = this.record(experimentId);
    if (this.deps.experiments.isRunning(experimentId) || !record.finishedAt) throw new InteractionError("The experiment has not finished yet");
    if (record.batchId) throw new InteractionError("Batch runs have no debrief");
    const config = configOf(record);
    if (!this.debriefEnabled(record)) {
      throw new InteractionError(`Debrief is not enabled for this experiment (human interaction profile ${settingsOf(config).profile})`);
    }
    if (this.sessions.get(experimentId)?.isOpen) throw new InteractionError("A debrief session is already open");

    const created = this.repo.createSession({ id: randomUUID(), experimentId, openedBy, openedAt: new Date(this.now()).toISOString() });
    let mission: MissionRecord | null = null;
    const session = new DebriefSession(
      created,
      {
        experimentId,
        config,
        providers: this.deps.providers,
        log: (type, payload, agentId) => this.log(experimentId, created.id, type, payload, agentId ?? null),
        notice: (kind, vars, inResponseTo) => this.postNotice(experimentId, config, created.id, kind, vars ?? {}, inResponseTo ?? null),
        postAnswer: (agentId, text) => this.outlet.post(experimentId, { sender: { kind: "agent", agentId }, text }),
        // The experiment is frozen: its record is read once and never changes.
        mission: () => (mission ??= missionRecord(this.events.list(experimentId))),
        history: () => this.history(experimentId),
        authorOf: (messageId) => this.authorOf(experimentId, messageId, mission ?? (mission = missionRecord(this.events.list(experimentId)))),
        saveUsage: (usage) => this.repo.updateUsage(created.id, usage),
        markClosed: (status, reason) => this.repo.closeSession(created.id, status, reason, new Date(this.now()).toISOString()),
        now: this.now,
      },
      settingsOf(config).debrief,
      () => {
        if (this.sessions.get(experimentId) === session) this.sessions.delete(experimentId);
      }
    );
    this.sessions.set(experimentId, session);
    this.log(experimentId, created.id, "debrief_started", { sessionId: created.id, number: created.number, openedBy, outcome: record.outcome });
    await this.postNotice(experimentId, config, created.id, "debriefOpened", {}, null);
    return created;
  }

  closeDebrief(experimentId: string, reason = "operator"): DebriefSessionRecord {
    const session = this.sessions.get(experimentId);
    if (!session?.isOpen) throw new InteractionError("No debrief session is open");
    session.close(reason);
    return this.repo.getSession(session.record.id)!;
  }

  /**
   * Startup: sessions left OPEN by a stopped server are closed as
   * INTERRUPTED, and their unanswered questions marked failed. Nothing is
   * replayed; an operator can open a new session.
   */
  recoverInterrupted(): number {
    const stale = this.repo.openSessions().filter((s) => !this.sessions.has(s.experimentId));
    for (const s of stale) {
      const events = this.repo.listEvents(s.experimentId).filter((e) => e.sessionId === s.id);
      const done = new Set(events.filter((e) => e.type === "debrief_answer_published" || e.type === "debrief_question_failed").map((e) => String(e.payload.questionId)));
      const unanswered = events.filter((e) => e.type === "debrief_question_queued").map((e) => String(e.payload.questionId)).filter((id) => !done.has(id));
      for (const questionId of unanswered) this.log(s.experimentId, s.id, "debrief_question_failed", { questionId, reason: "interrupted" });
      const usage = { ...s.usage, failed: s.usage.failed + unanswered.length };
      this.repo.updateUsage(s.id, usage);
      this.repo.closeSession(s.id, "INTERRUPTED", "server restart", new Date(this.now()).toISOString());
      this.log(s.experimentId, s.id, "debrief_closed", { sessionId: s.id, reason: "server restart", status: "INTERRUPTED", droppedQuestions: unanswered, usage });
    }
    return stale.length;
  }

  /** Before an experiment is deleted: stop its open session (its rows go with the experiment). */
  forget(experimentId: string): void {
    this.sessions.get(experimentId)?.close("experiment deleted", "CLOSED", false);
    this.sessions.delete(experimentId);
    for (const key of this.noticeGates.keys()) if (key.startsWith(`${experimentId}:`)) this.noticeGates.delete(key);
  }

  /** Resolves when every pending debrief open and every queued question has been handled (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    await Promise.all([...this.sessions.values()].map((s) => s.settle()));
  }

  // ---------------------------------------------------------------- read side

  view(experimentId: string, afterSeq = 0) {
    const record = this.record(experimentId);
    const config = configOf(record);
    const all = this.repo.listEvents(experimentId);
    const running = this.deps.experiments.isRunning(experimentId);
    const session = this.sessions.get(experimentId);
    const open = !running && session?.isOpen ? session : null;
    const debriefEnabled = this.debriefEnabled(record);
    const mode: InteractionMode = running ? "mission" : open ? "debrief" : debriefEnabled ? "closed" : "observe";
    return {
      profile: settingsOf(config).profile,
      debriefEnabled,
      mode,
      session: open ? { ...this.repo.getSession(open.record.id)!, ...open.state() } : null,
      sessions: this.repo.listSessions(experimentId),
      summary: summarize(all),
      events: afterSeq ? all.filter((e) => e.seq > afterSeq) : all,
    };
  }

  // ---------------------------------------------------------------- helpers

  private record(experimentId: string): ExperimentRecord {
    const record = this.experiments.get(experimentId);
    if (!record) throw new InteractionError(`Experiment not found: ${experimentId}`, 404);
    return record;
  }

  private debriefEnabled(record: ExperimentRecord): boolean {
    return !record.batchId && settingsOf(configOf(record)).profile === "DEBRIEF";
  }

  private history(experimentId: string): DebriefExchange[] {
    return this.repo
      .listEvents(experimentId)
      .filter((e) => e.type === "debrief_answer_published")
      .map((e) => ({ askerName: String(e.payload.askerName), question: String(e.payload.question), agentId: String(e.payload.agentId), answer: String(e.payload.text) }))
      .slice(-12);
  }

  private authorOf(experimentId: string, messageId: string, mission: MissionRecord): string | null {
    const fromMission = mission.transcript.find((m) => m.id === messageId);
    if (fromMission) return fromMission.sender.kind === "agent" ? fromMission.sender.agentId : null;
    const answer = this.repo.listEvents(experimentId).find((e) => e.type === "debrief_answer_published" && e.payload.messageId === messageId);
    return answer ? String(answer.payload.agentId) : null;
  }

  private async postNotice(
    experimentId: string,
    config: ExperimentConfig,
    sessionId: string | null,
    kind: NoticeKind,
    vars: Record<string, unknown>,
    inResponseTo: string | null
  ): Promise<void> {
    const text = noticeText(config, kind, vars);
    const sender: InteractionSender = { kind: "notice", name: noticeSenderName(config) };
    const messageId = await this.outlet.post(experimentId, { sender, text });
    this.log(experimentId, sessionId, "notice_posted", { kind, text, sender, messageId, inResponseTo });
  }

  private log(experimentId: string, sessionId: string | null, type: string, payload: Record<string, unknown>, agentId: string | null = null): void {
    const serialized = redactSecrets(JSON.stringify(payload), this.deps.providers.secretValues());
    this.repo.appendEvent(experimentId, { ts: new Date(this.now()).toISOString(), sessionId, type, agentId }, serialized);
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch((err: unknown) => console.error("human interaction:", err)).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }
}

function configOf(record: ExperimentRecord): ExperimentConfig {
  try {
    return parseExperimentConfig(record.config);
  } catch {
    return record.config;
  }
}

function settingsOf(config: ExperimentConfig): HumanInteractionConfig {
  return config.humanInteraction ?? HumanInteractionConfigSchema.parse({});
}

/** Derived counts for the experiment page — never part of experiment metrics. */
function summarize(events: InteractionEvent[]) {
  const spectators = events.filter((e) => e.type === "human_message" && e.payload.disposition === "spectator");
  const duringMission = spectators.filter((e) => e.payload.during === "mission");
  return {
    spectatorMessages: spectators.length,
    spectatorMessagesDuringMission: duringMission.length,
    spectators: new Set(spectators.map((e) => e.payload.senderId)).size,
    // By construction: nothing a person writes reaches a running experiment.
    humanAssistance: false,
    questions: events.filter((e) => e.type === "human_message" && e.payload.disposition === "question").length,
    answers: events.filter((e) => e.type === "debrief_answer_published").length,
  };
}
