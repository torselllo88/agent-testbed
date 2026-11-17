"""Checks that a run log obeys the run semantics of the Pilot Experimental Plan.

  python3 validate_run_log.py RUN_LOG.json --instances ../instances/pilot_instances.json
  python3 validate_run_log.py --simulate-probe P-01 ring --instances ../instances/pilot_instances.json

A run with any failed check is an agent_system_failure (plan section 11).

Probe mode: the testbed replaces the model with a scripted agent whose reply is
"PROBE " + the sorted set of tokens "<Role>-TOKEN" it holds (its own token if it is a data
role, plus every token that appears in its user text). simulate_probe() gives the exact
expected messages and user texts; the testbed's probe log must match them byte for byte.
"""
from __future__ import annotations

import argparse
import json
import re
import sys

from render_prompts import final_user, system_prompt, turn_user
from seeds import call_seed
from settlement_task import DATA_ROLES, evaluate, recipients, temporal_delivery, turn_schedule, visible_history


def expected_turns(instance, topology):
    ta = instance["topology_assignment"]
    out = []
    for step in turn_schedule(ta["speaking_order"]):
        out.append(dict(step, recipients=recipients(topology, step["speaker"], ta["ring_positions"])))
    return out


def simulate_probe(instance, topology):
    log, calls = [], []
    for step in expected_turns(instance, topology):
        user = turn_user(log, step["speaker"], step["round"])
        toks = set(re.findall(r"[A-Z][a-z]+-TOKEN", user))
        if step["speaker"] in DATA_ROLES:
            toks.add(f"{step['speaker']}-TOKEN")
        text = "PROBE " + " ".join(sorted(toks)) if toks else "PROBE"
        calls.append({"turn": step["turn"], "speaker": step["speaker"], "user_text": user, "accepted_text": text})
        log.append({"turn": step["turn"], "round": step["round"], "speaker": step["speaker"],
                    "recipients": step["recipients"], "text": text})
    fin = final_user(log)
    calls.append({"turn": None, "speaker": "Operations", "user_text": fin, "accepted_text": None})
    # cross-check with the analytic temporal model: every role whose information can reach
    # Operations by turn 18 must appear in the final user text
    ta = instance["topology_assignment"]
    arrivals = temporal_delivery(topology, ta["speaking_order"], ta["ring_positions"])
    seen = set(re.findall(r"([A-Z][a-z]+)-TOKEN", fin))
    assert seen == {r for r, a in arrivals.items() if a is not None}, (seen, arrivals)
    return calls


def validate(run, instance, cfg_num_ctx=8192):
    errs = []
    topo = run["topology"]
    if run["condition"] != "discussion":
        return errs
    iid = instance["instance_id"]
    ta = instance["topology_assignment"]
    exp = expected_turns(instance, topo)
    disc = [c for c in run["calls"] if c["call_type"] == "discussion"]
    fin = [c for c in run["calls"] if c["call_type"] == "final"]
    if len(disc) != 18 or len(fin) != 1:
        errs.append(f"expected 18 discussion calls and 1 final call, got {len(disc)} and {len(fin)}")
        return errs
    snaps = run.get("environment_snapshots", [])
    reload = any((a.get("load_duration_ns") or 0) > 1_000_000_000 for c in run["calls"] for a in c["attempts"])
    if {s.get("when") for s in snaps} != {"before_pair", "between_runs", "after_pair"}:
        errs.append("environment snapshots before, between and after the pair's runs are missing")
    elif (not all(s.get("normal") for s in snaps) or reload) and run["validity"]["status"] != "environment_deviation":
        errs.append("abnormal snapshot or mid-run reload, but run not marked environment_deviation")
    silent = {c["turn"] for c in disc if c["accepted_text"] is None}
    log = []
    for c, e in zip(disc, exp):
        for k in ("turn", "round", "speaker"):
            if c[k] != e[k]:
                errs.append(f"turn {e['turn']}: {k} {c[k]} != {e[k]}")
        if sorted(c["recipients"]) != sorted(e["recipients"]):
            errs.append(f"turn {e['turn']}: recipients {c['recipients']} != {e['recipients']}")
        want_seed = call_seed(iid, "discussion", e["round"], e["speaker"])
        if c["seed"] != want_seed or any(a["seed"] != want_seed for a in c["attempts"]):
            errs.append(f"turn {e['turn']}: seed differs from the schedule")
        if any(a["kind"] not in ("initial", "technical_retry", "length_regeneration") for a in c["attempts"]):
            errs.append(f"turn {e['turn']}: attempt kind not allowed in a primary run")
        if e["turn"] in silent and "silent_turn_model_failure" not in c["flags"]:
            errs.append(f"turn {e['turn']}: silent turn without silent_turn_model_failure flag")
        want_hist = [t for t in visible_history(topo, ta["speaking_order"], ta["ring_positions"], e["speaker"], e["turn"])
                     if t not in silent]
        if c["visible_history_turns"] != want_hist:
            errs.append(f"turn {e['turn']}: history turns {c['visible_history_turns']} != {want_hist}")
        if c["system_text"] != system_prompt(instance, e["speaker"], topo):
            errs.append(f"turn {e['turn']}: system prompt differs from render_prompts")
        if c["user_text"] != turn_user(log, e["speaker"], e["round"]):
            errs.append(f"turn {e['turn']}: user text differs from render_prompts")
        if "<think>" in c["user_text"] or "<think>" in (c["accepted_text"] or ""):
            errs.append(f"turn {e['turn']}: thinking markup in history or message")
        if not c["budget_ok"]:
            errs.append(f"turn {e['turn']}: budget violation")
        if c["accepted_text"] is not None:
            log.append({"turn": e["turn"], "round": e["round"], "speaker": e["speaker"],
                        "recipients": e["recipients"], "text": c["accepted_text"]})
    f = fin[0]
    if f["speaker"] != "Operations" or f["user_text"] != final_user(log):
        errs.append("final call: speaker or user text differs from render_prompts")
    if f["system_text"] != system_prompt(instance, "Operations", topo):
        errs.append("final call: system prompt differs")
    if f["seed"] != call_seed(iid, "final", None, "Operations"):
        errs.append("final call: seed differs from the schedule")
    canon = evaluate(instance["state"])
    fr = run["final"]
    if fr["canonical"] != canon:
        errs.append("final: stored canonical outcome differs from evaluator")
    if fr["final_model_failure"] and (fr["parsed"] is not None or fr["correct_exact"]):
        errs.append("final: model failure must have parsed = null and correct_exact = false")
    if fr["schema_valid"] and fr["correct_exact"] != (fr["parsed"] == canon):
        errs.append("final: correct_exact inconsistent with parsed proposal")
    if not fr["schema_valid"] and fr["correct_exact"]:
        errs.append("final: schema failure scored as correct")
    return errs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_log", nargs="?")
    ap.add_argument("--instances", required=True)
    ap.add_argument("--simulate-probe", nargs=2, metavar=("INSTANCE_ID", "TOPOLOGY"))
    a = ap.parse_args()
    insts = {i["instance_id"]: i for i in json.load(open(a.instances))["instances"]}
    if a.simulate_probe:
        iid, topo = a.simulate_probe
        calls = simulate_probe(insts[iid], topo)
        print(json.dumps(calls[-1], indent=2))
        return 0
    run = json.load(open(a.run_log))
    errs = validate(run, insts[run["instance_id"]])
    print(json.dumps({"run_id": run["run_id"], "errors": errs}, indent=2))
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
