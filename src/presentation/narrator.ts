import { EventType, type ExperimentEvent } from "../experiment/events.js";
import type { RunExtension, RunExtensionContext } from "../experiment/extensions.js";
import type { RoomMessage, RoomParticipant, RoomSender, Transport } from "../transport/transport.js";
import { beatNarration, endingNarration, narratorName, openingNarration, type Narration } from "./narration.js";

/**
 * The scenario narrator as a run extension, all of it observer-only and
 * rendered deterministically from authored strings and the run's actual state:
 *   - the opening, once the room is open;
 *   - beats during the run (presentation.beats), reacting to protocol state it
 *     observes in the trace — shown just before the next visible message, so
 *     they never interrupt or reorder the conversation;
 *   - the ending once the outcome is known, revealed part by part when the
 *     authored text is a sequence.
 * Agents never see any of it.
 */
export function narratorExtension(): RunExtension {
  let beats: BeatTracker | null = null;
  return {
    name: "narrator",
    wrapTransport(transport, ctx) {
      const configured = ctx.config.presentation.beats ?? [];
      if (!ctx.config.presentation.narrator || configured.length === 0) return transport;
      beats = new BeatTracker(ctx);
      ctx.subscribe((event) => beats!.observe(event));
      return new BeatTransport(transport, beats);
    },
    async onRoomOpened(ctx) {
      await post(ctx, openingNarration(ctx.config, ctx.config.conversation.language));
    },
    async onRunEnded(ctx, { termination, evaluation, evaluatorParams, consensus }) {
      beats?.discard(); // the ending supersedes anything not yet shown
      await post(ctx, endingNarration(ctx.config, ctx.config.conversation.language, termination, evaluation, evaluatorParams, consensus));
    },
  };
}

async function post(ctx: RunExtensionContext, narration: Narration | null): Promise<void> {
  const name = narratorName(ctx.config, ctx.config.conversation.language);
  if (!narration || !name) return;
  const pauseMs = ctx.config.presentation.pacing.sequencePauseMs ?? 0;
  for (const [i, part] of narration.parts.entries()) {
    if (i > 0 && pauseMs > 0) await hold(ctx, pauseMs);
    await ctx.post({ kind: "narrator", name }, part, {
      narration: {
        source: narration.source,
        language: narration.language,
        missing: narration.missing,
        ...(narration.parts.length > 1 ? { part: i + 1, of: narration.parts.length } : {}),
      },
    });
  }
}

/** A presentation pause on the held clock (excluded from experiment time), cut short by stop. */
async function hold(ctx: RunExtensionContext, ms: number): Promise<void> {
  const stop = ctx.stopSignal;
  if (stop.aborted) return;
  const until = Date.now() + ms;
  await ctx.holdClock(async () => {
    while (Date.now() < until && !stop.aborted) await new Promise((r) => setTimeout(r, Math.min(100, until - Date.now())));
  });
}

/** Which beats are due, from the protocol state visible in the trace. */
class BeatTracker {
  private roundTurns = 0;
  private roundLimit = 0;
  private readonly fired = new Set<string>();
  private pending: string[] = [];

  constructor(private readonly ctx: RunExtensionContext) {}

  observe(event: ExperimentEvent): void {
    const beats = this.ctx.config.presentation.beats ?? [];
    const p = event.payload;
    if (event.type === EventType.PHASE_CHANGED && p.to === "DISCUSSION") {
      this.roundTurns = 0;
      this.roundLimit = Number(p.turnLimit) || 0;
    } else if (event.type === EventType.TURN_COMPLETED && p.kind === "discussion") {
      this.roundTurns += 1;
      for (const beat of beats) {
        if (!("discussionProgress" in beat.when) || this.fired.has(beat.id) || this.roundLimit === 0) continue;
        if (this.roundTurns / this.roundLimit >= beat.when.discussionProgress) {
          this.fired.add(beat.id);
          this.pending.push(beat.id);
        }
      }
    } else if (event.type === EventType.MESSAGE_POSTED && (p.notice as { kind?: string } | undefined)?.kind === "proposal_not_approved") {
      // Keyed to the moderator's "not approved" notice (not the tally), so the beat follows it in the room.
      for (const beat of beats) if ("planRejected" in beat.when) this.pending.push(beat.id);
    }
  }

  take(): string[] {
    const due = this.pending;
    this.pending = [];
    return due;
  }

  discard(): void {
    this.pending = [];
  }

  async flush(): Promise<void> {
    for (const id of this.take()) await post(this.ctx, beatNarration(this.ctx.config, this.ctx.config.conversation.language, id));
  }
}

/** Shows due beats just before the next visible (non-narrator) message. */
class BeatTransport implements Transport {
  constructor(
    private readonly inner: Transport,
    private readonly beats: BeatTracker
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
    // Beats are posted through the run (ctx.post → this transport again, as narrator), so they are paced and recorded like any narration.
    if (message.sender.kind !== "narrator") await this.beats.flush();
    return this.inner.publish(message);
  }
}
