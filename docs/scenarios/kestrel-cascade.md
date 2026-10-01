# Station Kestrel: Cascade

`station-kestrel-cascade` is a harder scenario with the same crew, personas,
speech style, narrator, pacing and debrief as [Station Kestrel](kestrel.md).
It is a *different task* (its own facts, evaluator `kestrel-cascade` and
`taskDefinitionHash`), built so that no single officer can find the safe
procedure alone.

## Task

Two recovery paths look plausible, and the facts that decide between them are
split up:

| Officer | Holds |
|---|---|
| John (engineering) | Loop B needs 30 kW; thermal dump C needs only 18 kW but vents through service ring R3, which must be evacuated and isolated first; the reactor window is about 4 minutes |
| Viktor (power) | 10 kW reserve + 12 labs = 22 kW, enough for C; loop B also needs communications (8 kW), and cutting them powers down the service craft's approach beacon |
| Maya (life support) | Six crew in R3; evacuating them takes about 6 minutes |
| Sarah (operations) | The beacon has an emergency battery, safe only if it is switched over *before* comms go off |

Only when these facts are combined does it become clear that C cannot be made
safe in time (6 min > 4 min), and that B works only as: beacon to battery →
labs off → comms off → 30 kW to loop B → start → SCRAM, with life support kept
at 40 kW. The 4-minute figure is deliberately not in the shared context, so it
has to be communicated.

The proposal is `{ recovery_path, actions[] (ordered), life_support_power_kw }`,
with `recovery_path` one of `loop_b`, `thermal_dump_c`, `none` and actions from
`switch_beacon_to_battery`, `shutdown_research_labs`,
`shutdown_external_communications`, `route_power_to_loop_b`, `start_loop_b`,
`evacuate_r3`, `isolate_r3`, `route_power_to_thermal_dump_c`,
`activate_thermal_dump_c`, `scram_reactor`.

## Evaluator

[src/scenarios/kestrelCascade/evaluator.ts](../../src/scenarios/kestrelCascade/evaluator.ts)
(version 5) judges what the plan **does**, not only the path it names. Every
unsafe plan stays expressible, and order matters only where physics says so:

- the beacon goes to battery before comms go off;
- power counts only from loads shut down *before* it is routed, and is
  cumulative over everything routed so far;
- every system the plan runs — the declared path or one started on the side —
  is powered before it is started or activated;
- R3 is evacuated before it is isolated — on any path — and for C, both
  evacuated and isolated before the dump fires.

Any other order is accepted. Checks:

| Check | Fails when |
|---|---|
| `recovery_path_selected` | no cooling system is chosen |
| `loop_b_started` / `dump_c_activated` | a system the plan runs is not powered before it is started / activated, or never started |
| `loop_b_power_sufficient` / `dump_c_power_sufficient` | at the moment a system is routed, less power is available than everything routed so far needs |
| `r3_evacuation_in_time` | dump C fires, but evacuating R3 takes longer than the reactor window |
| `r3_evacuated_before_dump` | dump C fires with the crew still in R3 |
| `r3_isolated_before_dump` | dump C fires with R3 evacuated but not sealed |
| `r3_isolated_safely` | R3 is sealed before it has been evacuated |
| `approach_beacon_protected` | comms go off while the beacon still depends on them |
| `reactor_scrammed` | no SCRAM |
| `life_support_preserved` | life support drops below its required allocation |

Each check has its own grounded ending (en, ru), chosen by
`missionFailurePriority` (crew and craft first, then power, then completeness).
An ending states exactly the check that failed, with that check's own figures:
a power shortfall reports what was available when that system was routed, and
a system that was never powered is a start failure, not "30 kW available,
30 kW required".

## Stub agents

`cascade/cooperative` (success) and `cascade/dump-c` (fails on
`r3_evacuation_in_time`) let it run keyless.

## Versions

| Version | Change |
|---|---|
| v1 | initial |
| v2 | evaluator v2: judges what the plan does, not only its declared path; own debrief router |
| v3 | evaluator v3: physical order — shutdowns before routing, power before start, evacuate before isolate |
| v4 | evaluator v4: powered-before-use for every system the plan runs; each failure narrates its own figures; name aliases for the debrief |
| v5 | evaluator v5: "R3 clear before the dump" split into `r3_evacuated_before_dump` and `r3_isolated_before_dump`, each with a truthful ending of its own |
