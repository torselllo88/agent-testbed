# People in the room: spectators and debrief

A room can have people in it: in a live demo they type while the agents work.
The testbed's answer is conservative. **Humans never take part in an active
experiment.** What they can do is set by `humanInteraction.profile`:

| Profile | During the run | After the outcome |
| --- | --- | --- |
| `OBSERVE` (default when absent) | spectator chat | spectator chat |
| `DEBRIEF` (Station Kestrel) | spectator chat | a separate **debrief session**: people question the characters |
| `ADVISORY`, `TAKE_ROLE` | *not implemented*; refused before a run exists | |

People reach the room through the testbed's own viewer, or through an
external chat room via the [External Room API](external-room-api.md). While an
experiment is bound to an open external room, the room is the only place to
talk to it: the local viewer only watches (`409 EXTERNAL_ROOM_ACTIVE`).

## During the run

A human message is recorded and shown to other people in the room, and nothing
else. It never enters an agent's prompt, readiness, routing, turns, proposal,
votes, evaluator, budget or the experiment trace. Text that looks like a
command ("STOP", "/force-decision") is just chat: operator controls exist only
as API/UI actions. So that nobody thinks the system is broken, one localized
notice explains that the crew will be available after the mission. It goes out
at most once per person, and not within 30 s of the previous one: that one is
on screen for everyone. Messages written during the mission are **not** queued
for the debrief.

## The debrief

The debrief opens automatically after the ending narration, as its own event
(`debrief_started`) and a visible notice. It is never a continuation of the
runner: the outcome, metrics, proposal, votes and evaluation are frozen. No
debrief opens automatically after an operator stop or an interrupted run, or
when the run's external room binding is closed.

- **Queue.** Several people may ask. Questions form one FIFO queue and are
  answered **strictly one at a time**, one character per question, with at
  most one LLM call in flight. When something is already in progress, the
  asker is told their question is queued (with position).
- **Who answers.** In order:
  1. an explicit reply to a character's message;
  2. an explicit mention;
  3. a character's name in the text, as a whole word or phrase — the name, its
     words and its localized labels, plus the scenario's
     `humanInteraction.aliases` (Kestrel lists the Russian case forms:
     *Виктору*, *Саре*). No stems or prefixes, so *maybe* is not Maya and
     *майор* not Майя;
  4. the debrief's own router model (`debrief.router`, independent of the
     experiment's scheduler), if confident. Scenarios saved before the field
     existed still use their scheduler's classifier, marked "legacy" in the
     routing decision; an explicit `null` means no router;
  5. the scenario's `debrief.defaultAgentId` (Kestrel: Sarah), else the proposer.
- **Perspective.** A character answers with its own model from the run
  (`debrief.maxOutputTokens` caps the answer). It gets its persona and role,
  **its own** private information and votes, the public transcript, the
  committed decision, the outcome as announced, and the debrief so far. It
  does **not** get another character's unrevealed private context. The
  evaluator's check results are included only with `debrief.revealEvaluation`,
  because they can reveal facts only another character knew. The prompt states
  that the session is recorded history that cannot be rewritten, and that
  hindsight should be marked as hindsight.
- **Limits.** `maxPendingPerUser` (default 3) and `maxPendingTotal` (20)
  reject extra questions with a deterministic notice, rate-limited per
  person. `costCapUsd` closes the session once reached. It is idle-closed
  after `idleTimeoutMinutes` (15).
- **Separate accounting.** Debrief tokens, cost and LLM calls are counted per
  session, never in experiment metrics: a run still says "17 turns, $0.18,
  SUCCESS" however long people talk to the crew afterwards. Debrief requests
  have their own provider slots (`LLM_MAX_CONCURRENT_DEBRIEF_REQUESTS`), so
  they never delay a running experiment.
- **Lifecycle.** An operator can close a session, and can open a **new** one
  on a finished run (for an externally bound run, only while its binding is
  still the latest open one of its room). Closed and interrupted sessions are
  immutable history. On server restart an open session becomes `INTERRUPTED`,
  and its unanswered questions are marked failed. Nothing is replayed. Batch
  runs never open a debrief. Only new text messages count: edits, reactions
  and attachments are ignored.

## Persistence and notices

Everything is persisted outside the experiment, cross-referenced by
experiment id: `debrief_sessions` holds status, usage and who opened each
session; `interaction_events` holds human messages, notices, queueing, routing
decisions, every debrief LLM call with its prompt, answers and failures. The
experiment page shows these derived counts separately, under *People in the
room*: spectator messages (with "human assistance: none"), sessions with
their usage, and the debrief conversation.

The stub characters' debrief answers are canned, one line per officer; real
answers need real models.

Notice texts have built-in en/ru defaults. A scenario can override any of them
in `presentation.strings.<lang>.interaction`; Kestrel's are crew-voiced.
