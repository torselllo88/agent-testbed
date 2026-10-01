# Space Station Benchmark

The reference scenario (`space-station`): neutral functional roles, no
narration, no pacing. The research baseline; Station Kestrel runs the same
task with a presentation layer on top.

## Task

Reactor cooling loop A has failed. Four officers must agree on a recovery
procedure. Each one knows only part of the picture:

| Agent | Knows |
|---|---|
| **Reactor Engineering** | Loop B works but needs ≥ 30 kW; a SCRAM is required; SCRAM alone is not enough |
| **Power Systems** | Only 10 kW is free; the labs (12 kW) and external comms (8 kW) can be shed; life support must not be touched without confirmation |
| **Life Support** | Life support must stay at 40 kW; the labs and comms can go; venting is unacceptable |
| **Station Operations** | The validated procedure (power → route ≥ 30 kW to B → start B → SCRAM → keep life support) |

The committed proposal is structured data:

```json
{
  "shed_loads": ["research_labs", "external_communications"],
  "coolant_loop": "B",
  "coolant_power_kw": 30,
  "scram_reactor": true,
  "life_support_power_kw": 40,
  "vent_reactor_section": false
}
```

## Evaluator

[src/scenarios/spaceStation/evaluator.ts](../../src/scenarios/spaceStation/evaluator.ts)
checks six constraints and reports each one:

- `coolant_available`
- `coolant_power_sufficient`
- `power_feasible` — the routed power must actually be available, i.e. the
  reserve plus the loads that were shed
- `reactor_scrammed`
- `life_support_preserved`
- `no_unsafe_venting`

The station's numbers are editable evaluator parameters. If you change them,
keep the agents' private context consistent with them.

## Stub agents

Three scripted variants exercise distinct outcomes without any API key:

| Stub model | What happens | Outcome |
|---|---|---|
| `space-station/cooperative` | Full information exchange | `SUCCESS` |
| `space-station/insufficient-power` | Only the labs are shed; everyone approves | `MISSION_FAILURE` (consensus ≠ correctness) |
| `space-station/life-support-veto` | The plan draws on life support; Life Support rejects | `CONSENSUS_FAILURE` under unanimity, `MISSION_FAILURE` under majority |

## Versions

- **v2** states explicitly, in Power's private information, that the 40 kW
  life-support allocation is existing load (not additional demand) and that
  the 10 kW reserve is free for the coolant system. In live runs, cheap models
  read the v1 wording as "40 kW + 30 kW must be covered" and gave up.
