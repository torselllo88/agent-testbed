import { z } from "zod";
import { canonicalJson, type ExperimentConfig } from "../experiment/config.js";

/**
 * A batch: one base configuration, a set of variables (dotted config paths
 * and the values to try), N repetitions per condition. Conditions are the
 * cartesian product of the variables' values.
 *
 * Path syntax:
 *   "scheduler.type"             — a single field
 *   "agents.*.model.model"       — `*` applies to every element of an array
 *   "scheduler"                  — whole objects are fine as values too
 *   "$agents"                    — virtual: value is the list of agent ids to keep (varies the number of agents)
 */
export const BatchVariableSchema = z.object({
  path: z.string().min(1),
  values: z.array(z.unknown()).min(1),
  /** Short name used in condition keys and CSV columns; defaults to the path. */
  label: z.string().min(1).optional(),
});
export type BatchVariable = z.infer<typeof BatchVariableSchema>;

export const BatchSpecSchema = z.preprocess(
  // Older specs said pacing: "scenario" | "off"; that is now headless: false | true.
  (raw) =>
    raw && typeof raw === "object" && "pacing" in raw && !("headless" in raw)
      ? { ...(raw as Record<string, unknown>), headless: (raw as { pacing?: unknown }).pacing !== "scenario" }
      : raw,
  z.object({
  name: z.string().min(1),
  base: z.union([
    z.object({ scenarioId: z.string().min(1) }),
    z.object({ builtin: z.string().min(1) }),
    z.object({ config: z.unknown() }),
  ]),
  variables: z.array(BatchVariableSchema).default([]),
  repetitions: z.number().int().min(1).max(1000),
  /** Experiments running at the same time. */
  concurrency: z.number().int().min(1).max(16).default(1),
  /**
   * Stub-provider latency for this batch's runs. 0 by default — batches never
   * inherit the web demo's STUB_LATENCY_MS; set it here only when latency is
   * itself an experimental parameter.
   */
  stubLatencyMs: z.number().int().min(0).default(0),
  /**
   * "interleaved" runs repetition 1 of every condition, then repetition 2, ...
   * so slow drift (provider load, rate limits, time of day) spreads evenly over
   * conditions instead of confounding them. "sequential" runs condition by condition.
   */
  order: z.enum(["interleaved", "sequential"]).default("interleaved"),
  /**
   * Nobody watches batch runs live, so by default they are headless: add-ons
   * skip what only matters to a live viewer (e.g. viewer pacing, which would
   * only add wall time). false keeps it — e.g. to record demo-like runs.
   * Never part of the experiment config or its hash.
   */
  headless: z.boolean().default(true),
})
);
export type BatchSpec = z.infer<typeof BatchSpecSchema>;

export interface BatchCondition {
  key: string;
  /** label -> value, in variable order. */
  values: Record<string, unknown>;
}

export interface PlannedRun {
  condition: BatchCondition;
  repetition: number;
}

export function variableLabel(v: BatchVariable): string {
  return v.label ?? v.path;
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : canonicalJson(value);
}

export function expandConditions(variables: BatchVariable[]): BatchCondition[] {
  let combos: Array<Record<string, unknown>> = [{}];
  for (const variable of variables) {
    const label = variableLabel(variable);
    combos = combos.flatMap((combo) => variable.values.map((value) => ({ ...combo, [label]: value })));
  }
  return combos.map((values) => ({
    key: Object.keys(values).length ? Object.entries(values).map(([k, v]) => `${k}=${formatValue(v)}`).join(" | ") : "baseline",
    values,
  }));
}

export function planRuns(conditions: BatchCondition[], repetitions: number, order: BatchSpec["order"]): PlannedRun[] {
  const runs: PlannedRun[] = [];
  if (order === "interleaved") {
    for (let rep = 1; rep <= repetitions; rep++) for (const condition of conditions) runs.push({ condition, repetition: rep });
  } else {
    for (const condition of conditions) for (let rep = 1; rep <= repetitions; rep++) runs.push({ condition, repetition: rep });
  }
  return runs;
}

/** Applies one variable value to a deep copy of the base config (raw — validated afterwards). */
export function applyVariable(config: Record<string, unknown>, path: string, value: unknown): void {
  if (path === "$agents") {
    if (!Array.isArray(value)) throw new Error(`$agents value must be an array of agent ids`);
    const agents = config.agents as Array<{ id: string }>;
    const unknown = value.filter((id) => !agents.some((a) => a.id === id));
    if (unknown.length) throw new Error(`$agents: unknown agent id(s) ${unknown.join(", ")}`);
    config.agents = (value as string[]).map((id) => agents.find((a) => a.id === id));
    return;
  }
  setAtPath(config, path.split("."), value, path);
}

function setAtPath(target: unknown, keys: string[], value: unknown, fullPath: string): void {
  const [key, ...rest] = keys;
  if (key === undefined || target === null || typeof target !== "object") {
    throw new Error(`Path "${fullPath}" does not exist in the base config`);
  }
  const container = target as Record<string, unknown>;
  if (key === "*") {
    if (!Array.isArray(target)) throw new Error(`"*" in "${fullPath}" must refer to an array`);
    if (rest.length === 0) target.forEach((_, i) => ((target as unknown[])[i] = structuredClone(value)));
    else for (const item of target) setAtPath(item, rest, value, fullPath);
    return;
  }
  if (rest.length === 0) {
    container[key] = structuredClone(value);
    return;
  }
  if (!(key in container)) throw new Error(`Path "${fullPath}" does not exist in the base config`);
  setAtPath(container[key], rest, value, fullPath);
}

/**
 * A variable's path that the validated config does not carry the value at —
 * a typo in the last segment, or a setting this configuration does not use —
 * so the zod schemas dropped (or changed) it. null when every value landed.
 * Every field the variable sets must survive exactly; fields the schemas add
 * (defaults inside a whole-object value) do not count.
 */
export function droppedVariable(raw: unknown, parsed: ExperimentConfig, variable: BatchVariable): string | null {
  if (variable.path === "$agents") return null;
  const keys = variable.path.split(".");
  const applied = valuesAtPath(raw, keys);
  const landed = valuesAtPath(parsed, keys);
  const same = landed.length === applied.length && landed.every((v, i) => carries(v, applied[i]));
  return same
    ? null
    : `"${variable.path}" is not a setting of this config — the value was dropped or changed when the config was validated (a typo, or a setting this configuration does not use)`;
}

/** Whether "landed" holds every field of "applied" unchanged (recursively); extra fields in "landed" are fine. */
function carries(landed: unknown, applied: unknown): boolean {
  if (applied === undefined) return true;
  if (applied === null || typeof applied !== "object") return canonicalJson(landed) === canonicalJson(applied);
  if (Array.isArray(applied)) {
    return Array.isArray(landed) && landed.length === applied.length && applied.every((item, i) => carries(landed[i], item));
  }
  if (landed === null || typeof landed !== "object" || Array.isArray(landed)) return false;
  return Object.entries(applied).every(([k, v]) => k in landed && carries((landed as Record<string, unknown>)[k], v));
}

function valuesAtPath(target: unknown, keys: string[]): unknown[] {
  const [key, ...rest] = keys;
  if (key === undefined) return [target];
  if (target === null || typeof target !== "object") return [undefined];
  if (key === "*") return Array.isArray(target) ? target.flatMap((item) => valuesAtPath(item, rest)) : [undefined];
  return valuesAtPath((target as Record<string, unknown>)[key], rest);
}

export function conditionConfig(base: ExperimentConfig, variables: BatchVariable[], condition: BatchCondition): unknown {
  const config = structuredClone(base) as unknown as Record<string, unknown>;
  for (const variable of variables) applyVariable(config, variable.path, condition.values[variableLabel(variable)]);
  return config;
}
