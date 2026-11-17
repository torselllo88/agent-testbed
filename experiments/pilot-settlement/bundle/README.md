# Pilot bundle - Distributed Settlement Decision (internal v0.3.1)

Companion to the doc "Pilot Experimental Plan - Distributed Settlement Decision (internal v0.3.1)".
Frozen inputs: Task Definition v1.4, Exposure & Instance Metadata v1.4.

## Contents

| Path | Purpose |
| --- | --- |
| config/pilot_config.yaml | All run, model, budget, gate, retry, validity, detector and analysis settings |
| prompts/ | Every model input template (rendered only by tools/render_prompts.py) |
| schemas/ | JSON schemas: instance files, run logs, final proposal, detector extraction, detector output; self-contained, no cross-file $ref |
| instances/dev_instances.json | 10 development instances (Task Definition examples + DEV-10) |
| instances/pilot_instances.json | 40 pilot instances with metadata, Ring placement, speaking order, distances, temporal delivery |
| reports/sampling_record.json | Seeds, accepted attempt, balance checks, file hashes |
| tools/settlement_task.py | Reference implementation of the task: evaluator, classes, state spaces, minimal sets, delivery model |
| tools/sample_instances.py | Frozen sampling procedure (regenerates the instance files exactly) |
| tools/check_instances.py | Independent checks of the instance files |
| tools/render_prompts.py | Builds every model input; the testbed must match it byte for byte |
| tools/seeds.py | Per-call seed schedule (topology not in the key; public-only seeds keyed on the public prompt) |
| tools/public_policy_ceiling.py | Public-only ceilings and H1-H7 counts for any instance set (gate G4) |
| tools/validate_run_log.py | Checks a run log against the run semantics; simulates the delivery probe |
| tools/exposure_postprocess.py | Deterministic detector stage (E1-E6) and decision-support categories |
| tools/test_exposure_postprocess.py | Unit tests from the Exposure spec examples |
| MANIFEST.sha256 | sha256 of every file above (input to the freeze record) |

## Checks to run before the freeze (Python 3.10+, pyyaml, jsonschema)

```
cd tools
python3 check_instances.py ../instances          # must print "errors": []
python3 test_exposure_postprocess.py             # 15 x ok
python3 sample_instances.py --out /tmp/regen --report /tmp/regen   # hashes must equal reports/sampling_record.json
python3 validate_run_log.py --simulate-probe P-01 ring --instances ../instances/pilot_instances.json
python3 public_policy_ceiling.py ../instances/dev_instances.json   # dev ceilings for gate G4
python3 public_policy_ceiling.py --self-test      # per-replicate gate check
python3 seeds.py P-01                             # seed table of one run
```
