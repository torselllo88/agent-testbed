import { createHash } from "node:crypto";
import type { ExperimentConfig } from "./config.js";

/**
 * Who speaks when, and who hears whom — resolved once from a config.
 *
 * - The SPEAKING ORDER is the round-robin rotation: explicit
 *   (scheduler.order), drawn from randomization.seed, or the agents in config
 *   order — starting at scheduler.startAgentId when one is set.
 * - The COMMUNICATION GRAPH decides who receives a discussion message:
 *   everyone (complete — the default), the two ring neighbours, or the
 *   configured edges. Undirected: a hears b exactly when b hears a.
 *
 * Pure and deterministic: the runner and the prompt renderer both call it,
 * so what an agent is told about its neighbours is always what the runner
 * delivers. A seed is drawn into orders with a fixed procedure (sha256 →
 * mulberry32 → Fisher–Yates; pinned by a test), separately for the speaking
 * order and the ring — so two conditions with one seed share the speaking
 * order whatever their topology (paired designs), and the resolved orders are
 * recorded on experiment_started anyway.
 */
export type TopologyType = "complete" | "ring" | "edges";

export interface Layout {
  topology: TopologyType;
  /** Round-robin rotation, first speaker first; null for schedulers without a fixed rotation (hybrid). */
  speakingOrder: string[] | null;
  /** The ring's arrangement (each agent sits between its neighbours, cyclically); null unless the topology is a ring. */
  ring: string[] | null;
  /** Each agent's neighbours; null = complete (everyone hears everyone). */
  neighbours: Record<string, string[]> | null;
  /** The seed the orders were drawn from; null when nothing was drawn. */
  seed: number | null;
}

const cache = new WeakMap<ExperimentConfig, Layout>();

export function resolveLayout(config: ExperimentConfig): Layout {
  let layout = cache.get(config);
  if (!layout) cache.set(config, (layout = computeLayout(config)));
  return layout;
}

function computeLayout(config: ExperimentConfig): Layout {
  const ids = config.agents.map((a) => a.id);
  const random = config.randomization;
  const topology = config.communication?.topology ?? { type: "complete" as const };

  const speakingOrder = config.scheduler.type === "round_robin" ? rotation(config) : null;

  let ring: string[] | null = null;
  let neighbours: Record<string, string[]> | null = null;
  if (topology.type === "ring") {
    ring = random?.ring ? seededShuffle(ids, random.seed, "ring") : (topology.order ?? ids);
    neighbours = Object.fromEntries(ring.map((id, i) => [id, [ring![(i - 1 + ring!.length) % ring!.length]!, ring![(i + 1) % ring!.length]!]]));
  } else if (topology.type === "edges") {
    neighbours = Object.fromEntries(ids.map((id) => [id, [] as string[]]));
    for (const [a, b] of topology.edges) {
      neighbours[a]!.push(b);
      neighbours[b]!.push(a);
    }
    // In config order, so the prompt lists neighbours the same way however the edges were written.
    for (const id of ids) neighbours[id]!.sort((x, y) => ids.indexOf(x) - ids.indexOf(y));
  }

  const drew = random !== undefined && ((random.speakingOrder && speakingOrder !== null) || (random.ring && ring !== null));
  return { topology: topology.type, speakingOrder, ring, neighbours, seed: drew ? random!.seed : null };
}

/**
 * The round-robin rotation of a config, first speaker first: drawn from
 * randomization.seed, or scheduler.order (else config order) starting at
 * startAgentId (else its first entry).
 */
export function rotation(config: ExperimentConfig): string[] {
  const ids = config.agents.map((a) => a.id);
  const random = config.randomization;
  if (random?.speakingOrder && config.scheduler.type === "round_robin") return seededShuffle(ids, random.seed, "speaking-order");
  const base = (config.scheduler.type === "round_robin" ? config.scheduler.order : undefined) ?? ids;
  const at = Math.max(0, base.indexOf(config.scheduler.startAgentId ?? base[0]!));
  return [...base.slice(at), ...base.slice(0, at)];
}

/** Who receives a discussion message of `senderId`: the sender and its neighbours — null for everyone. */
export function audienceOf(layout: Layout, senderId: string): string[] | null {
  if (!layout.neighbours) return null;
  return [senderId, ...(layout.neighbours[senderId] ?? [])];
}

/** Whether `listenerId` receives what `senderId` posts (itself included). */
export function hears(layout: Layout, listenerId: string, senderId: string): boolean {
  return !layout.neighbours || listenerId === senderId || (layout.neighbours[senderId] ?? []).includes(listenerId);
}

/** Configured undirected edges over all possible pairs (complete: 1). */
export function topologyDensity(layout: Layout, agentCount: number): number {
  if (!layout.neighbours) return 1;
  const pairs = (agentCount * (agentCount - 1)) / 2;
  const edges = Object.values(layout.neighbours).reduce((s, n) => s + n.length, 0) / 2;
  return pairs ? edges / pairs : 0;
}

export interface ReachArrival {
  /** Discussion turn (1-based, within the segment) after which the target could hold the source's information. */
  turn: number;
  /** The round of that turn. */
  round: number;
}

/**
 * Temporal reachability under the fixed speaking schedule: if every agent
 * passed on everything it had heard at each of its turns (perfect relay),
 * from which discussion turn on could `targetId` hold each other agent's
 * information? Null for a source whose information cannot arrive within
 * `rounds` rounds. A structural path only counts when each relay speaks AFTER
 * it received — the order matters, not only the graph. An upper bound on
 * what agents actually achieve; it says nothing about what they do.
 */
export function temporalReach(layout: Layout, agentIds: string[], targetId: string, rounds: number): Record<string, ReachArrival | null> {
  const order = layout.speakingOrder;
  if (!order) throw new Error("temporal reach needs a fixed speaking order");
  const known = new Map(agentIds.map((id) => [id, new Set([id])]));
  const arrival = new Map<string, ReachArrival>();
  let turn = 0;
  for (let round = 1; round <= rounds; round++) {
    for (const speaker of order) {
      turn += 1;
      const recipients = layout.neighbours ? (layout.neighbours[speaker] ?? []) : agentIds.filter((id) => id !== speaker);
      const carried = [...known.get(speaker)!];
      for (const recipient of recipients) {
        const set = known.get(recipient)!;
        for (const source of carried) {
          if (set.has(source)) continue;
          set.add(source);
          if (recipient === targetId && !arrival.has(source)) arrival.set(source, { turn, round });
        }
      }
    }
  }
  return Object.fromEntries(agentIds.filter((id) => id !== targetId).map((id) => [id, arrival.get(id) ?? null]));
}

/** Fisher–Yates over a copy, driven by mulberry32 seeded from sha256(`${seed}:${label}`). */
export function seededShuffle<T>(items: readonly T[], seed: number, label: string): T[] {
  const next = mulberry32(createHash("sha256").update(`${seed}:${label}`).digest().readUInt32BE(0));
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function mulberry32(state: number): () => number {
  let a = state >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
