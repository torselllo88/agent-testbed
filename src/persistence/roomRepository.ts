import type { Db } from "./db.js";

export interface RoomParticipantBinding {
  participantId: string;
  externalUserId: string;
}

export interface RoomBindingRecord {
  id: string;
  experimentId: string;
  provider: string;
  roomId: string;
  participants: RoomParticipantBinding[];
  createdAt: string;
  closedAt: string | null;
}

export interface OutboxEvent {
  seq: number;
  messageId: string;
  type: string;
  payload: Record<string, unknown>;
  internalMessageId: string | null;
  createdAt: string;
  ackedAt: string | null;
  externalEventId: string | null;
}

interface BindingRow {
  id: string;
  experiment_id: string;
  provider: string;
  room_id: string;
  participants_json: string;
  created_at: string;
  closed_at: string | null;
}

interface OutboxRow {
  seq: number;
  message_id: string;
  type: string;
  payload_json: string;
  internal_message_id: string | null;
  created_at: string;
  acked_at: string | null;
  external_event_id: string | null;
}

const toBinding = (r: BindingRow): RoomBindingRecord => ({
  id: r.id,
  experimentId: r.experiment_id,
  provider: r.provider,
  roomId: r.room_id,
  participants: JSON.parse(r.participants_json) as RoomParticipantBinding[],
  createdAt: r.created_at,
  closedAt: r.closed_at,
});

const toOutbox = (r: OutboxRow): OutboxEvent => ({
  seq: r.seq,
  messageId: r.message_id,
  type: r.type,
  payload: JSON.parse(r.payload_json) as Record<string, unknown>,
  internalMessageId: r.internal_message_id,
  createdAt: r.created_at,
  ackedAt: r.acked_at,
  externalEventId: r.external_event_id,
});

const OUTBOX_COLUMNS = "seq, message_id, type, payload_json, internal_message_id, created_at, acked_at, external_event_id";

/** External room bindings, their outbox and their inbound deduplication record. */
export class RoomRepository {
  constructor(private readonly db: Db) {}

  /** Created before the run starts (see ExternalRoomService.start), so it can reference an experiment id that does not exist yet. */
  createBindingForStart(b: Omit<RoomBindingRecord, "closedAt">): RoomBindingRecord {
    this.db
      .prepare(`INSERT INTO room_bindings (id, experiment_id, provider, room_id, participants_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(b.id, b.experimentId, b.provider, b.roomId, JSON.stringify(b.participants), b.createdAt);
    return this.getBinding(b.id)!;
  }

  /** Removes a binding and (by cascade) its outbox and inbound record — a start that failed, or a deleted experiment. */
  discardBinding(id: string): void {
    this.db.prepare(`DELETE FROM room_bindings WHERE id = ?`).run(id);
  }

  getBinding(id: string): RoomBindingRecord | null {
    const row = this.db.prepare(`SELECT * FROM room_bindings WHERE id = ?`).get(id) as BindingRow | undefined;
    return row ? toBinding(row) : null;
  }

  bindingForExperiment(experimentId: string): RoomBindingRecord | null {
    const row = this.db.prepare(`SELECT * FROM room_bindings WHERE experiment_id = ?`).get(experimentId) as BindingRow | undefined;
    return row ? toBinding(row) : null;
  }

  bindingsForRoom(provider: string, roomId: string): RoomBindingRecord[] {
    const rows = this.db.prepare(`SELECT * FROM room_bindings WHERE provider = ? AND room_id = ? ORDER BY created_at`).all(provider, roomId) as unknown as BindingRow[];
    return rows.map(toBinding);
  }

  closeBinding(id: string, closedAt: string): void {
    this.db.prepare(`UPDATE room_bindings SET closed_at = ? WHERE id = ? AND closed_at IS NULL`).run(closedAt, id);
  }

  appendOutbox(bindingId: string, e: { messageId: string; type: string; payload: Record<string, unknown>; internalMessageId: string | null; createdAt: string }): OutboxEvent {
    const row = this.db.prepare(`SELECT MAX(seq) AS s FROM room_outbox WHERE binding_id = ?`).get(bindingId) as { s: number | null };
    const seq = (row.s ?? 0) + 1;
    this.db
      .prepare(`INSERT INTO room_outbox (binding_id, seq, message_id, type, payload_json, internal_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(bindingId, seq, e.messageId, e.type, JSON.stringify(e.payload), e.internalMessageId, e.createdAt);
    return { seq, ...e, ackedAt: null, externalEventId: null };
  }

  listOutbox(bindingId: string, afterSeq: number, limit: number): OutboxEvent[] {
    const rows = this.db
      .prepare(`SELECT ${OUTBOX_COLUMNS} FROM room_outbox WHERE binding_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(bindingId, afterSeq, limit) as unknown as OutboxRow[];
    return rows.map(toOutbox);
  }

  outboxByMessageId(bindingId: string, messageId: string): OutboxEvent | null {
    const row = this.db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM room_outbox WHERE binding_id = ? AND message_id = ?`).get(bindingId, messageId) as OutboxRow | undefined;
    return row ? toOutbox(row) : null;
  }

  outboxByExternalEventId(bindingId: string, externalEventId: string): OutboxEvent | null {
    const row = this.db
      .prepare(`SELECT ${OUTBOX_COLUMNS} FROM room_outbox WHERE binding_id = ? AND external_event_id = ?`)
      .get(bindingId, externalEventId) as OutboxRow | undefined;
    return row ? toOutbox(row) : null;
  }

  outboxByInternalId(bindingId: string, internalMessageId: string): OutboxEvent | null {
    const row = this.db
      .prepare(`SELECT ${OUTBOX_COLUMNS} FROM room_outbox WHERE binding_id = ? AND internal_message_id = ?`)
      .get(bindingId, internalMessageId) as OutboxRow | undefined;
    return row ? toOutbox(row) : null;
  }

  ack(bindingId: string, messageId: string, externalEventId: string | null, ackedAt: string): void {
    this.db
      .prepare(`UPDATE room_outbox SET acked_at = ?, external_event_id = ? WHERE binding_id = ? AND message_id = ? AND acked_at IS NULL`)
      .run(ackedAt, externalEventId, bindingId, messageId);
  }

  /** Delivery progress: the highest seq, the contiguous acknowledged prefix, and what is still unacknowledged. */
  deliveryState(bindingId: string): { lastSeq: number; ackedThroughSeq: number; unacked: Array<{ seq: number; messageId: string }> } {
    const last = this.db.prepare(`SELECT MAX(seq) AS s FROM room_outbox WHERE binding_id = ?`).get(bindingId) as { s: number | null };
    const unacked = this.db
      .prepare(`SELECT seq, message_id FROM room_outbox WHERE binding_id = ? AND acked_at IS NULL ORDER BY seq`)
      .all(bindingId) as Array<{ seq: number; message_id: string }>;
    const lastSeq = last.s ?? 0;
    return {
      lastSeq,
      ackedThroughSeq: unacked.length ? unacked[0]!.seq - 1 : lastSeq,
      unacked: unacked.map((u) => ({ seq: u.seq, messageId: u.message_id })),
    };
  }

  inbound(bindingId: string, externalEventId: string): { internalMessageId: string | null; result: Record<string, unknown> } | null {
    const row = this.db
      .prepare(`SELECT internal_message_id, result_json FROM room_inbound WHERE binding_id = ? AND external_event_id = ?`)
      .get(bindingId, externalEventId) as { internal_message_id: string | null; result_json: string } | undefined;
    return row ? { internalMessageId: row.internal_message_id, result: JSON.parse(row.result_json) as Record<string, unknown> } : null;
  }

  inboundByInternalId(bindingId: string, internalMessageId: string): { externalEventId: string } | null {
    const row = this.db
      .prepare(`SELECT external_event_id FROM room_inbound WHERE binding_id = ? AND internal_message_id = ?`)
      .get(bindingId, internalMessageId) as { external_event_id: string } | undefined;
    return row ? { externalEventId: row.external_event_id } : null;
  }

  updateInboundResult(bindingId: string, externalEventId: string, result: Record<string, unknown>): void {
    this.db.prepare(`UPDATE room_inbound SET result_json = ? WHERE binding_id = ? AND external_event_id = ?`).run(JSON.stringify(result), bindingId, externalEventId);
  }

  /** Synchronous insert under the primary key: the first caller wins, so a concurrent retry sees the reservation. */
  recordInbound(bindingId: string, externalEventId: string, internalMessageId: string | null, result: Record<string, unknown>, receivedAt: string): void {
    this.db
      .prepare(`INSERT INTO room_inbound (binding_id, external_event_id, internal_message_id, received_at, result_json) VALUES (?, ?, ?, ?, ?)`)
      .run(bindingId, externalEventId, internalMessageId, receivedAt, JSON.stringify(result));
  }
}
