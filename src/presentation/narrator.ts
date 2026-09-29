import type { RunExtension, RunExtensionContext } from "../experiment/extensions.js";
import { endingNarration, narratorName, openingNarration, type Narration } from "./narration.js";

/**
 * The scenario narrator as a run extension: posts the opening once the room
 * is open, and the ending once the outcome is known — both rendered
 * deterministically from authored strings and the run's actual state.
 * Narrator messages are observer-only; agents never see them.
 */
export function narratorExtension(): RunExtension {
  return {
    name: "narrator",
    async onRoomOpened(ctx) {
      await post(ctx, openingNarration(ctx.config, ctx.config.conversation.language));
    },
    async onRunEnded(ctx, { termination, evaluation, evaluatorParams }) {
      await post(ctx, endingNarration(ctx.config, ctx.config.conversation.language, termination, evaluation, evaluatorParams));
    },
  };
}

async function post(ctx: RunExtensionContext, narration: Narration | null): Promise<void> {
  const name = narratorName(ctx.config, ctx.config.conversation.language);
  if (!narration || !name) return;
  await ctx.post({ kind: "narrator", name }, narration.text, {
    narration: { source: narration.source, language: narration.language, missing: narration.missing },
  });
}
