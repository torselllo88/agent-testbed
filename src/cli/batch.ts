#!/usr/bin/env node
/**
 * Headless batch:  npm run batch -- spec.json [--db <dir>] [--out results.json] [--csv runs.csv]
 *
 * Runs through the same BatchService / ExperimentService / ExperimentRunner
 * as the web UI; every run is stored in the database like any other. In the
 * spec, `base` may be { "builtin": "space-station" }, { "config": {...} },
 * { "scenarioId": "..." } (from the database), or — CLI only —
 * { "configPath": "path/to/config.json" }.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { BatchService, BatchValidationError } from "../batch/service.js";
import { ExperimentService } from "../experiment/service.js";
import { createProviderRegistryFromEnv } from "../llm/registry.js";
import { StubProvider } from "../llm/stubProvider.js";
import { openDb } from "../persistence/db.js";
import { presentationExtensions } from "../presentation/index.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../scenarios/index.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { db: { type: "string" }, out: { type: "string" }, csv: { type: "string" } },
});
if (!positionals[0]) {
  console.error("usage: npm run batch -- spec.json [--db dir] [--out results.json] [--csv runs.csv]");
  process.exit(2);
}

const specPath = path.resolve(positionals[0]);
const spec = JSON.parse(fs.readFileSync(specPath, "utf-8")) as { base?: Record<string, unknown> };
if (spec.base && typeof spec.base.configPath === "string") {
  spec.base = { config: JSON.parse(fs.readFileSync(path.resolve(path.dirname(specPath), spec.base.configPath), "utf-8")) };
}

const db = openDb(values.db);
// Latency here is irrelevant: BatchService always uses the spec's own stubLatencyMs (default 0).
const providers = createProviderRegistryFromEnv(registerBuiltinStubs(new StubProvider()));
const evaluators = createEvaluatorRegistry();
const service = new ExperimentService({ db, providers, evaluators, extensions: presentationExtensions });
const batches = new BatchService({ db, providers, evaluators, service });

let batchId: string;
try {
  batchId = batches.start(spec).id;
} catch (err) {
  if (err instanceof BatchValidationError) {
    console.error(`Batch spec is not runnable:\n- ${err.problems.join("\n- ")}`);
    process.exit(2);
  }
  throw err;
}

process.on("SIGINT", () => {
  console.error("\nCancelling batch…");
  batches.cancel(batchId);
});

const total = batches.view(batchId).progress.total;
console.error(`Batch ${batchId}: ${total} runs`);
const ticker = setInterval(() => {
  const { finished } = batches.view(batchId).progress;
  console.error(`  ${finished}/${total} finished`);
}, 2000);
await batches.settle(batchId);
clearInterval(ticker);

const view = batches.view(batchId);
const result = { batchId, status: view.batch.status, progress: view.progress, overall: view.overall, conditions: view.aggregates };
if (values.out) fs.writeFileSync(values.out, JSON.stringify(result, null, 2));
if (values.csv) fs.writeFileSync(values.csv, batches.csv(batchId));

for (const a of view.aggregates) {
  const rate = a.successRate === null ? "—" : `${(a.successRate * 100).toFixed(0)}%`;
  const ci = a.successRateCI95 ? ` [${(a.successRateCI95[0] * 100).toFixed(0)}–${(a.successRateCI95[1] * 100).toFixed(0)}%]` : "";
  const excluded = a.excluded.total ? `, EXCLUDED ${a.excluded.total} ${JSON.stringify(a.excluded.byOutcome)}` : "";
  console.error(`${a.key}: success ${rate}${ci} of ${a.evaluable}${excluded}, median tokens ${a.tokens.total.median ?? "—"}, outcomes ${JSON.stringify(a.outcomes)}`);
}
if (view.overall.excluded.total) {
  console.error(
    `WARNING: ${view.overall.excluded.total} run(s) excluded from success rates ${JSON.stringify(view.overall.excluded.byOutcome)}` +
      (view.overall.providerErrors ? " — provider instability, not coordination" : "")
  );
}
if (!values.out) console.log(JSON.stringify(result, null, 2));
