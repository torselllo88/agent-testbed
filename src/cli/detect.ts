#!/usr/bin/env node
/**
 * Exposure detection — an analysis pass over finished runs (docs/exposure.md).
 *
 *   npm run detect -- label  (--batch <id> | --experiment <id>) --model '<model JSON or file>' [--force]
 *   npm run detect -- export (--batch <id> | --experiment <id>) [--runs runs.csv] [--facts facts.csv]
 *   npm run detect -- sample --batch <id> [--n 40] [--seed 1] --out sample.csv
 *   npm run detect -- agree  --labels sample.csv [--out report.json]
 *
 * Every command takes --db <dir> (default DATA_DIR). The model is a model
 * reference as in a config, e.g.
 *   {"provider":"openai-compatible","endpoint":"lab-ollama","model":"qwen3.8:27b","structuredOutput":"native",
 *    "temperature":0,"seed":1,"maxOutputTokens":1500,"think":false,"contextLength":8192}
 */
import fs from "node:fs";
import { parseArgs } from "node:util";
import { DETECTOR_VERSION, detectRun, factsHash, factsOf } from "../analysis/exposure.js";
import { agreementFromCsv, exposureFactsCsv, exposureRunsCsv, labelingSampleCsv, type RunWithExposure } from "../analysis/exposureReport.js";
import { canonicalJson, ModelRefSchema } from "../experiment/config.js";
import { createProviderRegistryFromEnv } from "../llm/registry.js";
import { StubProvider } from "../llm/stubProvider.js";
import { openDb } from "../persistence/db.js";
import { ExperimentRepository, type ExperimentRecord } from "../persistence/experimentRepository.js";
import { ExposureRepository } from "../persistence/exposureRepository.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../scenarios/index.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    batch: { type: "string" },
    experiment: { type: "string" },
    model: { type: "string" },
    force: { type: "boolean", default: false },
    runs: { type: "string" },
    facts: { type: "string" },
    n: { type: "string", default: "40" },
    seed: { type: "string", default: "1" },
    out: { type: "string" },
    labels: { type: "string" },
  },
});

const usage = () => {
  console.error(
    "usage:\n  npm run detect -- label  (--batch <id> | --experiment <id>) --model '<json|file>' [--force]\n" +
      "  npm run detect -- export (--batch <id> | --experiment <id>) [--runs runs.csv] [--facts facts.csv]\n" +
      "  npm run detect -- sample --batch <id> [--n 40] [--seed 1] --out sample.csv\n" +
      "  npm run detect -- agree  --labels sample.csv [--out report.json]\n" +
      "  (every command: [--db <dir>])"
  );
  process.exit(2);
};

const db = openDb(values.db);
const experiments = new ExperimentRepository(db);
const exposures = new ExposureRepository(db);
const evaluators = createEvaluatorRegistry();

function selectedRuns(): ExperimentRecord[] {
  if (values.experiment) return [experiments.getOrThrow(values.experiment)];
  if (values.batch) return experiments.list({ batchId: values.batch, limit: 100000 }).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  return usage();
}

const withExposure = (runs: ExperimentRecord[]): RunWithExposure[] => runs.map((run) => ({ run, detection: exposures.latest(run.id) }));

switch (positionals[0]) {
  case "label": {
    if (!values.model) usage();
    const raw = values.model!.trim().startsWith("{") ? values.model! : fs.readFileSync(values.model!, "utf8");
    const model = ModelRefSchema.parse(JSON.parse(raw));
    const providers = createProviderRegistryFromEnv(registerBuiltinStubs(new StubProvider()));
    const abort = new AbortController();
    process.on("SIGINT", () => {
      console.error("\nStopping after the current call…");
      abort.abort();
    });
    const runs = selectedRuns().filter((r) => r.finishedAt);
    let labeled = 0;
    let skipped = 0;
    for (const [i, run] of runs.entries()) {
      if (abort.signal.aborted) break;
      let hash: string;
      try {
        hash = factsHash(factsOf(evaluators, run.config));
      } catch (err) {
        console.error(`[${i + 1}/${runs.length}] ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
        skipped += 1;
        continue;
      }
      const done = exposures
        .list(run.id)
        .some((d) => d.detectorVersion === DETECTOR_VERSION && d.factsHash === hash && canonicalJson(d.model) === canonicalJson(model));
      if (done && !values.force) {
        skipped += 1;
        continue;
      }
      const record = await detectRun({ db, providers, evaluators }, run.id, model, {
        signal: abort.signal,
        onMessage: (m, total) => process.stderr.write(`\r[${i + 1}/${runs.length}] ${run.id}: message ${m}/${total}   `),
      });
      const s = (record.result as { summary: { proposerFacts: { total: number; correct: number }; unlabeledMessages: number } }).summary;
      process.stderr.write(`\r[${i + 1}/${runs.length}] ${run.id}: proposer correctly exposed to ${s.proposerFacts.correct}/${s.proposerFacts.total} facts${s.unlabeledMessages ? `, ${s.unlabeledMessages} message(s) not labeled` : ""}\n`);
      labeled += 1;
    }
    console.error(`${labeled} run(s) labeled, ${skipped} skipped (already labeled with this detector, model and fact list — --force relabels — or no fact list).`);
    break;
  }
  case "export": {
    const entries = withExposure(selectedRuns());
    if (values.runs) fs.writeFileSync(values.runs, exposureRunsCsv(entries));
    if (values.facts) fs.writeFileSync(values.facts, exposureFactsCsv(entries));
    if (!values.runs && !values.facts) process.stdout.write(exposureRunsCsv(entries));
    console.error(`${entries.filter((e) => e.detection).length} of ${entries.length} run(s) have an exposure pass.`);
    break;
  }
  case "sample": {
    if (!values.batch || !values.out) usage();
    const csv = labelingSampleCsv(withExposure(selectedRuns()), Number(values.n), Number(values.seed));
    fs.writeFileSync(values.out!, csv);
    console.error(`Wrote ${csv.trim().split("\n").length - 1} row(s) to ${values.out}: fill in human_label (absent / correct / incorrect), then run "agree".`);
    break;
  }
  case "agree": {
    if (!values.labels) usage();
    const report = agreementFromCsv(fs.readFileSync(values.labels!, "utf8"), (id) => exposures.latest(id));
    if (values.out) fs.writeFileSync(values.out, JSON.stringify(report, null, 2));
    const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
    console.log(`${report.n} label(s) compared (${report.unmatched} without a detector label): agreement ${pct(report.observed)}, Cohen's kappa ${report.kappa === null ? "—" : report.kappa.toFixed(3)}`);
    for (const [label, s] of Object.entries(report.perLabel)) console.log(`  ${label.padEnd(10)} precision ${pct(s.precision)}  recall ${pct(s.recall)}  (${s.support} by hand)`);
    for (const [kind, s] of Object.entries(report.byKind)) console.log(`  kind ${kind.padEnd(9)} n ${s.n}, agreement ${pct(s.observed)}, kappa ${s.kappa === null ? "—" : s.kappa.toFixed(3)}`);
    break;
  }
  default:
    usage();
}
