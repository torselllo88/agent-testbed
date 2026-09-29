#!/usr/bin/env node
import { BatchService } from "../batch/service.js";
import { env } from "../config/env.js";
import { ExperimentService } from "../experiment/service.js";
import { createProviderRegistryFromEnv } from "../llm/registry.js";
import { StubProvider } from "../llm/stubProvider.js";
import { openDb } from "../persistence/db.js";
import { ScenarioRepository } from "../persistence/scenarioRepository.js";
import { BUILTIN_SCENARIOS, createEvaluatorRegistry, registerBuiltinStubs } from "../scenarios/index.js";
import { presentationExtensions } from "../presentation/index.js";
import { createApp } from "./app.js";

const db = openDb();
const providers = createProviderRegistryFromEnv(registerBuiltinStubs(new StubProvider(env.stubLatencyMs)));
const evaluators = createEvaluatorRegistry();
// Product/demo features (narration, viewer pacing) attach through the core's extension interface.
const service = new ExperimentService({ db, providers, evaluators, extensions: presentationExtensions });

const batches = new BatchService({ db, providers, evaluators, service });

const interrupted = service.recoverInterrupted();
if (interrupted.length > 0) console.log(`Marked ${interrupted.length} experiment(s) cut off by the last shutdown as INTERRUPTED.`);
const interruptedBatches = batches.recoverInterrupted();
if (interruptedBatches.length > 0) console.log(`Marked ${interruptedBatches.length} batch(es) cut off by the last shutdown as interrupted.`);

// Built-in scenarios live in the library as read-only rows kept in sync with the code.
const synced = new ScenarioRepository(db).syncBuiltins(BUILTIN_SCENARIOS);
if (synced.added.length || synced.updated.length) {
  console.log(`Built-in scenarios: added [${synced.added.join(", ")}], updated [${synced.updated.join(", ")}]`);
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
