/**
 * Per-agent readiness to commit, tied to the conversation position it was
 * declared at. A declaration goes stale as soon as ANOTHER agent posts a
 * substantive (non-PASS) room message after it — so the decision phase can
 * never be entered on the strength of readiness declared before later
 * information appeared. A PASS never invalidates anyone.
 */
export type ReadinessState = "not_ready" | "ready" | "stale";

export interface AgentReadiness {
  state: ReadinessState;
  /** Room message index the declaration refers to (the last message the agent had seen, or its own message). */
  declaredAtIndex: number | null;
}

export interface ReadinessChange {
  agentId: string;
  from: ReadinessState;
  to: ReadinessState;
}

export class ReadinessTracker {
  private readonly byAgent = new Map<string, AgentReadiness>();

  constructor(private readonly agentIds: readonly string[]) {
    this.reset();
  }

  reset(): void {
    for (const id of this.agentIds) this.byAgent.set(id, { state: "not_ready", declaredAtIndex: null });
  }

  get(agentId: string): AgentReadiness {
    const entry = this.byAgent.get(agentId);
    if (!entry) throw new Error(`Unknown agent "${agentId}"`);
    return entry;
  }

  snapshot(): Record<string, AgentReadiness> {
    return Object.fromEntries([...this.byAgent].map(([id, r]) => [id, { ...r }]));
  }

  /** The agent's own latest declaration, made at room position `atIndex`. */
  declare(agentId: string, ready: boolean, atIndex: number): ReadinessChange | null {
    const current = this.get(agentId);
    const next: AgentReadiness = ready ? { state: "ready", declaredAtIndex: atIndex } : { state: "not_ready", declaredAtIndex: null };
    this.byAgent.set(agentId, next);
    return current.state !== next.state ? { agentId, from: current.state, to: next.state } : null;
  }

  /** A substantive message from `speakerId` appeared at `messageIndex`: every other ready agent that declared earlier goes stale. */
  onSubstantiveMessage(speakerId: string, messageIndex: number): ReadinessChange[] {
    const changes: ReadinessChange[] = [];
    for (const [id, r] of this.byAgent) {
      if (id === speakerId || r.state !== "ready") continue;
      if (r.declaredAtIndex !== null && r.declaredAtIndex < messageIndex) {
        this.byAgent.set(id, { state: "stale", declaredAtIndex: r.declaredAtIndex });
        changes.push({ agentId: id, from: "ready", to: "stale" });
      }
    }
    return changes;
  }

  allReady(): boolean {
    return [...this.byAgent.values()].every((r) => r.state === "ready");
  }

  /**
   * Agents whose readiness went stale while everyone else still says (or said)
   * ready — the runtime re-asks exactly these before entering the decision
   * phase. Empty unless every agent is ready or stale.
   */
  staleBlockingConsensus(): string[] {
    const entries = [...this.byAgent];
    if (!entries.every(([, r]) => r.state !== "not_ready")) return [];
    return entries.filter(([, r]) => r.state === "stale").map(([id]) => id);
  }
}
