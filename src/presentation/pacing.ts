import { EventType } from "../experiment/events.js";
import type { PacingConfig } from "../experiment/config.js";
import type { RunExtension, RunExtensionContext } from "../experiment/extensions.js";
import type { RoomMessage, RoomParticipant, RoomSender, Transport } from "../transport/transport.js";

/**
 * Viewer pacing as a transport decorator: before a visible message is
 * delivered to the room, hold it until the previous one has been on screen
 * for  min(maxGapMs, minVisibleIntervalMs + previousLength × perCharMs).
 * Measured from when the previous message appeared, so a slow provider reply
 * needs little or no extra wait. The wait runs on the held clock (excluded
 * from active experiment time and from provider latency), is recorded as
 * presentation_delay, and ends immediately on stop.
 *
 * The experiment runner knows nothing about this: it just publishes.
 */
export class PacedTransport implements Transport {
  private lastVisible: { at: number; length: number } | null = null;

  constructor(
    private readonly inner: Transport,
    private readonly pacing: PacingConfig,
    private readonly ctx: RunExtensionContext
  ) {}

  get kind(): string {
    return this.inner.kind;
  }

  open(room: { experimentId: string; participants: RoomParticipant[] }): Promise<void> {
    return this.inner.open(room);
  }

  history(): Promise<RoomMessage[]> {
    return this.inner.history();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async publish(message: { sender: RoomSender; text: string }): Promise<RoomMessage> {
    await this.pace(message.sender.kind);
    const published = await this.inner.publish(message);
    this.lastVisible = { at: Date.now(), length: message.text.length };
    return published;
  }

  private async pace(before: RoomSender["kind"]): Promise<void> {
    const { minVisibleIntervalMs, perCharMs, maxGapMs } = this.pacing;
    const stop = this.ctx.stopSignal;
    if (!this.lastVisible || stop.aborted) return;
    const gapMs = Math.min(maxGapMs, minVisibleIntervalMs + this.lastVisible.length * perCharMs);
    const until = this.lastVisible.at + gapMs;
    if (Date.now() >= until) return;

    const sincePreviousMs = Date.now() - this.lastVisible.at;
    const startedAt = Date.now();
    await this.ctx.holdClock(async () => {
      while (Date.now() < until && !stop.aborted) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, until - Date.now())));
      }
    });
    this.ctx.log(EventType.PRESENTATION_DELAY, { waitedMs: Date.now() - startedAt, gapMs, sincePreviousMs, before, interrupted: stop.aborted });
  }
}

/** Attaches pacing only when the run's config asks for it. */
export function pacingExtension(): RunExtension {
  return {
    name: "pacing",
    wrapTransport(transport, ctx) {
      const pacing = ctx.config.presentation.pacing;
      return pacing.minVisibleIntervalMs > 0 || pacing.perCharMs > 0 ? new PacedTransport(transport, pacing, ctx) : transport;
    },
  };
}
