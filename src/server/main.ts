#!/usr/bin/env node
import { env } from "../config/env.js";
import { OpenRouterModelCatalog } from "../llm/openRouterModels.js";
import { createProviderRegistryFromEnv } from "../llm/registry.js";
import { StubProvider } from "../llm/stubProvider.js";
import { forgetLeaseObservations, openDb } from "../persistence/db.js";
import { ScenarioRepository } from "../persistence/scenarioRepository.js";
import { BUILTIN_SCENARIOS, createEvaluatorRegistry, registerBuiltinStubs } from "../scenarios/index.js";
import { createApp } from "./app.js";
import { composeTestbed } from "./compose.js";
import { createExternalApp, externalRequestHandler } from "./externalApp.js";

const db = openDb();
const providers = createProviderRegistryFromEnv(registerBuiltinStubs(new StubProvider(env.stubLatencyMs)));
const evaluators = createEvaluatorRegistry();
// The experiment core plus its add-ons: presentation, people in the room, external room bindings.
const { service, batches, interaction, rooms } = composeTestbed({ db, providers, evaluators, externalScenarios: env.externalApi.scenarios });

// Startup recovery. A failure here (e.g. a database busy past its timeout) must not keep the server from starting:
// it is reported loudly, and the periodic pass below retries — each step is atomic per row and idempotent.
try {
  const interrupted = service.recoverInterrupted();
  if (interrupted.length > 0) console.log(`Marked ${interrupted.length} experiment(s) cut off by the last shutdown as INTERRUPTED.`);
  const interruptedBatches = batches.recoverInterrupted();
  if (interruptedBatches.length > 0) console.log(`Marked ${interruptedBatches.length} batch(es) cut off by the last shutdown as interrupted.`);
  const interruptedDebriefs = interaction.recoverInterrupted();
  if (interruptedDebriefs > 0) console.log(`Marked ${interruptedDebriefs} debrief session(s) cut off by the last shutdown as INTERRUPTED.`);
  const interruptedBindings = rooms.recoverInterrupted();
  if (interruptedBindings > 0) console.log(`Told ${interruptedBindings} external room binding(s) that their run was interrupted.`);
} catch (err) {
  console.error("\n*** Startup recovery failed — the server starts anyway; periodic recovery retries every minute. ***\n", err);
}

// While the server runs, another process sharing the database (e.g. a CLI batch) may crash: once it is gone
// (see ownerAlive), close its runs, batches and debrief sessions as interrupted — without waiting for a restart.
const RECOVERY_INTERVAL_MS = 60_000;
let lastRecoveryTick = performance.now();
setInterval(() => {
  const now = performance.now();
  const late = now - lastRecoveryTick > RECOVERY_INTERVAL_MS * 1.5;
  lastRecoveryTick = now;
  if (late) {
    // This process was suspended (e.g. the machine slept): the other owners were too, and have not had a chance
    // to beat yet. Skip this pass rather than risk interrupting a live one.
    forgetLeaseObservations(db);
    return;
  }
  try {
    const runs = service.recoverInterrupted().length;
    const orphanBatches = batches.recoverInterrupted().length;
    const sessions = interaction.recoverInterrupted();
    // Every pass: one idempotent query, and it catches up if an earlier pass failed after recovering the runs.
    const bindings = rooms.recoverInterrupted();
    if (runs || orphanBatches || sessions || bindings) {
      console.log(`Recovered after a crashed process: ${runs} run(s), ${orphanBatches} batch(es), ${sessions} debrief session(s), ${bindings} room binding(s).`);
    }
  } catch (err) {
    // E.g. the database stayed busy: the next pass retries. Never let recovery take the server down.
    console.error("Periodic recovery failed:", err);
  }
}, RECOVERY_INTERVAL_MS).unref();

// Built-in scenarios live in the library as read-only rows kept in sync with the code.
const synced = new ScenarioRepository(db).syncBuiltins(BUILTIN_SCENARIOS);
if (synced.added.length || synced.updated.length) {
  console.log(`Built-in scenarios: added [${synced.added.join(", ")}], updated [${synced.updated.join(", ")}]`);
}

const externalOnMain = Boolean(env.externalApi.token) && env.externalApi.listener === "main";
const server = createApp({
  db,
  providers,
  evaluators,
  service,
  batches,
  interaction,
  rooms,
  allowedHosts: env.allowedHosts,
  openRouterModels: new OpenRouterModelCatalog(env.openRouter.baseUrl),
  operatorToken: env.operatorToken,
  externalApi: externalOnMain ? externalRequestHandler({ rooms, token: env.externalApi.token! }) : undefined,
});

const publicBind = env.host === "0.0.0.0" || env.host === "::";
// On a hosting platform, a default (not explicitly chosen) public bind is only made with authentication on:
// an open testbed on the internet runs experiments on your provider keys for anyone with the URL.
if (env.platform && publicBind && !env.hostExplicit && !env.operatorToken) {
  console.error(
    `\n*** Running on ${env.platform} without OPERATOR_TOKEN — refusing to serve publicly without authentication.\n` +
      "*** Set OPERATOR_TOKEN to a long random value (the UI then asks for it as a password).\n" +
      "*** To serve it open anyway, set GUI_HOST=0.0.0.0 explicitly. ***\n"
  );
  process.exit(1);
}

server.listen(env.port, env.host, () => {
  console.log(`Agent testbed listening on ${env.host}:${env.port}${env.platform ? ` (${env.platform})` : ""}`);
  if (env.publicDomain) console.log(`Public URL: https://${env.publicDomain}`);
  else if (!publicBind) console.log(`Open http://${env.host === "127.0.0.1" ? "localhost" : env.host}:${env.port}`);
  console.log(`Operator authentication: ${env.operatorToken ? "on (OPERATOR_TOKEN)" : "off"}${env.allowedHosts.length ? ` · also serving host names: ${env.allowedHosts.join(", ")}` : ""}`);
  const configured = providers
    .status()
    .filter((p) => p.configured)
    .map((p) => p.id);
  console.log(`LLM providers available: ${configured.join(", ")}`);
  if (env.operatorToken && env.operatorToken.length < 16) console.log("OPERATOR_TOKEN is short — use a long random value.");
  if (publicBind && !env.operatorToken) {
    console.log(
      `\n*** Bound to ${env.host} WITHOUT authentication: anyone who can reach this address can run experiments on your provider keys,\n` +
        "*** read every trace and delete data. Set OPERATOR_TOKEN unless this network is private. ***\n"
    );
  }
  if (publicBind && env.allowedHosts.length === 0) {
    console.log("Requests are only served for localhost / 127.0.0.1 unless you list other names in GUI_ALLOWED_HOSTS (DNS-rebinding guard).");
  }
});

// External Room API: its own listener, only /api/external/*, only with a token (docs/external-room-api.md).
if (env.externalApi.token && externalOnMain) {
  if (env.externalApi.token.length < 24) console.log("EXTERNAL_API_TOKEN is short — use a long random value.");
  console.log(`External Room API on the main listener under /api/external (scenarios: ${env.externalApi.scenarios.join(", ") || "none allowed"})`);
} else if (env.externalApi.token) {
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
