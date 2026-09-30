#!/usr/bin/env node
/**
 * Headless single run:  npm run experiment -- [config.json | builtin-id] [--db <dir>] [--language ru] [--watch]
 * Runs through exactly the same ExperimentRunner as the web UI, persists the
 * full trace to the database, and prints the summary as JSON.
 */
import fs from "node:fs";
import { parseArgs } from "node:util";
import { ExperimentRunner } from "../experiment/runner.js";
import { createProviderRegistryFromEnv } from "../llm/registry.js";
import { StubProvider } from "../llm/stubProvider.js";
import { openDb } from "../persistence/db.js";
import { presentationExtensions } from "../presentation/index.js";
import { BUILTIN_SCENARIOS, createEvaluatorRegistry, registerBuiltinStubs } from "../scenarios/index.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  // --pacing scenario: the older spelling of --watch.
  options: { db: { type: "string" }, language: { type: "string" }, watch: { type: "boolean" }, pacing: { type: "string" } },
});

const source = positionals[0] ?? "space-station";
const builtin = BUILTIN_SCENARIOS.find((s) => s.id === source);
const rawConfig: unknown = builtin ? builtin.config() : JSON.parse(fs.readFileSync(source, "utf-8"));

const db = openDb(values.db);
const providers = createProviderRegistryFromEnv(registerBuiltinStubs(new StubProvider()));
const runner = new ExperimentRunner({ db, providers, evaluators: createEvaluatorRegistry(), extensions: presentationExtensions }, rawConfig, {
  origin: "cli",
  overrides: values.language ? { language: values.language } : undefined,
  // Headless (no viewer pacing, no reveal pauses) unless someone watches the room live: --watch.
  headless: !(values.watch || values.pacing === "scenario"),
});

process.on("SIGINT", () => {
  console.error("\nStopping experiment…");
  try {
    runner.control({ type: "stop" });
  } catch {
    // already finished — nothing left to stop
  }
});

console.error(`Experiment ${runner.id} — ${runner.config.name}`);
const metrics = await runner.run();
console.log(JSON.stringify({ experimentId: runner.id, ...metrics }, null, 2));
process.exitCode = metrics.termination?.status === "SUCCESS" ? 0 : 1;
