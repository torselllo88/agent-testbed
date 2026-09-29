/**
 * A new text message a person typed into an experiment's room, as a room
 * adapter delivers it (the local viewer over HTTP today; Chums later).
 *
 * Deliberately not part of Transport: the experiment runner never receives
 * human messages. Adapters hand them to the human-interaction layer
 * (src/interaction), which decides what they mean — spectator chat during a
 * run, a debrief question afterwards. Only new text messages are delivered;
 * edits, redactions, reactions and attachments stay at the adapter / UI level.
 */
export interface HumanRoomMessage {
  /** Adapter-assigned id (a Chums event id for Chums); generated when the source has none. */
  messageId: string;
  /** Stable per-person id from the source; never shown to agents. */
  senderId: string;
  displayName: string;
  ts: string;
  text: string;
  /** Id of the room message this one replies to, if the source supports replies. */
  replyTo: string | null;
  /** Explicit mentions (agent ids or display names), if the source supports them. */
  mentions: string[];
}
