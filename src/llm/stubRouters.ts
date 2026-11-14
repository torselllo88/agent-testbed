import type { CompletionRequest } from "./provider.js";
import type { StubProvider } from "./stubProvider.js";

/**
 * Scenario-neutral stub router, registered for every deployment: a
 * deterministic stand-in for an LLM classifier. Scenario-specific stub
 * routers live with their scenario (src/scenarios/<scenario>/stubScripts.ts).
 *
 *   turn routing    the next candidate after the last speaker, in config order
 *   debrief routing never confident (the debrief then uses its default character)
 */
export function nextInOrderRouter(request: CompletionRequest): string {
  const ctx = request.context ?? {};
  if (ctx.purpose === "debrief_router") return JSON.stringify({ agentId: null, confident: false, reason: "stub router: no content understanding" });
  const order = (ctx.order as string[] | undefined) ?? [];
  const candidates = (ctx.candidates as string[] | undefined) ?? [];
  const last = ctx.lastSpeakerId as string | null;
  const start = last ? order.indexOf(last) : -1;
  for (let i = 1; i <= order.length; i++) {
    const id = order[(start + i) % order.length]!;
    if (candidates.includes(id)) return JSON.stringify({ nextAgentId: id, reason: `next after ${last ?? "start"} in room order` });
  }
  return JSON.stringify({ nextAgentId: candidates[0] ?? "", reason: "first candidate" });
}

/**
 * A crude, deterministic stand-in for the exposure detector — for trying the
 * labeling pipeline without a model, never for measuring: a proposition counts
 * as "correct" in a message that contains every id and number it names
 * (ACC-7720, RAIL-Y, 12,000, …), else "absent". It never says "incorrect".
 */
export function keywordExposureDetector(request: CompletionRequest): string {
  const ctx = request.context ?? {};
  const text = String(ctx.messageText ?? "");
  const facts = (ctx.facts as Array<{ id: string; statement: string }> | undefined) ?? [];
  const tokens = (statement: string) => statement.match(/\b(?:[A-Z][A-Z0-9]*-[A-Z0-9]+|\d{1,3}(?:,\d{3})+)\b/g) ?? [];
  const labels = Object.fromEntries(
    facts.map((f) => {
      const needed = tokens(f.statement);
      const hit = needed.length > 0 && needed.every((t) => text.includes(t));
      return [f.id, hit ? { label: "correct", evidence: needed.join(", ") } : { label: "absent", evidence: null }];
    })
  );
  return JSON.stringify({ labels });
}

export function registerGenericStubs(stub: StubProvider): void {
  stub.register("router/next-in-order", nextInOrderRouter);
  stub.register("detector/keywords", keywordExposureDetector);
}
