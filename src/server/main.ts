#!/usr/bin/env node
import { env } from "../config/env.js";
import { createProviderRegistryFromEnv } from "../llm/registry.js";
import { openDb } from "../persistence/db.js";
import { createApp } from "./app.js";

const db = openDb();
const providers = createProviderRegistryFromEnv();
const server = createApp({ db, providers });

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
