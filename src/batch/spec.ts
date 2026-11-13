import { z } from "zod";
import { canonicalJson, type ExperimentConfig } from "../experiment/config.js";
import { instantiate, type TaskFamily } from "./taskFamily.js";

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
 *   "$instance"                  — virtual: a task instance of the base config's family — an instance id, or
 *                                  { "id", "params", "seed"? } — applied first, so every other variable
 *                                  layers on top (see batch/taskFamily.ts)
 *   "$solo"                      — virtual: "full" or "public" — the proposer alone, no discussion, no vote, given
 *                                  every agent's private information or none but its own (calibration); applied last
 */
const unsafeSegments = new Set(["__proto__", "prototype", "constructor"]);
function safePath(path: string): boolean {
  return path.split(".").every((key) => key.length > 0 && !unsafeSegments.has(key));
}

export const BatchVariableSchema = z.object({
  path: z.string().min(1).refine(safePath, "Path contains an empty or unsafe segment"),
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

/** How a variable's value appears in condition keys and the CSV: an inline instance by its id, not its whole parameter set. */
export function displayValue(variable: BatchVariable, value: unknown): string {
  if (variable.path === "$instance" && value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
  return formatValue(value);
}

export function expandConditions(variables: BatchVariable[]): BatchCondition[] {
  let combos: Array<Record<string, unknown>> = [{}];
  for (const variable of variables) {
    const label = variableLabel(variable);
    combos = combos.flatMap((combo) => variable.values.map((value) => ({ ...combo, [label]: value })));
  }
  const byLabel = new Map(variables.map((v) => [variableLabel(v), v]));
  return combos.map((values) => ({
    key: Object.keys(values).length ? Object.entries(values).map(([k, v]) => `${k}=${displayValue(byLabel.get(k)!, v)}`).join(" | ") : "baseline",
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
  if (!safePath(path)) throw new Error(`Unsafe variable path "${path}"`);
  if (path === "$instance") throw new Error("$instance is applied by conditionConfig, before every other variable");
  if (path === "$solo") throw new Error("$solo is applied by conditionConfig, after every other variable");
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
  if (Array.isArray(target) && (!/^(0|[1-9]\d*)$/.test(key) || !Object.hasOwn(target, key))) {
    throw new Error(`Path "${fullPath}" must refer to an existing array index or "*"`);
  }
  if (rest.length === 0) {
    container[key] = structuredClone(value);
    return;
  }
  if (!Object.hasOwn(container, key)) throw new Error(`Path "${fullPath}" does not exist in the base config`);
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
  if (variable.path === "$agents" || variable.path === "$instance" || variable.path === "$solo") return null;
  const keys = variable.path.split(".");
  const applied = valuesAtPath(raw, keys);
  const landed = valuesAtPath(parsed, keys);
  const same = landed.length === applied.length && landed.every((v, i) => carries(v, applied[i]));
  return same || applied.every((v) => isNormalizedDefault(variable.path, v))
    ? null
    : `"${variable.path}" is not a setting of this config — the value was dropped or changed when the config was validated (a typo, or a setting this configuration does not use)`;
}

/**
 * Values the config normalizes away because they ARE the default (so they
 * hash like it): not dropped, landed as the default. A complete topology,
 * proposalRequired false.
 */
function isNormalizedDefault(path: string, value: unknown): boolean {
  const v = value as { type?: unknown; topology?: { type?: unknown } } | null | undefined;
  switch (path) {
    case "communication":
      return v?.topology?.type === "complete";
    case "communication.topology":
      return v?.type === "complete";
    case "communication.topology.type":
      return value === "complete";
    case "decision.proposalRequired":
      return value === false;
    default:
      return false;
  }
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

export function conditionConfig(
  base: ExperimentConfig,
  variables: BatchVariable[],
  condition: BatchCondition,
  families: ReadonlyMap<string, TaskFamily> = new Map()
): unknown {
  for (const variable of variables) {
    if (!safePath(variable.path)) throw new Error(`Unsafe variable path "${variable.path}"`);
  }
  // The instance first: it replaces the task, and every other variable (models, topology, …) layers on top.
  const instance = variables.find((v) => v.path === "$instance");
  const solo = variables.find((v) => v.path === "$solo");
  const config = instance ? instantiate(base, condition.values[variableLabel(instance)], families) : (structuredClone(base) as unknown as Record<string, unknown>);
  for (const variable of variables) {
    if (variable !== instance && variable !== solo) applyVariable(config, variable.path, condition.values[variableLabel(variable)]);
  }
  // Last: it removes the other agents, the discussion and the vote, whatever else was set.
  return solo ? decideAlone(config, condition.values[variableLabel(solo)]) : config;
}

/**
 * Calibration: the proposer alone, asked once, without discussion or vote.
 * "full": its private information is followed by every other agent's, each
 * under that agent's name and role — all of it, provided directly. "public":
 * its own private information only (with the shared context everyone has).
 * Everything else — task, models, evaluator — stays, so the answer is judged
 * exactly as a group's would be.
 */
export function decideAlone(config: Record<string, unknown>, value: unknown): Record<string, unknown> {
  if (value !== "full" && value !== "public") throw new Error(`$solo must be "full" or "public", not ${JSON.stringify(value)}`);
  const agents = config.agents as Array<{ id: string; name: string; role: string; privateContext?: string }>;
  const proposerId = (config.decision as { proposerId: string }).proposerId;
  const proposer = agents.find((a) => a.id === proposerId);
  if (!proposer) throw new Error(`$solo: the proposer "${proposerId}" is not among the agents`);
  const own = proposer.privateContext?.trim() ?? "";
  const others = agents
    .filter((a) => a.id !== proposerId && a.privateContext?.trim())
    .map((a) => `What ${a.name} (${a.role}) knows:\n${a.privateContext!.trim()}`);
  const privateContext = value === "full" ? [own, ...others].filter(Boolean).join("\n\n") : own;
  const next: Record<string, unknown> = {
    ...config,
    name: `${String(config.name)} · solo (${value})`,
    agents: [{ ...proposer, privateContext }],
    scheduler: { type: "round_robin" },
    discussion: { fixedRounds: 0 },
    consensus: { rule: "none" },
  };
  delete next.communication;
  delete next.randomization;
  return next;
}
