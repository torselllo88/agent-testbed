import type { EventRepository } from "../persistence/eventRepository.js";
import type { Phase } from "./phases.js";
import { deepFreeze, type DeepReadonly } from "./immutable.js";

/**
 * Every event type the runtime emits. The log is append-only and is the
 * single source of truth for a run: metrics, the results view and exports
 * are all derived from it.
 */
export const EventType = {
  EXPERIMENT_STARTED: "experiment_started",
  PHASE_CHANGED: "phase_changed",
  TURN_STARTED: "turn_started",
  TURN_COMPLETED: "turn_completed",
  /** Every provider call, including parse retries and failed attempts, with the full rendered prompt. */
  LLM_CALL: "llm_call",
  /** A public room message (agent, moderator notice, or narration) — the participant-facing conversation. */
  MESSAGE_POSTED: "message_posted",
  /** Viewer pacing wait before a visible message — excluded from provider latency and active experiment time. */
  PRESENTATION_DELAY: "presentation_delay",
  /** Something an add-on wants on record about how it treated this run (e.g. pacing skipped for a headless run). */
  EXTENSION_NOTE: "extension_note",
  /** An add-on (extension) failed. The run goes on unchanged; counted apart from the experiment's own errors. */
  EXTENSION_ERROR: "extension_error",
  /** An agent's internal control metadata for a turn (target, intent, pass, readiness) — never shown in the room. */
  AGENT_META: "agent_meta",
  ROUTING_DECISION: "routing_decision",
  READINESS_CHANGED: "readiness_changed",
  READINESS_INVALIDATED: "readiness_invalidated",
  PROPOSAL_REQUESTED: "proposal_requested",
  /** The proposer's output failed to parse or failed the scenario's proposal schema. */
  PROPOSAL_REJECTED_FORMAT: "proposal_rejected_format",
  PROPOSAL_DECLINED: "proposal_declined",
  /** The immutable proposal artifact every voter votes on. */
  PROPOSAL_FROZEN: "proposal_frozen",
  VOTE_CAST: "vote_cast",
  CONSENSUS_RESULT: "consensus_result",
  EVALUATION_RESULT: "evaluation_result",
  OPERATOR_INTERVENTION: "operator_intervention",
  /** A recoverable protocol problem (unparseable turn, invalid vote, router failure, ...). */
  PROTOCOL_INCIDENT: "protocol_incident",
  ERROR: "error",
  EXPERIMENT_FINISHED: "experiment_finished",
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

export interface ExperimentEvent {
  seq: number;
  ts: string;
  phase: Phase | null;
  type: EventType;
  agentId: string | null;
  payload: Record<string, unknown>;
}

export type EventListener = (event: DeepReadonly<ExperimentEvent>) => void;

export const REDACTED = "[REDACTED]";

/** Replaces every occurrence of a known credential anywhere in a JSON-serialized payload. */
export function redactSecrets(serialized: string, secrets: readonly string[]): string {
  let out = serialized;
  for (const secret of secrets) {
    const escaped = JSON.stringify(secret).slice(1, -1); // as it appears inside a JSON string
    out = out.split(escaped).join(REDACTED);
  }
  return out;
}

/**
 * Appends events for one experiment, writing each to SQLite immediately (not
 * buffered) so a live view can follow the run and a crash loses nothing
 * already emitted. Payloads are scrubbed of configured credentials before
 * they are persisted or handed to listeners.
 */
export class EventLog {
  private seq = 0;
  private readonly listeners = new Set<EventListener>();
  private pending: ExperimentEvent[] | null = null;

  constructor(
    private readonly experimentId: string,
    private readonly repo: EventRepository,
    private readonly secrets: readonly string[],
    private readonly currentPhase: () => Phase | null
  ) {}

  append(type: EventType, payload: Record<string, unknown> = {}, agentId: string | null = null): ExperimentEvent {
    const serialized = redactSecrets(JSON.stringify(payload), this.secrets);
    const event: ExperimentEvent = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      phase: this.currentPhase(),
      type,
      agentId,
      payload: JSON.parse(serialized) as Record<string, unknown>,
    };
    this.repo.insert(this.experimentId, event, serialized);
    deepFreeze(event);
    if (this.pending) this.pending.push(event);
    else this.notify(event);
    return event;
  }

  /** Persist events and their terminal row together; observers only see committed data. */
  atomic<T>(fn: () => T): T {
    if (this.pending) throw new Error("Nested event transactions are not supported");
    const previousSeq = this.seq;
    const events: ExperimentEvent[] = [];
    this.pending = events;
    let result: T;
    try {
      result = this.repo.transaction(fn);
    } catch (err) {
      this.seq = previousSeq;
      throw err;
    } finally {
      this.pending = null;
    }
    for (const event of events) this.notify(event);
    return result;
  }

  private notify(event: ExperimentEvent): void {
    // A listener (an add-on observing the run) that throws must never break the run or its bookkeeping.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error(`event listener failed on ${event.type} (experiment ${this.experimentId}):`, err);
      }
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
