import { z } from "zod";
import type { ExperimentConfig } from "../experiment/config.js";

/**
 * A task family: many instances of one task, each a parameter set of the
 * scenario's evaluator. Applying an instance to a config replaces what defines
 * the task — shared facts, each agent's role, objective and private
 * information, the evaluator's parameters — and keeps everything else (models,
 * protocol, topology, limits). So a batch can vary the instance like any other
 * variable (`$instance`), on a builtin or on a saved copy of one.
 *
 * An instance may carry a seed: the batch then sets randomization.seed from it,
 * so every condition of that instance draws the same speaking order and ring —
 * conditions are paired within an instance.
 */
export interface TaskInstance {
  id: string;
  params: unknown;
  seed?: number;
}

export interface TaskFamily {
  /** The evaluator whose parameters an instance is (configs are matched to families by evaluator.id). */
  evaluatorId: string;
  /** Named instances, e.g. development and pilot sets. */
  instances: Record<string, Omit<TaskInstance, "id">>;
  /** The config with this instance's task; throws on invalid parameters. */
  apply(config: ExperimentConfig, params: unknown): ExperimentConfig;
}

/** An instance written into a batch spec instead of named. */
export const InlineInstanceSchema = z
  .object({
    id: z.string().min(1),
    params: z.unknown(),
    seed: z.number().int().min(0).optional(),
  })
  .strict();

/**
 * The raw config of one instance, from a `$instance` value — an instance id
 * of the config's family, or an inline instance. Name gets the instance id;
 * randomization.seed the instance's seed, when it has one.
 */
export function instantiate(config: ExperimentConfig, value: unknown, families: ReadonlyMap<string, TaskFamily>): Record<string, unknown> {
  const family = families.get(config.evaluator.id);
  if (!family) throw new Error(`$instance: the evaluator "${config.evaluator.id}" has no task family — its scenario defines no instances`);
  let instance: TaskInstance;
  if (typeof value === "string") {
    const entry = family.instances[value];
    if (!entry) throw new Error(`$instance: unknown instance "${value}" (known: ${Object.keys(family.instances).join(", ") || "none"})`);
    instance = { id: value, ...entry };
  } else {
    const parsed = InlineInstanceSchema.safeParse(value);
    if (!parsed.success) throw new Error(`$instance: an inline instance is { "id": "…", "params": {…}, "seed"?: n } — ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    instance = { ...parsed.data, params: parsed.data.params };
  }
  let applied: ExperimentConfig;
  try {
    applied = family.apply(config, instance.params);
  } catch (err) {
    const detail = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err);
    throw new Error(`$instance "${instance.id}": invalid parameters — ${detail}`);
  }
  const raw = structuredClone(applied) as unknown as Record<string, unknown>;
  raw.name = `${config.name} · ${instance.id}`;
  if (instance.seed !== undefined) raw.randomization = { ...((raw.randomization as Record<string, unknown> | undefined) ?? {}), seed: instance.seed };
  return raw;
}
