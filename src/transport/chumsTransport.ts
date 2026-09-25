import type { RoomMessage, RoomParticipant, RoomSender, Transport } from "./transport.js";

/**
 * Extension point for running an experiment's room on Chums Chat.
 *
 * Not implemented yet — no API/protocol details are available. An adapter
 * needs to: create or join a room for the experiment (open), post a message
 * on behalf of an agent or the system moderator (publish), and return the
 * room history in order (history). Nothing outside this file should need to
 * change: the runner only ever talks to the Transport interface.
 */
export class ChumsTransport implements Transport {
  readonly kind = "chums";

  constructor(private readonly options: { room?: string } = {}) {}

  async open(_room: { experimentId: string; participants: RoomParticipant[] }): Promise<void> {
    throw new Error(
      `Chums transport is not implemented yet${this.options.room ? ` (room "${this.options.room}")` : ""} — use { "type": "local" }`
    );
  }

  async publish(_message: { sender: RoomSender; text: string }): Promise<RoomMessage> {
    throw new Error("Chums transport is not implemented yet");
  }

  async history(): Promise<RoomMessage[]> {
    throw new Error("Chums transport is not implemented yet");
  }

  async close(): Promise<void> {}
}
