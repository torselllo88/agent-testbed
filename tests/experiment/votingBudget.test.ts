import { describe, expect, it } from "vitest";
import type { LlmProvider } from "../../src/llm/provider.js";
import { createHarness, ofType, script, testConfig } from "../helpers/harness.js";

describe("budget at the end of voting", () => {
  for (const approve of [true, false]) {
    for (const limit of ["totalTokenCap", "agentTokenLimit", "totalCostCapUsd"] as const) {
      it(`${limit} takes precedence over ${approve ? "commit" : "final consensus failure"}`, async () => {
        const respond = script({ vote: () => JSON.stringify({ vote: approve ? "APPROVE" : "REJECT", reason: "test" }) });
        const provider: LlmProvider = {
          id: "openrouter",
          async complete(req) {
            const voting = req.context?.purpose === "vote";
            return { text: respond(req), requestedModel: req.model, servedModel: req.model,
              usage: { promptTokens: voting ? 100 : 1, completionTokens: 0 }, reportedCostUsd: voting ? 1 : 0 };
          },
        };
        const h = createHarness({ providers: [provider], extensions: null });
        try {
          const config = testConfig((c) => {
            c.scheduler = { type: "round_robin" };
            for (const a of c.agents) a.model = { provider: "openrouter", model: "test", structuredOutput: "native" };
            c.decision.maxProposalAttempts = 1;
            c.limits[limit] = limit === "totalCostCapUsd" ? 0.5 : 10;
          });
          const runner = h.runner(config);
          const metrics = await runner.run();
          const events = h.events(runner.id);
          expect(metrics.termination?.outcome).toBe(limit === "totalCostCapUsd" ? "COST_LIMIT_EXCEEDED" : "TOKEN_BUDGET_EXCEEDED");
          expect(metrics.termination?.detail).toMatchObject({ limit, overshoot: expect.any(Number) });
          expect(ofType(events, "vote_cast")).toHaveLength(config.agents.length);
          expect(ofType(events, "consensus_result")).toHaveLength(1);
          expect(ofType(events, "evaluation_result")).toHaveLength(0);
          expect(ofType(events, "phase_changed").some(e => e.payload.to === "COMMITTED")).toBe(false);
          expect(metrics.tokens.total).toBe(405);
          expect(metrics.costUsd.total).toBe(4);
        } finally { h.db.close(); }
      });
    }
  }
});
