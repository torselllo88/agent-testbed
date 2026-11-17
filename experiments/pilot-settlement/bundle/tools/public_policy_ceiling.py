"""Public-policy ceilings for gate G4, computed for the exact instance set the gate runs on.

The only public information that varies between instances is the requested destination
(amount and milestone are constant). Any leakage-free public-only output is therefore a
function of the requested destination, possibly random. Its expected accuracy on a set
cannot exceed the best deterministic function requested -> proposal on that set; the same
bound holds within each class. Public-only seeds depend only on the public prompt
(tools/seeds.public_only_seed), so with reproducible sampling (gate G6) each replicate is a
deterministic function of the requested destination and the ceilings are strict, not just
bounds on an expectation. A public-only result above a ceiling then indicates leakage.

  python3 public_policy_ceiling.py ../instances/dev_instances.json
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict

OTHER = {"D1": "D2", "D2": "D1"}
HEURISTICS = {
    "H1 execute requested / A": lambda q: ("execute", q, "A", None),
    "H2 execute requested / B": lambda q: ("execute", q, "B", None),
    "H3 execute other / A": lambda q: ("execute", OTHER[q], "A", None),
    "H4 hold / VERIFICATION_PENDING": lambda q: ("hold", None, None, "VERIFICATION_PENDING"),
    "H5 hold / APPROVAL_PENDING": lambda q: ("hold", None, None, "APPROVAL_PENDING"),
    "H6 reject / NO_ELIGIBLE_DESTINATION": lambda q: ("reject", None, None, "NO_ELIGIBLE_DESTINATION"),
    "H7 reject / NO_ROUTE": lambda q: ("reject", None, None, "NO_ROUTE"),
}
CLASSES = ("A", "B", "C", "Reject")


def _canon(i):
    o = i["canonical_outcome"]
    return (o["action"], o["destination"], o["rail"], o["reason"])


def _best(insts):
    by_req = defaultdict(Counter)
    for i in insts:
        by_req[i["public_state"]["requested_destination"]][_canon(i)] += 1
    return sum(c.most_common(1)[0][1] for c in by_req.values()) / len(insts) if insts else None


def ceilings(insts):
    out = {"overall": _best(insts), "per_class": {}}
    for c in CLASSES:
        g = [i for i in insts if i["top_class"] == c]
        if g:
            out["per_class"][c] = {"n": len(g), "ceiling": _best(g)}
    out["heuristics"] = {
        h: {c: sum(f(i["public_state"]["requested_destination"]) == _canon(i) for i in insts if i["top_class"] == c)
            for c in CLASSES} for h, f in HEURISTICS.items()}
    return out


def gate_g4(results_by_replicate, insts, overall_max=0.30):
    """results_by_replicate: {replicate_index: {instance_id: bool}} - public-only exact
    correctness, one entry per instance in every replicate.

    The gate is evaluated separately for every replicate and passes only if every
    replicate passes: overall accuracy <= overall_max and no class above its ceiling.
    Replicates are never pooled - a pooled average could hide one replicate above a
    ceiling (e.g. B = 3/3 in replicate 0 and 0/3 in replicates 1 and 2 averages to 0.33)."""
    ceil = ceilings(insts)
    by_id = {i["instance_id"]: i for i in insts}
    per_rep = {}
    for rep, res in sorted(results_by_replicate.items()):
        missing = set(by_id) - set(res)
        if missing:
            raise ValueError(f"replicate {rep}: no result for {sorted(missing)}")
        overall = sum(res.values()) / len(res)
        per_class = {}
        for c, info in ceil["per_class"].items():
            xs = [res[iid] for iid in res if by_id[iid]["top_class"] == c]
            per_class[c] = sum(xs) / len(xs)
        fails = [c for c in per_class if per_class[c] > ceil["per_class"][c]["ceiling"] + 1e-9]
        per_rep[rep] = {"pass": overall <= overall_max and not fails, "overall": overall,
                        "per_class": per_class, "classes_above_ceiling": fails}
    return {"pass": bool(per_rep) and all(r["pass"] for r in per_rep.values()),
            "replicates": per_rep, "ceilings": ceil}


def _self_test():
    """The pooled-average trap from the review: B = 3/3, 0/3, 0/3 must fail."""
    insts = json.load(open(__file__.rsplit("/", 2)[0] + "/instances/dev_instances.json"))["instances"]
    b = [i["instance_id"] for i in insts if i["top_class"] == "B"]
    base = {i["instance_id"]: False for i in insts}
    reps = {0: dict(base, **{x: True for x in b}), 1: dict(base), 2: dict(base)}
    out = gate_g4(reps, insts)
    assert not out["pass"] and out["replicates"][0]["classes_above_ceiling"] == ["B"], out
    assert gate_g4({0: dict(base), 1: dict(base), 2: dict(base)}, insts)["pass"]
    return "gate_g4 self-test passed: one replicate above the B ceiling fails the gate"


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        print(_self_test())
    else:
        data = json.load(open(sys.argv[1]))["instances"]
        print(json.dumps(ceilings(data), indent=2))
