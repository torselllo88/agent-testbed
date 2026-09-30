#!/usr/bin/env node
import { env } from "../config/env.js";
import { OpenRouterModelCatalog } from "../llm/openRouterModels.js";
import { createProviderRegistryFromEnv } from "../llm/registry.js";
import { StubProvider } from "../llm/stubProvider.js";
import { openDb } from "../persistence/db.js";
import { ScenarioRepository } from "../persistence/scenarioRepository.js";
import { BUILTIN_SCENARIOS, createEvaluatorRegistry, registerBuiltinStubs } from "../scenarios/index.js";
import { createApp } from "./app.js";
import { composeTestbed } from "./compose.js";
import { createExternalApp } from "./externalApp.js";

const db = openDb();
const providers = createProviderRegistryFromEnv(registerBuiltinStubs(new StubProvider(env.stubLatencyMs)));
const evaluators = createEvaluatorRegistry();
// The experiment core plus its add-ons: presentation, people in the room, external room bindings.
const { service, batches, interaction, rooms } = composeTestbed({ db, providers, evaluators, externalScenarios: env.externalApi.scenarios });

const interrupted = service.recoverInterrupted();
if (interrupted.length > 0) console.log(`Marked ${interrupted.length} experiment(s) cut off by the last shutdown as INTERRUPTED.`);
const interruptedBatches = batches.recoverInterrupted();
if (interruptedBatches.length > 0) console.log(`Marked ${interruptedBatches.length} batch(es) cut off by the last shutdown as interrupted.`);
const interruptedDebriefs = interaction.recoverInterrupted();
if (interruptedDebriefs > 0) console.log(`Marked ${interruptedDebriefs} debrief session(s) cut off by the last shutdown as INTERRUPTED.`);
const interruptedBindings = rooms.recoverInterrupted();
if (interruptedBindings > 0) console.log(`Told ${interruptedBindings} external room binding(s) that their run was interrupted.`);

// Built-in scenarios live in the library as read-only rows kept in sync with the code.
const synced = new ScenarioRepository(db).syncBuiltins(BUILTIN_SCENARIOS);
if (synced.added.length || synced.updated.length) {
  console.log(`Built-in scenarios: added [${synced.added.join(", ")}], updated [${synced.updated.join(", ")}]`);
}

const server = createApp({ db, providers, evaluators, service, batches, interaction, rooms, allowedHosts: env.allowedHosts, openRouterModels: new OpenRouterModelCatalog(env.openRouter.baseUrl) });

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

// External Room API: its own listener, only /api/external/*, only with a token (docs/external-room-api.md).
if (env.externalApi.token) {
  if (env.externalApi.token.length < 24) console.log("EXTERNAL_API_TOKEN is short — use a long random value.");
  createExternalApp({ rooms, token: env.externalApi.token }).listen(env.externalApi.port, env.externalApi.host, () => {
    console.log(`External Room API at http://${env.externalApi.host}:${env.externalApi.port}/api/external (scenarios: ${env.externalApi.scenarios.join(", ") || "none allowed"})`);
    if (env.externalApi.host !== "127.0.0.1" && env.externalApi.host !== "localhost") {
      console.log("External Room API is reachable from the network. Bearer tokens are not encryption — use TLS (reverse proxy) or a private network.");
    }
  });
} else {
  console.log("External Room API disabled (set EXTERNAL_API_TOKEN to enable).");
}
