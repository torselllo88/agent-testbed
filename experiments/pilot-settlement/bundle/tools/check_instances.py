"""Independent checks of the frozen instance files. Run before the freeze and again
before every pilot launch:  python3 check_instances.py ../instances
Exits non-zero on any violation."""
from __future__ import annotations

import json
import statistics
import sys
from collections import Counter, defaultdict

from settlement_task import (AGENTS, DATA_ROLES, base_facts, classify, evaluate, metadata, ring_distance,
                             ring_neighbors, state_hash, structural_key, temporal_delivery)


def load(path):
    with open(path) as fh:
        return json.load(fh)["instances"]


def main(folder):
    dev = load(f"{folder}/dev_instances.json")
    pilot = load(f"{folder}/pilot_instances.json")
    errors = []

    def err(msg):
        errors.append(msg)

    for inst in dev + pilot:
        s = inst["state"]
        iid = inst["instance_id"]
        if state_hash(s) != inst["state_hash"]:
            err(f"{iid}: state hash mismatch")
        if base_facts(s) != inst["base_facts"]:
            err(f"{iid}: base facts mismatch")
        if evaluate(s) != inst["canonical_outcome"]:
            err(f"{iid}: canonical outcome mismatch")
        c, sub = classify(s)
        if (c, sub) != (inst["class"], inst["subtype"]) or c == "excluded":
            err(f"{iid}: class mismatch or excluded state")
        md = metadata(s)
        for k in ("minimal_fact_sets", "minimal_role_sets", "relevant_facts", "core_facts", "min_fact_set_size"):
            if md[k] != inst["metadata"][k]:
                err(f"{iid}: metadata {k} mismatch")
        ta = inst["topology_assignment"]
        if sorted(ta["speaking_order"]) != sorted(AGENTS):
            err(f"{iid}: speaking order is not a permutation of the six agents")
        if ta["ring_positions"][0] != "Operations" or sorted(ta["ring_positions"]) != sorted(AGENTS):
            err(f"{iid}: ring positions invalid")
        if ring_neighbors(ta["ring_positions"]) != ta["ring_neighbors"]:
            err(f"{iid}: ring neighbours inconsistent")
        tr = temporal_delivery("ring", ta["speaking_order"], ta["ring_positions"])
        if any(v is None or v["earliest_arrival_turn"] > 18 for v in tr.values()):
            err(f"{iid}: a data role is not reachable within K=3 in Ring")
        if tr != ta["temporal_delivery"]["ring"]:
            err(f"{iid}: stored Ring temporal delivery differs from recomputation")
        for r in DATA_ROLES:
            if ring_distance(ta["ring_positions"], r, "Operations") != ta["ring_distance_to_operations"][r]:
                err(f"{iid}: ring distance mismatch for {r}")

    # dev/pilot separation and duplicates
    dev_keys = {structural_key(i["state"]) for i in dev}
    pilot_keys = [structural_key(i["state"]) for i in pilot]
    if dev_keys & set(pilot_keys):
        err("a pilot instance is a structural duplicate of a development instance")
    if len(set(pilot_keys)) != len(pilot_keys):
        err("structural duplicates inside the pilot set")

    # composition
    top = Counter(i["top_class"] for i in pilot)
    if top != Counter({"A": 10, "B": 10, "C": 10, "Reject": 10}):
        err(f"top-level composition {dict(top)}")
    sub = Counter((i["class"], i["subtype"]) for i in pilot)
    expected = {("A", "rail_A"): 5, ("A", "rail_B"): 5, ("B", "contract"): 4, ("B", "compliance"): 4,
                ("B", "route"): 2, ("C", "verification"): 5, ("C", "approval"): 5, ("R-ELIG", None): 5,
                ("R-ROUTE", None): 5}
    if dict(sub) != expected:
        err(f"subclass composition {dict(sub)}")
    for t in ("A", "B", "C", "Reject"):
        req = Counter(i["public_state"]["requested_destination"] for i in pilot if i["top_class"] == t)
        if req != Counter({"D1": 5, "D2": 5}):
            err(f"requested split in {t}: {dict(req)}")

    # Latin balance of Ring positions within each top-level class
    for t in ("A", "B", "C", "Reject"):
        cnt = Counter()
        for i in pilot:
            if i["top_class"] == t:
                for pos, role in enumerate(i["topology_assignment"]["ring_positions"][1:], start=1):
                    cnt[(role, pos)] += 1
        if any(cnt[(r, p)] != 2 for r in DATA_ROLES for p in range(1, 6)):
            err(f"Ring position balance violated in {t}")

    # Speaking-order balance: every agent holds every slot once or twice within each class
    for t in ("A", "B", "C", "Reject"):
        cnt = Counter()
        for i in pilot:
            if i["top_class"] == t:
                for slot, a in enumerate(i["topology_assignment"]["speaking_order"]):
                    cnt[(a, slot)] += 1
        if any(not 1 <= cnt[(a, s)] <= 2 for a in AGENTS for s in range(6)):
            err(f"speaking-slot balance violated in {t}")

    print(json.dumps({"errors": errors, "n_dev": len(dev), "n_pilot": len(pilot)}, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "../instances"))
