# Distributed Settlement pilot — run approval

2026-11-21 · Pilot Experimental Plan internal v0.3.1, bundle config_version 0.3.2-draft

## Pilot goal

The pilot compares two communication structures, Complete (everyone hears everyone) and Ring (each agent hears only its two neighbours), on the same 40 settlement instances with a fixed proposer, Operations: 40 paired instances, 80 runs. The question is whether restricted communication changes how distributed private information reaches the proposer and is used in the decision. The pilot is descriptive and validates the instrument (task, protocol, runtime, exposure detector); it is not the final hypothesis test, and no inferential claim will be made from it.

## Task and protocol

| Item | Setting |
| --- | --- |
| Task | Distributed Settlement Decision, Task Definition v1.4; Exposure & Instance Metadata v1.4 |
| Roles | 6 agents: Operations, Contract, Compliance, Settlement, Verification, Treasury; private facts split by role, Operations holds none |
| Conditions | Complete vs Ring (ring positions per instance, Operations at position 0) |
| Rounds | K = 3 fixed rounds, 18 discussion turns, then one mandatory final call of Operations |
| Speaking order | Fixed per instance (Latin-square balanced), identical in both conditions |
| Proposer | Operations alone returns the proposal {action, destination, rail, reason} |
| Instances | 40 pilot instances, 4 top-level classes × 10: A (execute as requested), B (execute elsewhere), C (hold), Reject (5 no-eligible-destination, 5 no-route) |
| Primary outcome | Exact proposal correctness: all four fields equal the canonical outcome; schema failure or final model failure = incorrect |
| Replication | 1 run per instance and condition; paired analysis per instance; oracle and public-only controls on the pilot set afterwards, reported only |

## Frozen runtime configuration

| Item | Setting |
| --- | --- |
| Model | qwen3.8:27b, Q4_K_M, digest aaee06c3…7813, single model for the whole pilot |
| Thinking | On (no thinking levels offered by the build); thinking text never re-sent |
| Sampling | temperature 1.0, top_p 0.95, top_k 20, min_p 0, presence 0, repeat 1.0 |
| Context | num_ctx 8192 on every call; num_predict 2560 (thinking + visible text) |
| Seeds | Deterministic per call: sha256(master 20261120, instance, call type, round, speaker, replicate); Complete and Ring calls of an instance share seeds |
| Visible messages | Instruction: no more than four sentences and under 100 words; hard cap 200 tokens (one regeneration, then deterministic truncation) |
| Server | Ollama 0.33.2, native /api/chat, one call at a time, keep_alive 30 min |
| Environment control | Per pair: preload, snapshot, run 1, snapshot, run 2, snapshot; normal = model fully in GPU memory (NVIDIA A30, 24 GB, shared), context 8192, digest and version as recorded; a deviation re-executes the pair, a digest or version change stops the pilot |

Full machine-readable configuration attached as pilot_config.yaml.

## Development validation (10 dev instances)

All six development gates G1–G6 are passed on this configuration; the detector gate G7 follows separately and does not affect the runs.

| Check | Result |
| --- | --- |
| Run logs | 80 of 80 (20 dev runs, 60 control calls) pass the reference validator and the schema |
| Dev runs | 20 of 20 valid; 20 of 20 exact, in both conditions and every class |
| Oracle control (full information) | 30 of 30 correct, every class, every replicate |
| Public-only control (no private facts) | 3 of 30 correct = 10 % in each of 3 replicates, under the 30 % bound and under every class ceiling |
| Schema failures | 0 of 80 final answers |
| Budget | 0 context truncations, 0 thinking overflows, 0 silent turns, 0 regenerations in 360 discussion calls (after the wording fix); peak prompt + output 3039 of 7992 tokens allowed |
| Determinism (G6, hard gate) | 36 of 36 repeated calls byte-identical in content and thinking, cold and warm cache |
| Environment | 40 pairs, 120 snapshots, all normal; 0 deviations, 0 re-executions, 0 mid-run reloads |

## Changes requiring sign-off

Four development decisions, confirmed on the author's side, set out in detail in the gate report.

- [ ] **Clarified message-length instruction.** "Keep each message short: a few sentences" → "no more than four sentences and under 100 words"; the 200-token cap is unchanged. A comprehension fix under plan §7.5, taken on a technical gate (regeneration rate 2.2 % / 10 % → 0 %), not on outcomes. Proposed: accept.
- [ ] **G6 cold/warm classification by call order.** The server does not expose prompt_eval_cached_count; the cache state is constructed with a cache-busting prompt before every cold call, as the plan's own fallback allows. Proposed: accept.
- [ ] **Empirical token-count rule.** Reported prompt tokens = local count + 15 template tokens, cached prefix never subtracted; post-call tolerance 1 %; truncation proven detectable by a 9000-token canary. Proposed: accept.
- [ ] **Two run-log schema additions.** Optional top-level `replicate` (integer) and `testbed` (provenance block: experiment, batch, config hash, protocol fingerprint); run ids carry -rep<n> for replicates. Proposed: accept.
