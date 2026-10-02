import { describe, expect, it } from "vitest";
import { applyVariable, BatchSpecSchema } from "../../src/batch/spec.js";
import { BatchService } from "../../src/batch/service.js";
import { ExperimentService } from "../../src/experiment/service.js";
import { createEvaluatorRegistry } from "../../src/scenarios/index.js";
import { createHarness, testConfig } from "../helpers/harness.js";

describe("batch path isolation", () => {
  it.each(["__proto__.auditMarker", "agents.*.__proto__.auditMarker", "constructor.prototype.auditMarker", "agents.0.model.__proto__", "agents..model"])("rejects %s before applying variables", (path) => {
    const h = createHarness();
    const deps = { db: h.db, providers: h.providers, evaluators: createEvaluatorRegistry() };
    const batches = new BatchService({ ...deps, service: new ExperimentService(deps) });
    try {
      expect(() => batches.resolve({ name: "unsafe", base: { config: testConfig() }, repetitions: 1,
        variables: [{ path, values: ["polluted"] }] })).toThrow();
      expect(Object.hasOwn(Object.prototype, "auditMarker")).toBe(false);
      expect(() => applyVariable({}, path, "polluted")).toThrow();
      expect(Object.hasOwn(Object.prototype, "auditMarker")).toBe(false);
    } finally { h.db.close(); }
  });

  it("refuses inherited intermediate objects and non-index array properties", () => {
    const inherited = { nested: { value: 1 } };
    expect(() => applyVariable(Object.create(inherited), "nested.value", 2)).toThrow();
    expect(inherited.nested.value).toBe(1);
    for (const path of ["agents.length", "agents.100", "agents.01", "agents.map.value"]) {
      expect(() => applyVariable({ agents: [{}] }, path, 2)).toThrow();
    }
  });

  it("allows wildcard/index writes and optional leaf settings", () => {
    const config = { agents: [{ model: {} }, { model: {} }] };
    applyVariable(config, "agents.*.model.temperature", 0.5);
    applyVariable(config, "agents.0.model.temperature", 0);
    expect(config.agents).toEqual([{ model: { temperature: 0 } }, { model: { temperature: 0.5 } }]);
    expect(BatchSpecSchema.safeParse({ name: "safe", base: { builtin: "space-station" }, repetitions: 1,
      variables: [{ path: "$agents", values: [["operations"]] }] }).success).toBe(true);
  });
});
