import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BatchService, BatchValidationError } from "../../src/batch/service.js";
import { DEFAULT_SPEC_DIRS, SpecLibrary } from "../../src/batch/specLibrary.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { OllamaProvider } from "../../src/llm/ollamaProvider.js";
import { ProviderRegistry } from "../../src/llm/registry.js";
import { StubProvider } from "../../src/llm/stubProvider.js";
import { createInMemoryDb } from "../../src/persistence/db.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../../src/scenarios/index.js";

/** Batch specs as files (specs/, examples/) for the web UI, and $models — one model for every agent. */

function batchService() {
  const db = createInMemoryDb();
  // The examples name an Ollama endpoint: configured here (never called — specs are only resolved).
  const providers = new ProviderRegistry([new OllamaProvider({ name: "lab-ollama", baseUrl: "http://127.0.0.1:9" })], registerBuiltinStubs(new StubProvider()));
  const evaluators = createEvaluatorRegistry();
  return new BatchService({ db, providers, evaluators, service: new ExperimentService({ db, providers, evaluators }) });
}

describe("spec library", () => {
  it("lists *.batch.json with name and description, reads only what it lists, inlines a configPath base", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specs-"));
    fs.mkdirSync(path.join(root, "specs"));
    fs.writeFileSync(path.join(root, "specs", "a.batch.json"), JSON.stringify({ name: "A", description: "what A is for", base: { builtin: "space-station" }, repetitions: 1 }));
    fs.writeFileSync(path.join(root, "specs", "broken.batch.json"), "{ nope");
    fs.writeFileSync(path.join(root, "specs", "notes.json"), "{}");
    fs.writeFileSync(path.join(root, "specs", "base.json"), JSON.stringify({ name: "inline base" }));
    fs.writeFileSync(path.join(root, "specs", "c.batch.json"), JSON.stringify({ name: "C", base: { configPath: "base.json" }, repetitions: 1 }));
    fs.writeFileSync(path.join(root, "secret.batch.json"), "{}");
    const library = new SpecLibrary(["specs", "missing"], root);

    const list = library.list();
    expect(list.map((e) => e.id)).toEqual(["specs/a.batch.json", "specs/broken.batch.json", "specs/c.batch.json"]);
    expect(list[0]).toMatchObject({ name: "A", description: "what A is for", error: null });
    expect(list[1]!.error).toBeTruthy();
    expect(library.read("specs/a.batch.json")).toMatchObject({ name: "A" });
    expect(library.read("specs/c.batch.json")).toMatchObject({ base: { config: { name: "inline base" } } });
    expect(library.read("specs/broken.batch.json")).toBeNull();
    expect(library.read("specs/../secret.batch.json")).toBeNull();
    expect(library.read("secret.batch.json")).toBeNull();
  });

  it("the examples that come with the testbed are listed and every one resolves", () => {
    const entries = new SpecLibrary(DEFAULT_SPEC_DIRS).list();
    const settlement = entries.filter((e) => e.id.startsWith("examples/service-settlement-"));
    expect(settlement.map((e) => e.file).sort()).toEqual([
      "service-settlement-calibration.batch.json",
      "service-settlement-paired.batch.json",
      "service-settlement-smoke.batch.json",
    ]);
    expect(settlement.every((e) => e.description && !e.error)).toBe(true);
    const batches = batchService();
    for (const e of settlement) expect(() => batches.resolve(new SpecLibrary(DEFAULT_SPEC_DIRS).read(e.id)), e.id).not.toThrow();
  });
});

describe("$models", () => {
  it("sets every agent's model as the run dialog does — the scenario's temperature, seed and output cap stay", () => {
    const resolved = batchService().resolve({
      name: "models",
      base: { builtin: "service-settlement" },
      repetitions: 1,
      variables: [
        {
          path: "$models",
          label: "model",
          values: [
            { provider: "openai-compatible", endpoint: "lab-ollama", model: "qwen3.8:27b", structuredOutput: "native", think: false, contextLength: 8192 },
            { provider: "stub", model: "service-settlement/lure" },
          ],
        },
      ],
    });
    expect(resolved.conditions.map((c) => c.key)).toEqual(["model=lab-ollama/qwen3.8:27b (native, think off, ctx 8192)", "model=stub/service-settlement/lure"]);
    const ollama = [...resolved.conditionConfigs.values()][0]!;
    expect(ollama.agents.every((a) => a.model.provider === "openai-compatible" && a.model.endpoint === "lab-ollama" && a.model.think === false && a.model.contextLength === 8192)).toBe(true);
    expect(ollama.agents[0]!.model).toMatchObject({ temperature: 0, seed: 1, maxOutputTokens: 400 });
  });

  it("refuses an invalid choice and an unknown virtual path", () => {
    const problems = (variables: unknown[]) => {
      try {
        batchService().resolve({ name: "x", base: { builtin: "service-settlement" }, repetitions: 1, variables });
        return "";
      } catch (err) {
        expect(err).toBeInstanceOf(BatchValidationError);
        return (err as BatchValidationError).problems.join("\n");
      }
    };
    expect(problems([{ path: "$models", values: [{ provider: "openrouter", model: "a/b", think: false }] }])).toMatch(/\$models: .*think/);
    expect(problems([{ path: "$model", values: [1] }])).toMatch(/unknown virtual path "\$model"/);
  });
});
