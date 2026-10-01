# Station Kestrel

`station-kestrel` runs the same Space Station task as the
[benchmark](space-station.md): the same shared facts, roles, objectives,
private information, decision rules and evaluator, and therefore the same
`taskDefinitionHash`. It is a *different experimental condition*: persona,
speech style and language change behavior (and `configHash`). On top of the
task it adds a behavior and presentation layer built from the generic
[building blocks](README.md#building-blocks).

## Crew and speech

- **Named officers with personas:** Sarah Okafor (commander, the proposer),
  John Mercer (reactor, impatient under pressure), Viktor Hale (power, fast and
  overconfident), Maya Chen (life support, protective of the crew), with light
  interpersonal priors. A persona shapes how an agent talks, never what it
  knows. Nothing steers the room toward success: a believable coordination
  failure is as valid an ending as a rescue.
- **Spoken, short dialogue.** A shared speech style in each officer's
  `systemPrompt`: one point per turn, usually one or two short sentences, no
  restating, no politeness formulas. An officer PASSes instead of repeating a
  point or question that has already been answered; this is scoped to the
  mission discussion, because the same prompt also reaches the debrief, where
  there is no PASS. Officers talk about what should be done instead of
  reporting actions as done before the vote, so the ending's "Decision locked —
  executing" is the moment things happen. The personas give each character a
  concrete reason to push back.

## Presentation

- **A narrator** (MISSION CONTROL): the opening, a few observer-only
  escalation beats during the run, and an ending revealed step by step (vote
  tally → procedure starts → grounded result).
- **Viewer pacing:** 2 s + 10 ms per character of the previous message, capped
  at 6 s, and 2.5 s between the parts of the ending. A 20-turn discussion limit
  (short turns need more of them) and 300 output tokens per turn (a safety cap;
  brevity comes from the prompt, because a lower cap would truncate the
  proposal JSON, not the prose). A demo should not run long: v1's 2.5 s /
  20 ms / 9 s made a verbose live run take about 5 minutes. Tune these by
  watching real runs.
- **Languages:** narration, viewer labels and room notices are authored in
  `en` and `ru`.
- **Debrief:** profile `DEBRIEF` — after the ending, people can question the
  officers ([people in the room](../people-in-the-room.md)). Sarah answers
  questions put to the crew in general. Keyless runs route unaddressed
  questions by subject keywords (`space-station/debrief-router`); with real
  models, point `debrief.router` at a cheap model. `humanInteraction.aliases`
  lists the Russian case forms of the officers' names (*Виктору*, *Саре*).

## Versions

| Version | Change |
|---|---|
| v1 | initial |
| v2 | shorter demo (discussion 16 turns, `maxOutputTokens` 300, pacing 2000/10/6000), localized viewer labels for agents, human-readable proposal rendering |
| v3 | human interaction profile `DEBRIEF` (crew debrief after the mission), crew-voiced room notices |
| v4 | dramaturgy pass: short spoken dialogue (shared speech style), sharper personas, discussion 20 turns, observer-only escalation beats, the ending revealed as a paced sequence with the vote tally |
| v5 | speech style asks to PASS rather than repeat a point or question already answered, and to discuss what to do rather than report actions as done before the vote |
| v6 | the debrief has its own router model (`humanInteraction.debrief.router`) instead of borrowing the scheduler's |
| v7 | name aliases for the debrief (`humanInteraction.aliases`: Russian case forms); whole-word keyword routing |
