#!/usr/bin/env node
/**
 * The pilot's run logs (docs/scenarios/pilot-settlement.md).
 *
 *   npm run pilot -- export   (--batch <id> | --experiment <id>) --out <dir> [--db <dir>]
 *   npm run pilot -- validate <run_log.json>… [--python "<command>"]
 *   npm run pilot -- calibrate --base-url <url> --model <name> --out <file> [--worst-case] [--num-predict <n>]
 *   npm run pilot -- pairs --instances dev|<id,id,…> --endpoint <name> --base-url <url> --model <name> --out <dir>
 *                        [--kind discussion|controls] [--replicate <n>] [--first alternating|complete|ring] [--db <dir>]
 *   npm run pilot -- determinism --logs <dev logs dir> --base-url <url> --model <name> --out <file> [--instance <id>]
 *
 * export: one run log per run (schemas/run_log.schema.json of the bundle),
 * from the trace; thinking texts go to <run_id>.thinking.json next to it.
 * validate: the bundle's own tools/validate_run_log.py on each log, as an
 * independent check (a log that fails it is not structurally valid). The
 * validator is run with `uv run --no-project --with jsonschema python` by
 * default (uv in the user's home brings a current Python and the schema
 * package; the bundle's tools need Python ≥ 3.7); --python names another
 * interpreter command (e.g. "python3.12").
 * calibrate: gate G2 against the real server (plan §4 steps 1–4, and 6 with
 * --worst-case): model record, system-prompt counts, counting semantics
 * (prompt_count_rule), truncation canary; the report goes to --out.
 * pairs: the pair runner (plan §3.2): per instance preload, snapshot, first
 * run, snapshot, second run, snapshot; deviation re-executions; run logs
 * with the snapshots written to --out as each pair finishes.
 * determinism: gate G6 — 3 discussion and 2 final calls from the dev logs
 * and one public-only call, each 3× cold and 3× warm with the same seed
 * under snapshots; identical content passes.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { openDb } from "../persistence/db.js";
import { EventRepository } from "../persistence/eventRepository.js";
import { ExperimentRepository, type ExperimentRecord } from "../persistence/experimentRepository.js";
import { BUNDLE_DIR } from "../scenarios/pilotSettlement/adapter.js";
import { calibrate, writeCalibration } from "../scenarios/pilotSettlement/calibrate.js";
import { PilotStopped, runPairs } from "../scenarios/pilotSettlement/pairRunner.js";
import { determinism, writeDeterminism } from "../scenarios/pilotSettlement/determinism.js";
import { ExperimentService } from "../experiment/service.js";
import { createProviderRegistryFromEnv } from "../llm/registry.js";
import { StubProvider } from "../llm/stubProvider.js";
import { createEvaluatorRegistry, registerBuiltinStubs } from "../scenarios/index.js";
import { writeRunLog } from "../scenarios/pilotSettlement/runLog.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    batch: { type: "string" },
    experiment: { type: "string" },
    out: { type: "string" },
    python: { type: "string", default: "uv run --no-project --with jsonschema python" },
    "base-url": { type: "string" },
    model: { type: "string" },
    "worst-case": { type: "boolean", default: false },
    "num-predict": { type: "string" },
    instances: { type: "string" },
    endpoint: { type: "string" },
    replicate: { type: "string" },
    first: { type: "string", default: "alternating" },
    kind: { type: "string", default: "discussion" },
    logs: { type: "string" },
    instance: { type: "string" },
  },
});

const usage = (): never => {
  console.error(
    "usage:\n  npm run pilot -- export (--batch <id> | --experiment <id>) --out <dir> [--db <dir>]\n" +
      '  npm run pilot -- validate <run_log.json>... [--python "<command>"]\n' +
      "  npm run pilot -- calibrate --base-url <url> --model <name> --out <file> [--worst-case] [--num-predict <n>]\n" +
      "  npm run pilot -- pairs --instances dev|<id,id,...> --endpoint <name> --base-url <url> --model <name> --out <dir> [--kind discussion|controls] [--replicate <n>] [--first alternating|complete|ring] [--db <dir>]\n" +
      "  npm run pilot -- determinism --logs <dev logs dir> --base-url <url> --model <name> --out <file> [--instance <id>]"
  );
  process.exit(2);
};

switch (positionals[0]) {
  case "determinism": {
    if (!values.logs || !values["base-url"] || !values.model || !values.out) usage();
    determinism({ logsDir: path.resolve(values.logs!), baseUrl: values["base-url"]!, model: values.model!, publicOnlyInstance: values.instance, log: (line) => console.error(line) })
      .then((report) => {
        const file = writeDeterminism(report, values.out!);
        console.log(`determinism report written to ${file}`);
        for (const line of report.summary) console.log(line);
        process.exit(report.pass ? 0 : 1);
      })
      .catch((err) => {
        console.error(`determinism failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
    break;
  }
  case "pairs": {
    if (!values.instances || !values.endpoint || !values["base-url"] || !values.model || !values.out) usage();
    const instances = values.instances === "dev" ? Array.from({ length: 10 }, (_, i) => `DEV-${String(i + 1).padStart(2, "0")}`) : values.instances!.split(",").map((s) => s.trim()).filter(Boolean);
    const replicate = values.replicate !== undefined ? Number(values.replicate) : 0;
    if (!(Number.isInteger(replicate) && replicate >= 0)) usage();
    if (!["alternating", "complete", "ring"].includes(values.first!)) usage();
    if (!["discussion", "controls"].includes(values.kind!)) usage();
    const db = openDb(values.db);
    const providers = createProviderRegistryFromEnv(registerBuiltinStubs(new StubProvider()));
    const evaluators = createEvaluatorRegistry();
    const service = new ExperimentService({ db, providers, evaluators });
    runPairs(
      { db, service },
      { instances, endpoint: values.endpoint!, baseUrl: values["base-url"]!, model: values.model!, outDir: path.resolve(values.out!), replicate, first: values.first as "alternating" | "complete" | "ring", kind: values.kind as "discussion" | "controls", log: (line) => console.error(line) }
    )
      .then((pairs) => {
        const valid = pairs.filter((p) => p.outcome === "valid").length;
        console.log(`${pairs.length} pair(s): ${valid} valid, ${pairs.length - valid} environment deviation(s); logs in ${path.resolve(values.out!)}`);
        process.exit(valid === pairs.length ? 0 : 1);
      })
      .catch((err) => {
        if (err instanceof PilotStopped) {
          console.error(`STOP: ${err.message}`);
          process.exit(3);
        }
        console.error(`pairs failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
    break;
  }
  case "calibrate": {
    if (!values["base-url"] || !values.model || !values.out) usage();
    const numPredict = values["num-predict"] !== undefined ? Number(values["num-predict"]) : undefined;
    if (numPredict !== undefined && !(Number.isInteger(numPredict) && numPredict > 0)) usage();
    calibrate({ baseUrl: values["base-url"]!, model: values.model!, worstCase: values["worst-case"], step3NumPredict: numPredict, log: (line) => console.error(line) })
      .then((report) => {
        const file = writeCalibration(report, values.out!);
        console.log(`calibration written to ${file}`);
        for (const line of report.summary) console.log(line);
        const failed = [report.step2.pass, report.step3.pass, report.step4.pass, report.step6?.pass ?? true].filter((p) => !p).length;
        if (report.step1.recordDifferences.length) console.log(`step 1: the server differs from the frozen record — ${report.step1.recordDifferences.length} difference(s), see the report`);
        process.exit(failed ? 1 : 0);
      })
      .catch((err) => {
        console.error(`calibration failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
    break;
  }
  case "export": {
    if (!values.out || (!values.batch && !values.experiment)) usage();
    const db = openDb(values.db);
    const experiments = new ExperimentRepository(db);
    const events = new EventRepository(db);
    const runs: ExperimentRecord[] = values.experiment
      ? [experiments.getOrThrow(values.experiment)]
      : experiments.list({ batchId: values.batch!, limit: 100000 }).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    let written = 0;
    for (const run of runs) {
      if (run.status === null) {
        console.error(`skip ${run.id}: not finished`);
        continue;
      }
      try {
        const { path: file, runLog } = writeRunLog(run, events.list(run.id), path.resolve(values.out!));
        const validity = runLog.validity as { status: string };
        console.log(`${file}  (${validity.status}, ${run.outcome})`);
        written += 1;
      } catch (err) {
        console.error(`skip ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`${written} run log(s) written to ${path.resolve(values.out!)}`);
    break;
  }
  case "validate": {
    const logs = positionals.slice(1);
    if (!logs.length) usage();
    const [cmd, ...args] = values.python!.split(/\s+/).filter(Boolean) as [string, ...string[]];
    const tools = path.join(BUNDLE_DIR, "tools");
    const schema = path.join(BUNDLE_DIR, "schemas", "run_log.schema.json");
    // -E -s: the interpreter ignores PYTHON* variables and the user site; the bundle's tools import only each other (the script's directory) and the stdlib.
    const python = (scriptArgs: string[]) => spawnSync(cmd, [...args, "-E", "-s", ...scriptArgs], { cwd: tools, encoding: "utf8" });
    // The schema check needs the jsonschema package; without it, only the reference validator runs (said once).
    const schemaProbe = python(["-c", "import jsonschema"]);
    const schemaCheck = !schemaProbe.error && schemaProbe.status === 0;
    if (!schemaCheck) console.error(`(schemas/run_log.schema.json not checked: the Python package "jsonschema" is not available to "${values.python}")`);
    const SCHEMA_SCRIPT = [
      "import json, sys, jsonschema",
      "schema = json.load(open(sys.argv[1], encoding='utf-8'))",
      "log = json.load(open(sys.argv[2], encoding='utf-8'))",
      "errors = sorted(jsonschema.Draft202012Validator(schema).iter_errors(log), key=lambda e: list(e.path))",
      "for e in errors: print('schema: ' + '/'.join(str(p) for p in e.path) + ': ' + e.message[:200])",
      "sys.exit(1 if errors else 0)",
    ].join("\n");
    let failed = 0;
    for (const log of logs) {
      const file = path.resolve(log);
      const runLog = JSON.parse(fs.readFileSync(file, "utf8")) as { instance_id: string };
      const instances = path.join(BUNDLE_DIR, "instances", runLog.instance_id.startsWith("DEV-") ? "dev_instances.json" : "pilot_instances.json");
      const result = python(["validate_run_log.py", file, "--instances", instances]);
      if (result.error) {
        console.error(`${log}: could not run the validator (${result.error.message}); is "${values.python}" available?`);
        process.exit(2);
      }
      const lines = [(result.stdout ?? "").trim(), (result.stderr ?? "").trim()].filter(Boolean);
      let ok = result.status === 0;
      if (schemaCheck) {
        const s = python(["-c", SCHEMA_SCRIPT, schema, file]);
        if (s.status !== 0) ok = false;
        lines.push(...[(s.stdout ?? "").trim(), (s.stderr ?? "").trim()].filter(Boolean));
      }
      if (!ok) failed += 1;
      console.log(`${log}: ${ok ? "OK" : "FAILED"}\n${lines.join("\n")}`);
    }
    console.log(`${logs.length - failed}/${logs.length} run log(s) passed the reference validator${schemaCheck ? " and the schema" : ""}`);
    process.exit(failed ? 1 : 0);
  }
  // falls through
  default:
    usage();
}
