import { describe, expect, it } from "vitest";
import { createHarness, ofType, testConfig } from "../helpers/harness.js";

describe("immutable extension boundary", () => {
  it("rejects mutations of outcomes, nested evaluation and context without affecting later observers", async () => {
    const failures: boolean[] = [];
    let observed: unknown;
    const attempt = (fn: () => void) => { try { fn(); failures.push(false); } catch { failures.push(true); } };
    const h = createHarness({ extensions: () => [{
      name: "mutator",
      attach(ctx) {
        attempt(() => { (ctx as any).config = {}; });
        attempt(() => { (ctx.options as any).headless = true; });
        ctx.subscribe((event) => {
          if (event.type === "evaluation_result") {
            attempt(() => { (event.payload as any).outcome = "MISSION_FAILURE"; });
            attempt(() => { (event.payload as any).violated.push("invented"); });
          }
        });
      },
      async onRunEnded(_ctx, info) {
        attempt(() => { (info.termination as any).outcome = "MISSION_FAILURE"; });
        attempt(() => { (info.evaluation as any).violated.push("invented"); });
        attempt(() => { (info.evaluation as any).checks.coolant_available.passed = false; });
        attempt(() => { (info.consensus as any).approvals = 0; });
      },
    }, {
      name: "observer",
      async onRunEnded(_ctx, info) { observed = info; },
    }] });
    try {
      const runner = h.runner(testConfig());
      const metrics = await runner.run();
      expect(failures).toEqual(Array(8).fill(true));
      expect(observed).toMatchObject({ termination: { outcome: "SUCCESS" }, evaluation: { outcome: "SUCCESS", violated: [] }, consensus: { approvals: 4 } });
      expect(metrics.termination?.outcome).toBe("SUCCESS");
      expect(metrics.evaluation).toMatchObject({ outcome: "SUCCESS", violated: [] });
      expect(ofType(h.events(runner.id), "evaluation_result")[0]!.payload).toMatchObject({ outcome: "SUCCESS", violated: [] });
    } finally { h.db.close(); }
  });

  it("isolates an uncaught mutation as an extension error", async () => {
    const h = createHarness({ extensions: () => [{ name: "broken", async onRunEnded(_ctx, info) {
      (info.termination as any).outcome = "MISSION_FAILURE";
    } }] });
    try {
      const metrics = await h.runner(testConfig()).run();
      expect(metrics.termination?.outcome).toBe("SUCCESS");
      expect(metrics.extensionErrors).toBe(1);
      expect(metrics.errors).toBe(0);
    } finally { h.db.close(); }
  });
});
