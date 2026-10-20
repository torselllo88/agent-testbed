import { EventType, type ExperimentEvent } from "./events.js";

/**
 * Structural communication metrics — who addressed whom, how evenly the
 * agents took part, whether an addressed agent answered, how long it took to
 * get to a decision. Derived only from events every run already records (turn
 * metadata, room messages, phase changes), so they are deterministic and
 * scenario-neutral. They say nothing about WHAT was communicated: which facts
 * reached the group is a scenario-specific (or semantic) question for later.
 */
export interface CommunicationMetrics {
  /** Discussion messages (non-PASS turns) with a valid target / addressed to nobody in particular. */
  addressed: number;
  broadcast: number;
  /** addressed / (addressed + broadcast); null without messages. */
  addressedShare: number | null;
  /** Directed addressing counts, "a->b": how often a addressed b (the observed interaction graph). */
  edges: Record<string, number>;
  /** Per agent: how many different agents it addressed. */
  peersAddressed: Record<string, number>;
  /**
   * Density of the OBSERVED addressing graph: directed pairs used / all possible
   * (n·(n−1)); null with fewer than two agents. Not the density of a configured
   * communication topology (that would be topologyDensity).
   */
  interactionDensity: number | null;
  /** Share of used directed addressing pairs whose reverse was used too; null when none was used. */
  interactionReciprocity: number | null;
  /**
   * What followed an explicit address (the speaker's "target"). Agents have no
   * "in reply to" field, so this records only that the addressee spoke — not
   * that it answered: deterministic, no reading of the text.
   */
  responses: {
    /** Addressed messages. */
    addressed: number;
    /** …after which the addressee posted the very next discussion message (the next discussion turn was its own, not a PASS). */
    addresseeSpokeNext: number;
    /**
     * …after which the addressee posted a message at any later discussion turn of
     * the run — in any discussion segment, including after a rejected proposal.
     * PASS turns do not count; proposal and vote turns are not discussion turns.
     */
    addresseeSpokeLater: number;
    /** Mean number of discussion turns from the address until the addressee's next message (over those where it spoke). */
    meanTurnsUntilAddresseeSpeaks: number | null;
  };
  participation: {
    /** Shannon entropy of the agents' shares of discussion messages, normalized to 0..1 (1 = perfectly even). */
    evenness: number | null;
    /** Gini coefficient of messages per agent (0 = even, → 1 = one agent did all the talking). */
    gini: number | null;
    /** Agents that posted no discussion message. */
    silentAgents: number;
  };
  timeline: {
    /** Discussion turns until the first time every agent's readiness was valid (null: never). */
    discussionTurnsToAllReady: number | null;
    /** All turns before the first proposal was requested (null: none was). */
    turnsToFirstProposal: number | null;
    /** Discussion segments: 1, plus one per return to discussion after a failed attempt. */
    discussionSegments: number;
  };
}

interface DiscussionTurn {
  agentId: string;
  pass: boolean;
  target: string | null;
}

export function communicationMetrics(events: ExperimentEvent[]): CommunicationMetrics {
  const started = events.find((e) => e.type === EventType.EXPERIMENT_STARTED);
  const agents = ((started?.payload.agents as Array<{ id: string }> | undefined) ?? []).map((a) => a.id);
  const known = new Set(agents);

  const turns: DiscussionTurn[] = [];
  let turnsSoFar = 0;
  let turnsToFirstProposal: number | null = null;
  let discussionTurnsToAllReady: number | null = null;
  let discussionSegments = 0;
  for (const e of events) {
    if (e.type === EventType.TURN_STARTED) turnsSoFar += 1;
    else if (e.type === EventType.AGENT_META && e.agentId) {
      const target = typeof e.payload.target === "string" && known.has(e.payload.target) && e.payload.target !== e.agentId ? e.payload.target : null;
      turns.push({ agentId: e.agentId, pass: e.payload.pass === true, target });
    } else if (e.type === EventType.PROPOSAL_REQUESTED && turnsToFirstProposal === null) {
      turnsToFirstProposal = turnsSoFar;
    } else if (e.type === EventType.PHASE_CHANGED) {
      if (e.payload.to === "DISCUSSION") discussionSegments += 1;
      if (e.payload.discussionEnd === "all_ready" && discussionTurnsToAllReady === null) discussionTurnsToAllReady = turns.length;
    }
  }

  const messages = turns.filter((t) => !t.pass);
  const addressedMessages = messages.filter((t) => t.target !== null);
  const edges: Record<string, number> = {};
  const peers = new Map<string, Set<string>>(agents.map((a) => [a, new Set<string>()]));
  for (const t of addressedMessages) {
    const key = `${t.agentId}->${t.target}`;
    edges[key] = (edges[key] ?? 0) + 1;
    peers.get(t.agentId)?.add(t.target!);
  }
  const usedPairs = Object.keys(edges);
  const reciprocated = usedPairs.filter((key) => {
    const [a, b] = key.split("->");
    return `${b}->${a}` in edges;
  }).length;

  // After a addresses b at discussion turn i: b's next message at a turn j > i.
  let addresseeSpokeNext = 0;
  let addresseeSpokeLater = 0;
  const gaps: number[] = [];
  turns.forEach((t, i) => {
    if (t.pass || !t.target) return;
    const j = turns.findIndex((u, k) => k > i && u.agentId === t.target && !u.pass);
    if (j < 0) return;
    addresseeSpokeLater += 1;
    gaps.push(j - i);
    if (j === i + 1) addresseeSpokeNext += 1;
  });

  const counts = agents.map((a) => messages.filter((t) => t.agentId === a).length);
  const total = counts.reduce((s, c) => s + c, 0);
  const n = agents.length;
  const evenness =
    total === 0 || n < 2
      ? null
      : -counts.filter((c) => c > 0).reduce((s, c) => s + (c / total) * Math.log(c / total), 0) / Math.log(n);
  const gini =
    total === 0 || n < 2
      ? null
      : counts.reduce((s, a) => s + counts.reduce((t, b) => t + Math.abs(a - b), 0), 0) / (2 * n * n * (total / n));

  return {
    addressed: addressedMessages.length,
    broadcast: messages.length - addressedMessages.length,
    addressedShare: messages.length ? addressedMessages.length / messages.length : null,
    edges,
    peersAddressed: Object.fromEntries([...peers].map(([a, set]) => [a, set.size])),
    interactionDensity: n >= 2 ? usedPairs.length / (n * (n - 1)) : null,
    interactionReciprocity: usedPairs.length ? reciprocated / usedPairs.length : null,
    responses: {
      addressed: addressedMessages.length,
      addresseeSpokeNext,
      addresseeSpokeLater,
      meanTurnsUntilAddresseeSpeaks: gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : null,
    },
    participation: { evenness, gini, silentAgents: counts.filter((c) => c === 0).length },
    timeline: { discussionTurnsToAllReady, turnsToFirstProposal, discussionSegments },
  };
}
