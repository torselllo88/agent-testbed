import type { RoomMessage, RoomParticipant, RoomSender, Transport } from "./transport.js";

/** In-process room: the whole experiment runs locally, with no external chat service. */
export class LocalTransport implements Transport {
  readonly kind = "local";
  private messages: RoomMessage[] = [];
  private participants: RoomParticipant[] = [];
  private isOpen = false;

  async open(room: { experimentId: string; participants: RoomParticipant[] }): Promise<void> {
    this.messages = [];
    this.participants = room.participants;
    this.isOpen = true;
  }

  async publish(message: { sender: RoomSender; text: string }): Promise<RoomMessage> {
    if (!this.isOpen) throw new Error("LocalTransport: room is not open");
    if (message.sender.kind === "agent") {
      const agentId = message.sender.agentId;
      if (!this.participants.some((p) => p.agentId === agentId)) {
        throw new Error(`LocalTransport: "${agentId}" is not a participant of this room`);
      }
    }
    const index = this.messages.length + 1;
    const stored: RoomMessage = { id: `local-${index}`, index, ts: new Date().toISOString(), ...message };
    this.messages.push(stored);
    return stored;
  }

  async history(): Promise<RoomMessage[]> {
    return [...this.messages];
  }

  async close(): Promise<void> {
    this.isOpen = false;
  }
}
