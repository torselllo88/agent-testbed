import type { TransportConfig } from "../experiment/config.js";
import { LocalTransport } from "./localTransport.js";
import type { Transport } from "./transport.js";

export { agentVisible, type RoomMessage, type RoomParticipant, type RoomSender, type Transport } from "./transport.js";

/**
 * The experiment's own room. It is the medium of agent coordination and stays
 * inside the testbed; an external chat room (e.g. Matrix) is a projection of
 * it (see src/rooms), not a transport.
 */
export function createTransport(config: TransportConfig): Transport {
  switch (config.type) {
    case "local":
      return new LocalTransport();
  }
}
