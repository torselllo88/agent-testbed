import type { ConsensusResult } from "../consensus/index.js";
import type { EvaluationResult } from "../evaluation/types.js";
import type { RoomMessage, RoomSender, Transport } from "../transport/transport.js";
import type { ExperimentConfig } from "./config.js";
import type { EventListener, EventType } from "./events.js";
import type { Termination } from "./outcome.js";

/**
 * The runner's only extension point for product / demo features (narration,
 * viewer pacing, ...). Extensions observe the run and may add observer-only
 * content to the room, but they never take part in experiment semantics: they
 * cannot change turns, proposals, votes, evaluation, budgets or the outcome.
 * The runner knows nothing about what an extension does — without any, it is
 * the pure experiment core.
 */

export type NarratorSender = Extract<RoomSender, { kind: "narrator" }>;

export interface RunExtensionContext {
  /** The run this context belongs to. */
  readonly experimentId: string;
  /** The run's effective configuration (read-only). */
  readonly config: Readonly<ExperimentConfig>;
  /**
   * Publishes an observer-only message to the room and records it
   * (message_posted). Narrator messages are never part of any agent's context.
   */
  post(sender: NarratorSender, text: string, meta?: Record<string, unknown>): Promise<RoomMessage>;
  /** Appends an event to the run's trace. */
  log(type: EventType, payload: Record<string, unknown>): void;
  /**
   * Runs `fn` with the experiment clock held: the time spent is excluded from
   * active experiment time (like an operator pause) and reported separately,
   * so it never consumes the time limit.
   */
  holdClock<T>(fn: () => Promise<T>): Promise<T>;
  /** Aborted when the operator stops the run — long waits should end on it. */
  readonly stopSignal: AbortSignal;
  /**
   * Observes the run's trace as it is written (read-only, synchronous). For
   * presentation that reacts to protocol state — e.g. a narration beat after
   * a rejected plan — without the runner knowing about it. Listeners must not
   * throw and must not block; act on what they see later (e.g. at the next
   * publish through a wrapped transport).
   */
  subscribe(listener: EventListener): () => void;
}

export interface RunEndedInfo {
  termination: Termination;
  /** The evaluator's result, if a proposal was committed and evaluated. */
  evaluation: EvaluationResult | null;
  evaluatorParams: unknown;
  /** The last vote's tally, if any vote took place. */
  consensus: ConsensusResult | null;
}

export interface RunExtension {
  readonly name: string;
  /** Wraps the room transport (e.g. to pace delivery for viewers). */
  wrapTransport?(transport: Transport, ctx: RunExtensionContext): Transport;
  /** After the room is open, before the first turn. */
  onRoomOpened?(ctx: RunExtensionContext): Promise<void>;
  /** After the outcome is known, before the room is closed. Failures are logged and never change the outcome. */
  onRunEnded?(ctx: RunExtensionContext, info: RunEndedInfo): Promise<void>;
}

/** Chooses the extensions for one run, from its effective config. */
export type RunExtensionFactory = (config: ExperimentConfig) => RunExtension[];
