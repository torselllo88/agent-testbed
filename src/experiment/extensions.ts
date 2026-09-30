import type { ConsensusResult } from "../consensus/index.js";
import type { EvaluationResult } from "../evaluation/types.js";
import type { RoomMessage, RoomSender } from "../transport/transport.js";
import type { ExperimentConfig } from "./config.js";
import type { EventListener, EventType } from "./events.js";
import type { Termination } from "./outcome.js";

/**
 * The runner's only extension point for product / demo features (narration,
 * viewer pacing, external room projection, ...). Extensions observe the run
 * and may add observer-only content to the room, but they never take part in
 * experiment semantics: they cannot change turns, proposals, votes,
 * evaluation, budgets or the outcome — and they cannot change what agents
 * read, because they never get hold of the room itself. They see each
 * message only as a frozen copy, around the moment it is published.
 * Without any extension the runner is the pure experiment core.
 */

export type NarratorSender = Extract<RoomSender, { kind: "narrator" }>;

/**
 * Per-run settings for add-ons, independent of the experiment config (so
 * they never change configHash). Generic by design:
 *   headless  nobody watches this run live (batch, CLI) — e.g. viewer pacing
 *             and reveal pauses are skipped; what is posted stays the same.
 */
export interface RunExtensionOptions {
  readonly headless: boolean;
}

export interface RunExtensionContext {
  /** The run this context belongs to. */
  readonly experimentId: string;
  /** The run's effective configuration (read-only). */
  readonly config: Readonly<ExperimentConfig>;
  /** How the run was started, for its add-ons. */
  readonly options: RunExtensionOptions;
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
   * a rejected plan — without the runner knowing about it. A listener that
   * throws is isolated (reported), never propagated into the run.
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

/** A room message as extensions see it: a frozen copy, never the room itself. */
export type PublishedMessage = Readonly<{ sender: Readonly<RoomSender>; text: string }>;

export interface RunExtension {
  readonly name: string;
  /** Once, when the run is set up — before anything is published. */
  attach?(ctx: RunExtensionContext): void;
  /**
   * Before a message is delivered to the room. May wait (on the held clock,
   * e.g. viewer pacing) or first post observer-only messages of its own
   * (e.g. a narration beat). It cannot change the message.
   */
  beforePublish?(message: PublishedMessage, ctx: RunExtensionContext): Promise<void>;
  /** After a message has been delivered. */
  afterPublish?(message: Readonly<RoomMessage>, ctx: RunExtensionContext): void;
  /** After the room is open, before the first turn. */
  onRoomOpened?(ctx: RunExtensionContext): Promise<void>;
  /** After the outcome is known, before the room is closed. Failures are logged and never change the outcome. */
  onRunEnded?(ctx: RunExtensionContext, info: RunEndedInfo): Promise<void>;
}

/** Chooses the extensions for one run, from its effective config and add-on options. */
export type RunExtensionFactory = (config: ExperimentConfig, options: RunExtensionOptions) => RunExtension[];
