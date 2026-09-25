#!/usr/bin/env node
import { BatchService } from "../batch/service.js";
import { env } from "../config/env.js";
import { ExperimentService } from "../experiment/service.js";
import { createProviderRegistryFromEnv } from "../llm/registry.js";
import { StubProvider } from "../llm/stubProvider.js";
import { openDb } from "../persistence/db.js";
import { ScenarioRepository } from "../persistence/scenarioRepository.js";
import { BUILTIN_SCENARIOS, createEvaluatorRegistry, registerBuiltinStubs } from "../scenarios/index.js";
import { createApp } from "./app.js";

const db = openDb();
const providers = createProviderRegistryFromEnv(registerBuiltinStubs(new StubProvider(env.stubLatencyMs)));
const evaluators = createEvaluatorRegistry();
const service = new ExperimentService({ db, providers, evaluators });

const batches = new BatchService({ db, providers, evaluators, service });

const interrupted = service.recoverInterrupted();
if (interrupted.length > 0) console.log(`Marked ${interrupted.length} experiment(s) cut off by the last shutdown as INTERRUPTED.`);
const interruptedBatches = batches.recoverInterrupted();
if (interruptedBatches.length > 0) console.log(`Marked ${interruptedBatches.length} batch(es) cut off by the last shutdown as interrupted.`);

// First start on an empty database: make the reference scenario available to edit and run.
const scenarios = new ScenarioRepository(db);
if (scenarios.count() === 0) {
  for (const builtin of BUILTIN_SCENARIOS) scenarios.create(builtin.config());
}

const server = createApp({ db, providers, evaluators, service, batches });

server.listen(env.port, env.host, () => {
  console.log(`Agent testbed running at http://${env.host === "0.0.0.0" ? "localhost" : env.host}:${env.port}`);
  const configured = providers
    .status()
    .filter((p) => p.configured)
    .map((p) => p.id);
  console.log(`LLM providers available: ${configured.join(", ")}`);
  if (env.host === "0.0.0.0") {
    console.log("Bound to 0.0.0.0 — reachable from outside this machine, with no authentication. Make sure that's intended.");
  }
});
