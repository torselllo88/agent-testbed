import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunExtensionFactory } from "../../src/experiment/extensions.js";
import { kestrelConfig } from "../../src/scenarios/spaceStation/kestrel.js";
import { createHarness, ofType } from "../helpers/harness.js";

/**
 * Architectural invariant: the experiment core contains only experiment
 * semantics. Product / demo features live outside it: narration and viewer
 * pacing in src/presentation (attached through the core's extension
 * interface), spectators and the post-run debrief in src/interaction (around
 * finished runs, with their own persistence).
 */

const CORE_DIRS = ["experiment", "scheduling", "consensus", "transport", "evaluation", "llm", "persistence", "batch", "scenarios"];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("experiment core boundary", () => {
  it("no core module imports an add-on layer (presentation, human interaction, external rooms)", () => {
    const offenders = CORE_DIRS.flatMap((d) => sourceFiles(path.resolve("src", d))).filter((file) =>
      /from\s+["'][./]*\/(presentation|interaction|rooms)\//.test(fs.readFileSync(file, "utf8"))
    );
    expect(offenders).toEqual([]);
  });

  it("the human-interaction layer knows nothing about external rooms", () => {
    const offenders = sourceFiles(path.resolve("src", "interaction")).filter((file) => /from\s+["'][./]*\/rooms\//.test(fs.readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("without extensions the runner is the bare core: no narration, no pacing — even for a presentation-heavy scenario", async () => {
    const h = createHarness({ extensions: null });
    const config = kestrelConfig();
    config.runtime.providerRetryDelayMs = 0;
    expect(config.presentation.pacing.minVisibleIntervalMs).toBeGreaterThan(0);
    const t0 = Date.now();
    const runner = h.runner(config);
    const metrics = await runner.run();

    expect(metrics.termination?.outcome).toBe("SUCCESS");
    expect(Date.now() - t0).toBeLessThan(2000); // Kestrel's own pacing would take ~20 s
    expect(metrics.messages.narrator).toBe(0);
    expect(ofType(h.events(runner.id), "presentation_delay")).toHaveLength(0);
    expect(metrics.durationMs.presentation).toBe(0);
  });

  it("an extension that fails is logged and never changes the outcome", async () => {
    const broken: RunExtensionFactory = () => [
      {
        name: "broken",
        async onRoomOpened() {
          throw new Error("boom at open");
        },
        async onRunEnded() {
          throw new Error("boom at end");
        },
      },
    ];
    const h = createHarness({ extensions: broken });
    const config = kestrelConfig();
    config.runtime.providerRetryDelayMs = 0;
    config.presentation.pacing = { minVisibleIntervalMs: 0, perCharMs: 0, maxGapMs: 0 };
    const runner = h.runner(config);
    const metrics = await runner.run();

    expect(metrics.termination?.outcome).toBe("SUCCESS");
    const errors = ofType(h.events(runner.id), "error").map((e) => String(e.payload.message));
    expect(errors).toEqual(['extension "broken" failed in onRoomOpened: boom at open', 'extension "broken" failed in onRunEnded: boom at end']);
  });
});
