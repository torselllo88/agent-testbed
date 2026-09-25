import type { TransportConfig } from "../experiment/config.js";
import { ChumsTransport } from "./chumsTransport.js";
import { LocalTransport } from "./localTransport.js";
import type { Transport } from "./transport.js";

export type { RoomMessage, RoomParticipant, RoomSender, Transport } from "./transport.js";

export function createTransport(config: TransportConfig): Transport {
  switch (config.type) {
    case "local":
      return new LocalTransport();
    case "chums":
      return new ChumsTransport({ room: config.room });
  }
}
