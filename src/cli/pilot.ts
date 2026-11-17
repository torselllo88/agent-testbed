#!/usr/bin/env node
/**
 * The pilot's run logs (docs/scenarios/pilot-settlement.md).
 *
 *   npm run pilot -- export   (--batch <id> | --experiment <id>) --out <dir> [--db <dir>]
 *   npm run pilot -- validate <run_log.json>… [--python "<command>"]
 *
 * export: one run log per run (schemas/run_log.schema.json of the bundle),
 * from the trace; thinking texts go to <run_id>.thinking.json next to it.
 * validate: the bundle's own tools/validate_run_log.py on each log, as an
 * independent check (a log that fails it is not structurally valid). The
 * validator is run with `uv run --no-project python` by default; --python
 * names another interpreter command (e.g. "python3").
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { openDb } from "../persistence/db.js";
import { EventRepository } from "../persistence/eventRepository.js";
import { ExperimentRepository, type ExperimentRecord } from "../persistence/experimentRepository.js";
import { BUNDLE_DIR } from "../scenarios/pilotSettlement/adapter.js";
import { writeRunLog } from "../scenarios/pilotSettlement/runLog.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    batch: { type: "string" },
    experiment: { type: "string" },
    out: { type: "string" },
    python: { type: "string", default: "uv run --no-project python" },
  },
});

const usage = (): never => {
  console.error(
    "usage:\n  npm run pilot -- export (--batch <id> | --experiment <id>) --out <dir> [--db <dir>]\n" +
      '  npm run pilot -- validate <run_log.json>... [--python "<command>"]'
  );
  process.exit(2);
};

switch (positionals[0]) {
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
