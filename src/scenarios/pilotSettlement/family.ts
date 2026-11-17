import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { TaskFamily } from "../../batch/taskFamily.js";
import type { ExperimentConfig } from "../../experiment/config.js";
import { ADAPTER_ID, BUNDLE_DIR, publicRules } from "./adapter.js";
import { AGENT_ID, AGENTS, ROLE_DESCRIPTION, roleCard, StateSchema } from "./task.js";

/**
 * The pilot's instances — the bundle's instances/dev_instances.json (10) and
 * pilot_instances.json (40), frozen inputs — as a task family: `$instance`
 * takes an instance id (DEV-01 … P-40) or a whole instance record. Applying
 * one sets the state (evaluator params), the role cards, the speaking order
 * and the ring positions; the paired Complete run uses the same instance.
 */

export const InstanceRecordSchema = z
  .object({
    instance_id: z.string().min(1),
    state: StateSchema,
    topology_assignment: z
      .object({
        speaking_order: z.array(z.enum(AGENTS)).length(6),
        ring_positions: z.array(z.enum(AGENTS)).length(6),
      })
      .passthrough(),
  })
  .passthrough();
export type InstanceRecord = z.infer<typeof InstanceRecordSchema>;

let cached: Record<string, InstanceRecord> | null = null;
/** Every instance of the bundle by id. */
export function bundleInstances(): Record<string, InstanceRecord> {
  if (!cached) {
    cached = {};
    for (const file of ["dev_instances.json", "pilot_instances.json"]) {
      const data = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, "instances", file), "utf8")) as { instances: unknown[] };
      for (const raw of data.instances) {
        const inst = InstanceRecordSchema.parse(raw);
        cached[inst.instance_id] = inst;
      }
    }
  }
  return cached;
}

/** The config with this instance's task, roles and schedule. */
export function applyInstance(config: ExperimentConfig, raw: unknown): ExperimentConfig {
  const inst = InstanceRecordSchema.parse(raw);
  const { state } = inst;
  const order = inst.topology_assignment.speaking_order.map((r) => AGENT_ID[r]);
  const agents = config.agents.map((a) => {
    const role = AGENTS.find((r) => AGENT_ID[r] === a.id);
    if (!role) return a;
    return { ...a, name: role, role: ROLE_DESCRIPTION[role], objective: "", persona: "", systemPrompt: "", privateContext: roleCard(state, role) };
  });
  return {
    ...config,
    task: { description: `Distributed settlement decision — instance ${inst.instance_id}`, sharedContext: publicRules(state) },
    agents,
    scheduler: { type: "round_robin", order },
    evaluator: { ...config.evaluator, params: { instanceId: inst.instance_id, state } },
    protocol: {
      adapter: ADAPTER_ID,
      replicate: config.protocol?.replicate ?? 0,
      params: {
        ...(config.protocol?.params ?? {}),
        instanceId: inst.instance_id,
        ringPositions: inst.topology_assignment.ring_positions,
        speakingOrder: inst.topology_assignment.speaking_order,
      },
    },
  };
}

export const pilotSettlementFamily: TaskFamily = {
  evaluatorId: "pilot-settlement",
  get instances() {
    return Object.fromEntries(Object.entries(bundleInstances()).map(([id, inst]) => [id, { params: inst }]));
  },
  apply: applyInstance,
  // After the batch's other variables: a ring without an explicit arrangement takes the instance's ring positions.
  finalize(raw, params) {
    const inst = InstanceRecordSchema.parse(params);
    const communication = raw.communication as { topology?: { type?: string; order?: unknown } } | undefined;
    if (communication?.topology?.type === "ring" && communication.topology.order === undefined) {
      communication.topology.order = inst.topology_assignment.ring_positions.map((r) => AGENT_ID[r]);
    }
  },
};
