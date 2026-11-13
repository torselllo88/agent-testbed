# Design sketch: communication topology

*Status: v1 implemented — static undirected graphs (complete, ring, edges),
sequential round-robin turns, one decision, the two channels below, audience
in the trace, per-agent views, a canonical default, topology metrics, temporal
reach, and paired randomization of speaking order and ring. Usage:
[configuration](../configuration.md#communication-topology). Not implemented:
directed graphs, the topology-aware router, point-to-point messages, network
knowledge as a variable, dynamic graphs, simultaneous rounds, local decisions.
Level 2 (fact propagation) needs a scenario's fact list and a detector — next.*

## Goal

Make **who can hear whom in discussion** an experimental variable. Today every
run is a complete graph: all agents share one room and every message reaches
everyone. The aim is to compare, on the same task with the same models and the
same distribution of private facts, how the structure of communication — a
star around a coordinator, a ring, a hierarchy, clusters — affects whether
critical facts reach the group, how consensus forms, and whether the decision
is correct.

## Scope of a first version (v1)

- A **static** communication graph per run, directed or undirected.
- The current **sequential** conversation: one speaker per turn.
- **One collective decision** per run, as today (proposal → blind vote →
  evaluation).
- **Backward compatibility:** `complete` is the default and reproduces today's
  runs exactly — prompts and protocol fingerprint (see *Compatibility*).

Out of v1 (see *Open questions*): topologies that change during a run, private
point-to-point channels, simultaneous rounds for large groups, local decisions
within subgroups, and varying what agents know about the network.

## Model: two channels

**Topology constrains agent-to-agent discussion. The collective decision
protocol is a separate, global coordination channel** — and what it may carry
is stated explicitly, because anything it carries bypasses the graph.

Let *G* be a graph over agent ids. When agent *a* speaks in discussion, the
message is delivered to *a* and to *a*'s out-neighbours in *G*.

| What | Channel | Why |
|---|---|---|
| Discussion messages | **graph**: the sender and its out-neighbours | the experimental variable |
| The proposal itself (the structured decision every agent votes on) | **global** | a vote needs the object voted on |
| Vote request; aggregate vote outcome ("2 of 4 approved; unanimity required"); protocol state | **global** | coordination, no task content |
| The proposer's free-text **rationale** | **graph**: the proposer's out-neighbours | free text can carry facts |
| Free-text **vote reasons** and rejection explanations | **graph**: each voter's out-neighbours | same — e.g. *"cut comms only after the beacon is on battery"* would otherwise reach agents who could never hear its author |
| Narration, spectators, debrief | unaffected: observers only, never agents | — |

**The proposal itself is information, too.** A structured proposal such as
`{ "actions": ["switch_beacon_to_battery", "shutdown_external_communications", …] }`
tells every agent something it may never have heard along the graph. With one
global decision this is unavoidable: every voter must see the object of the
vote. So, stated plainly: *topology constrains information flow during
discussion before a proposal. After a rejected proposal, agents keep whatever
the proposal exposed* — rediscussion happens on a partly "pierced" topology.
Results therefore separate:

- **first-proposal correctness** — the evaluator applied to the first frozen
  proposal, whether or not it was committed. Today only a committed proposal
  is evaluated; evaluating every frozen proposal is a small, deterministic
  addition, recorded as a metric, never as the outcome;
- **pre-proposal information coverage** — what reached whom before the first
  proposal (Level 2, see *Measurements*);
- **final outcome after rediscussion** — the run's outcome as today.

Final success alone must not be read as a pure effect of the graph.

This differs from today's complete-graph runs, where the "submitted" notice
includes the rationale and the "not approved" notice lists everyone's reasons
to everyone. Under `complete` the result is the same, because everyone is
everyone's neighbour. Under any other topology, a global channel carrying free
text would turn, say, *ring vs. star* into *ring until the first failed
attempt, after which the moderator hands everyone the missing facts*.

## Messages: one canonical identity, filtered views

Every message keeps one **global** identity — message id, global sequence
number — and gains an **audience** (the agents it was delivered to). Trace,
replay, reply mapping, routing and readiness bookkeeping all use the global
identity.

An agent's prompt shows its **view**: the messages whose audience includes it,
numbered by position in that view. The local number is a derived
presentation; no protocol logic refers to it. Prompt text that mentions
message numbers — today, the readiness re-check note ("#3–#5 arrived after
your declaration") — uses the agent's local numbers, because those are the
only ones it sees.

## Scheduling and routing

A router that reads every agent's messages knows more than any participant.
Even without solving the task, it can call on the agent for whom a fact it
alone has seen matters. That makes it a hidden central coordinator — a
confound for topology experiments. So:

- **Default for topology runs: content-blind turn order** (round-robin).
- **Topology-aware router (option):** it sees only what the current speaker
  sees, and an explicit `target` must follow one of the speaker's out-edges. A
  target outside the graph is a protocol incident, like an invalid target
  today.
- **Omniscient central router:** a separate, explicitly named condition — an
  interesting one to study, never a silent default.

## What changes, layer by layer

| Layer | Today | With a topology |
|---|---|---|
| Room history | one transcript, the same for every agent | one view per agent, filtered by audience over global ids |
| Agent prompt | "Everything you post is visible to every participant"; the full roster | the full roster, plus the agent's own neighbourhood: **"your messages reach: …"** and **"you hear: …"** (two lists, so directed graphs are unambiguous) |
| Readiness | goes stale when any agent posts new information | goes stale when new information enters *this agent's* view |
| Scheduling | hybrid router sees the public room | content-blind by default; topology-aware router as an option (see above) |
| Proposal | the proposer sees the whole room | the proposer sees its own view; the proposal goes to everyone, the rationale along the graph |
| Voting | every voter on one transcript snapshot | every voter on its own view; reasons along the graph, the aggregate outcome to everyone |
| Trace | `message_posted` with sender, global id and index | plus the **audience** — without it a run is not reproducible and edges cannot be measured |
| Debrief | a character answers from the public transcript | from the character's own view |

The runner's lifecycle, the decision rule, evaluators, LLM calls, budgets and
the add-on layers stay as they are.

## Configuration (draft)

```jsonc
"communication": {
  "topology": {
    "type": "complete",              // "complete" | "ring" | "star" | "edges"
    "center": "operations",          // star only
    "edges": [["operations", "power"], ["power", "engineering"]],  // edges only
    "directed": false
  }
}
```

In v1 every agent knows the full roster and its own neighbourhood. *What
agents know about the network* is a separate experimental variable for later
(`networkKnowledge: full | local | none`). It stays out of v1, so a first
*complete vs. ring vs. star* comparison changes only how information can
travel, not the participants' picture of the network.

The topology is part of the experiment configuration, and therefore of
`configHash`. It is not part of `taskDefinitionHash`: like the scheduler, it
changes *how* the task is attempted, not the task. Batches can vary it like
any field (`communication.topology.type`).

**Canonical default.** A config without a `communication` block and one with
`"topology": { "type": "complete" }` are the same experimental condition, and
must hash the same. So the default is *not* filled into the stored config (no
schema `.default()`); an explicit complete topology with nothing else set is
normalized away when the config is parsed. Every existing `configHash` stays
unchanged (pinned by a test — e.g. the benchmark's `6fc29476…`). This is the
same principle as evaluator parameters, where `{}` and every default written
out are already one configuration.

## Compatibility

**Prompts.** With `complete` (the default), every prompt and every transcript
stays byte-for-byte identical to today's. A test pins this.

**Config hash.** Absent and explicit `complete` normalize to the same stored
config, so existing `configHash`es do not change (see *Configuration*).

**Protocol fingerprint.** Today `protocolFingerprint` is one hash over all
rendered protocol templates. Adding topology templates to it would change the
fingerprint of *every* run, including complete-graph runs whose prompts did not
change — a false "different protocol" signal. So the fingerprint becomes
**per protocol variant**: it hashes the templates of the branches a run
actually uses. A complete-graph run hashes exactly today's set, so its
fingerprint stays `8a715c5c37ce5c46` (pinned by a test). A topology run hashes
that set plus the topology texts. This change is a precondition of v1 and
lands before the first topology text.

## Measurements

**Level 1 — structural, deterministic** (built on the communication metrics
that already exist):

- *Who addressed whom and what followed* (exists): addressed share, the
  observed interaction graph, `interactionDensity`, `interactionReciprocity`,
  whether the addressee spoke next and `meanTurnsUntilAddresseeSpeaks`,
  participation evenness (normalized entropy) and Gini, time to decision.
- *Decision* (new): first-proposal correctness, next to the final outcome
  (see *Model*).
- *Topology* (new): `topologyDensity` of the configured graph — distinct from
  the observed `interactionDensity`; **edge utilization** (messages per
  configured edge, unused edges); **direct delivery reach** (how many agents
  received each message).

**Level 2 — fact propagation** (needs scenario-defined fact detectors): which
private facts reached whom, and by what path and after how many hops —
reported separately for *before the first proposal* (pure topology) and after
it (when the proposal itself has spread information).
Structurally we cannot tell whether *b* relayed what *a* said or said
something similar independently, so path length and relayed reach belong
here, not in Level 1.

## Open questions (to settle with the research partners)

1. **Sequential or simultaneous?** Sequential turn-taking fits up to roughly
   15 agents and the current runner. For dozens or hundreds of agents,
   synchronous rounds — every agent acts on its local view at once, as in
   information-diffusion models — fit better. That is a new scheduling model
   in the core, not a setting.
2. **One global decision or local ones?** Who proposes, who votes, and can
   disconnected or loosely connected groups decide separately?
3. **What may the global channel carry** beyond the minimum above, e.g. a
   moderator summary as an explicit condition?
4. **Point-to-point messages** in addition to neighbourhood broadcast?
5. **Network knowledge** as a variable: full, local or none?
6. **Static or dynamic graphs** — edges that appear or disappear on events, or
   every round?
7. **Directed edges** (a hears b, b does not hear a) — needed for hierarchies?
8. **Router conditions** to compare: content-blind, topology-aware,
   omniscient?
9. **Group sizes and the topologies to compare first.**

## Rough effort

| Step | Core change | Size |
|---|---|---|
| Fingerprint per protocol variant (precondition) | yes, small | small |
| v1: static graph, sequential, one decision, two channels, audience in the trace, content-blind default, canonical default (hash-stable), topology metrics, first-proposal correctness | yes, backward compatible | medium |
| Topology-aware router | yes (router view and target rules) | small on top of v1 |
| Point-to-point channels | yes (a message can name its audience) | small–medium on top of v1 |
| Network knowledge as a variable | yes (prompt variants) | small |
| Dynamic topology | yes (topology as a function of run state) | medium |
| Synchronous rounds for large groups | yes (new scheduler / turn model) | medium–large |
| Local decisions in subgroups | yes (decision protocol) | large; depends on the research design |
