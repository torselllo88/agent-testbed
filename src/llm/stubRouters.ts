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

export function registerGenericStubs(stub: StubProvider): void {
  stub.register("router/next-in-order", nextInOrderRouter);
}
