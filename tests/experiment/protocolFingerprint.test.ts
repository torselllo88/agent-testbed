import { describe, expect, it } from "vitest";
import { BatchService } from "../../src/batch/service.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { computeProtocolFingerprint, protocolAssets, PROTOCOL_FINGERPRINT } from "../../src/experiment/protocolFingerprint.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";
import { createHarness, ofType, testConfig } from "../helpers/harness.js";

describe("protocol fingerprint", () => {
  it("matches the recorded snapshot", () => {
    // A failure here means text agents read has changed: a prompt template, a runtime note or feedback,
    // a moderator notice, or a response schema. Runs before and after the change are NOT comparable as the
    // same protocol. If the change is intended, update this value deliberately — the fingerprint recorded
    // with every run changes with it.
    expect(PROTOCOL_FINGERPRINT).toBe("8a715c5c37ce5c46");
  });

  it("is deterministic and covers every kind of protocol asset", () => {
    expect(computeProtocolFingerprint()).toBe(PROTOCOL_FINGERPRINT);
    const assets = JSON.stringify(protocolAssets());
    for (const piece of [
      "How the room works:", // system prompt
      "Language: write everything", // language instruction
      "It is your turn in the DISCUSSION phase (discussion turns used:", // budget visibility branch
      "You are being asked to re-confirm your readiness", // readiness re-check note
      "Your previous submission was not accepted", // proposal feedback
      "Your previous response could not be used", // parse retry
      "VOTING phase.", // vote prompt
      "You moderate turn-taking", // router prompt
      "Голосование открыто.", // a moderator notice in an authored language
      "readyToCommit", // the turn schema
      "(no messages yet)", // an empty room
    ]) {
      expect(assets, piece).toContain(piece);
    }
  });

  it("is recorded with every run and exported with batch runs", async () => {
    const h = createHarness();
    const runner = h.runner(testConfig());
    const metrics = await runner.run();
    expect(ofType(h.events(runner.id), "experiment_started")[0]!.payload.protocolFingerprint).toBe(PROTOCOL_FINGERPRINT);
    expect(metrics.protocolFingerprint).toBe(PROTOCOL_FINGERPRINT);

    const db = createInMemoryDb();
    const providers = new ProviderRegistry([], registerBuiltinStubs(new StubProvider()));
    const evaluators = createEvaluatorRegistry();
    const batches = new BatchService({ db, providers, evaluators, service: new ExperimentService({ db, providers, evaluators }) });
    const batch = batches.start({ name: "fp", base: { builtin: "space-station" }, repetitions: 1 });
    for (let i = 0; i < 200 && batches.isRunning(batch.id); i++) await new Promise((r) => setTimeout(r, 20));
    const [header, row] = batches.csv(batch.id).trim().split("\n");
    const columns = header!.split(",");
    expect(row!.split(",")[columns.indexOf("protocol_fingerprint")]).toBe(PROTOCOL_FINGERPRINT);
  });
});
