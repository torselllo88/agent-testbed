# The experiment model

How one run proceeds: phases, turns, routing, readiness, proposal, voting,
evaluation, outcomes and limits. The design principles behind it are listed in
the [README](../README.md#core-ideas).

## Lifecycle

```
INITIALIZING → DISCUSSION → PROPOSAL → VOTING → COMMITTED → EVALUATION → FINISHED
                   ↑           │          │
                   └───────────┴──────────┘   failed attempt, attempts left
```

**Turn.** A turn is one agent activation in any phase: discussion, proposal or
vote. A PASS is a turn. A router/classifier call is **not** a turn. Turns and
public messages are counted separately. Parse retries inside one activation
belong to the same turn; a proposal re-request with schema errors fed back is a
new turn.

**Discussion** ends when:

- every agent's readiness is valid;
- `discussionTurnLimit` is reached (or `rediscussionTurnLimit` after a failed attempt);
- or the operator forces the decision.

**Readiness goes stale.** Readiness is tied to a position in the conversation.
When another agent posts a substantive, non-PASS message after a declaration,
that declaration becomes stale. The decision phase is never entered on stale
readiness. If everyone has declared ready but some declarations are stale, the
runtime re-asks exactly those agents; this is routing source
`readiness_recheck`. A re-checked agent is told why it is asked (which messages
arrived after its declaration) and that it should PASS if they do not change
its view. Without that note, live models answered every re-check with a
restated confirmation, which invalidated the others' readiness in turn and
looped until the discussion limit.

**Routing** (`hybrid`):

1. Use the explicit target named by the speaker, if it is valid.
2. Otherwise ask the LLM classifier.
3. Otherwise, or if the classifier fails, fall back deterministically to the
   agent who has waited longest.

Every decision is traced with its source and reason. A classifier outage never
ends a run. `round_robin` follows the config order and ignores targets.

**Proposal.** The configured proposer submits `{ rationale, proposal }`.
Validation checks the scenario's proposal schema only, i.e. structure. It never
checks success constraints, which would leak the evaluator. A valid proposal is
frozen into an immutable artifact with an id and a sha256 hash of its canonical
JSON, and published to the room. The proposer may decline (`proposal: null`).

**Voting.** Every agent votes on exactly that frozen artifact, blind and in
parallel against the same transcript snapshot. An unparseable vote is `INVALID`
and never counts as approval. After voting closes, rejection reasons are
published to the room for the next discussion round.

**Evaluation** runs only on a committed proposal. The evaluator is
deterministic and scenario-specific; it reports every check separately.

## Outcomes

A run ends with one outcome. Each outcome has a category and a coarse status.
The fine-grained outcome is always preserved, because a malformed proposal, a
provider outage, a failure to agree and an agreed plan that fails the evaluator
are different research results.

| Category | Outcome | Status |
|---|---|---|
| task | `SUCCESS`, `MISSION_FAILURE` | SUCCESS / FAILURE |
| coordination | `CONSENSUS_FAILURE`, `NO_PROPOSAL` | FAILURE |
| protocol | `PROPOSAL_PARSE_FAILED`, `PROPOSAL_INVALID` | FAILURE |
| budget | `TOKEN_BUDGET_EXCEEDED`, `COST_LIMIT_EXCEEDED`, `TIMEOUT`, `TURN_LIMIT_EXCEEDED` | FAILURE |
| infrastructure | `PROVIDER_ERROR`, `ERROR`, `INTERRUPTED` | ABORTED |
| operator | `STOPPED_BY_OPERATOR` | ABORTED |

Recoverable problems do not end the run. Unparseable turns, invalid votes,
router failures and schema-rejected proposals are recorded as
`protocol_incident` or `proposal_rejected_format` events.

## Limits

Soft limits (`discussionTurnLimit`, `rediscussionTurnLimit`) end a discussion
round, not the run. Hard limits (`globalTurnLimit`, `agentTokenLimit`,
`totalTokenCap`, `totalCostCapUsd`, `timeLimitSeconds`) end the run with a
budget outcome; see [configuration](configuration.md).

Token and cost limits are checked at step boundaries; an in-flight call is
never cut short for tokens. A limit can therefore be overshot by one step, and
a step is not always one call: the voting step is N parallel calls. The
overshoot is recorded in the outcome detail. The cost cap is an emergency
brake, not a guarantee: cost is known only after a call returns, so per-call
`maxOutputTokens` is what bounds the worst case. The time limit is the
exception: it also aborts an in-flight call. Only *active* time counts toward
it — operator pauses and viewer pacing are excluded
(`wall = active + paused + presentation`).

## Operator controls

**Pause** / **Resume**, **Force next turn** (while paused, exactly one more
activation), **Select next agent**, **Force decision** and **Stop**. Select,
force-decision and stop change the course of the run, so they mark it as a
*manual intervention* (`operator_intervention` with `flowAltering: true`).
Every command is recorded in the trace.
