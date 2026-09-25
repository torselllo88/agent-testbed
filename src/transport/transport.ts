/**
 * The shared room, as seen by the runtime. Agents never talk to each other
 * directly: the runtime publishes each agent's visible message through the
 * transport and builds every agent's view of the conversation from the
 * transport's history. Swapping LocalTransport for a Chums adapter must not
 * require any change to agents, scheduling, or the experiment runner.
 *
 * Only participant-visible content goes through here — internal control
 * metadata (targets, readiness, votes-in-progress) stays in the event log.
 */

export type RoomSender = { kind: "agent"; agentId: string } | { kind: "system" };

export interface RoomMessage {
  /** Transport-assigned id (opaque; a Chums message id for the Chums adapter). */
  id: string;
  /** 1-based position in the room's history. */
  index: number;
  ts: string;
  sender: RoomSender;
  text: string;
}

export interface RoomParticipant {
  agentId: string;
  displayName: string;
}

export interface Transport {
  readonly kind: string;
  open(room: { experimentId: string; participants: RoomParticipant[] }): Promise<void>;
  publish(message: { sender: RoomSender; text: string }): Promise<RoomMessage>;
  /** Full room history, oldest first. */
  history(): Promise<RoomMessage[]>;
  close(): Promise<void>;
}
