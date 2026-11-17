import type { CompletionRequest } from "../../llm/provider.js";
import type { StubProvider } from "../../llm/stubProvider.js";

/**
 * Scripted stand-ins for the pilot protocol.
 *
 * - probe (Plan §7.3, gate G1): a discussion reply is "PROBE " + the sorted
 *   set of tokens "<Role>-TOKEN" the agent holds — its own token if it is a
 *   data role, plus every token in its user text. Tests recipients, ordering,
 *   history assembly and immediate delivery together; the bundle's
 *   validate_run_log.simulate_probe gives the exact expected texts. The final
 *   call answers a fixed, schema-valid proposal (not compared).
 * - canonical: every discussion turn restates the agent's own role card; the
 *   final call answers the canonical outcome read from the user text's role
 *   cards is impossible for a stub — it answers a fixed proposal instead.
 */
export function probeScript(request: CompletionRequest): string {
  const ctx = request.context ?? {};
  if (ctx.purpose === "proposal") return '{"action": "reject", "destination": null, "rail": null, "reason": "NO_ROUTE"}';
  const user = request.messages.find((m) => m.role === "user")?.content ?? "";
  const tokens = new Set(user.match(/[A-Z][a-z]+-TOKEN/g) ?? []);
  const speaker = String(ctx.speaker ?? "");
  if (speaker && speaker !== "Operations") tokens.add(`${speaker}-TOKEN`);
  return tokens.size ? `PROBE ${[...tokens].sort().join(" ")}` : "PROBE";
}

export function registerPilotSettlementStubs(stub: StubProvider): void {
  stub.register("pilot-settlement/probe", probeScript);
}
