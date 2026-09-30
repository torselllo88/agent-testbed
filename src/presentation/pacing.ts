import { EventType } from "../experiment/events.js";
import type { PacingConfig } from "../experiment/config.js";
import type { RunExtension, RunExtensionContext } from "../experiment/extensions.js";
import type { RoomSender } from "../transport/transport.js";

/**
 * Viewer pacing: before a visible message is delivered, hold it until the
 * previous one has been on screen for
 *   min(maxGapMs, minVisibleIntervalMs + previousLength × perCharMs).
 * Measured from when the previous message appeared, so a slow provider reply
 * needs little or no extra wait. The wait runs on the held clock (excluded
 * from active experiment time and from provider latency), is recorded as
 * presentation_delay, and ends immediately on stop.
 *
 * Headless runs (batch, CLI) are not paced — nobody is watching. The runner
 * knows nothing about any of this: it just publishes.
 */
export function pacingEnabled(pacing: PacingConfig, headless: boolean): boolean {
  return !headless && (pacing.minVisibleIntervalMs > 0 || pacing.perCharMs > 0);
}

export function pacingExtension(): RunExtension {
  let lastVisible: { at: number; length: number } | null = null;
  let enabled = false;

  async function pace(ctx: RunExtensionContext, before: RoomSender["kind"]): Promise<void> {
    const { minVisibleIntervalMs, perCharMs, maxGapMs } = ctx.config.presentation.pacing;
    const stop = ctx.stopSignal;
    if (!lastVisible || stop.aborted) return;
    const gapMs = Math.min(maxGapMs, minVisibleIntervalMs + lastVisible.length * perCharMs);
    const until = lastVisible.at + gapMs;
    if (Date.now() >= until) return;

    const sincePreviousMs = Date.now() - lastVisible.at;
    const startedAt = Date.now();
    await ctx.holdClock(async () => {
      while (Date.now() < until && !stop.aborted) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, until - Date.now())));
      }
    });
    ctx.log(EventType.PRESENTATION_DELAY, { waitedMs: Date.now() - startedAt, gapMs, sincePreviousMs, before, interrupted: stop.aborted });
  }

  return {
    name: "pacing",
    attach(ctx) {
      const pacing = ctx.config.presentation.pacing;
      enabled = pacingEnabled(pacing, ctx.options.headless);
      // The scenario defines pacing but this run skips it: say so in the trace.
      if (!enabled && pacingEnabled(pacing, false)) ctx.log(EventType.EXTENSION_NOTE, { extension: "pacing", pacing: "off", reason: "headless" });
    },
    async beforePublish(message, ctx) {
      if (enabled) await pace(ctx, message.sender.kind);
    },
    afterPublish(message) {
      if (enabled) lastVisible = { at: Date.now(), length: message.text.length };
    },
  };
}
