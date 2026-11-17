"""Frozen sampling procedure for the development (10) and pilot (40) instance sets.

Usage:  python3 -I sample_instances.py --out ../instances --report ../reports
The procedure is deterministic: SAMPLING_SEED and the attempt counter fully
determine the output. Do not change this file after the sampling freeze;
any change requires a new sampling version and a new freeze record.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import statistics
from collections import Counter, defaultdict

from settlement_task import (AGENTS, AMOUNT, DATA_ROLES, MILESTONE, base_facts, class_valid_states, classify,
                             evaluate, executable, generator_state_space, make_state, metadata, mirror,
                             public_state_space, ring_distance, ring_neighbors, state_hash, structural_key,
                             temporal_delivery)

SAMPLING_VERSION = "pilot-sampling-v2"
SAMPLING_SEED = 20261114
DEV_SEED = 20261115
MAX_ATTEMPTS = 5000
MC_DRAWS = 20000
TEMPORAL_TOL = 0.75  # turns; per class, observed vs expected mean latest required arrival

# ---------------------------------------------------------------- development set (fixed by hand)
DEV_STATES = [
    # id, Task Definition example id, state
    ("DEV-01", "A1", make_state("D2", ["D1", "D2"], ["D1", "D2"], ["D1/B", "D2/A"])),
    ("DEV-02", "A2", make_state("D1", ["D1"], ["D1", "D2"], ["D1/B", "D2/A"])),
    ("DEV-03", "B1", make_state("D2", ["D1", "D2"], ["D1"], ["D1/A", "D2/A"])),
    ("DEV-04", "B2", make_state("D1", ["D1", "D2"], ["D1", "D2"], ["D2/B"])),
    ("DEV-05", "B3", make_state("D1", ["D2"], ["D1", "D2"], ["D1/A", "D2/A", "D2/B"])),
    ("DEV-06", "C1", make_state("D2", ["D2"], ["D2"], ["D2/A"], verification="pending")),
    ("DEV-07", "C2", make_state("D1", ["D1", "D2"], ["D1"], ["D1/B"], approval="pending")),
    ("DEV-08", "R-ELIG-1", make_state("D2", ["D1"], ["D2"], ["D1/A", "D2/A"])),
    ("DEV-09", "R-ROUTE-1", make_state("D1", ["D1"], ["D1"], ["D2/A", "D2/B"])),
    # Added for the plan: hold whose requested destination is not executable (compliance) -
    # a C case that also carries a B-like failure.
    ("DEV-10", None, make_state("D2", ["D1", "D2"], ["D1"], ["D1/A", "D2/A"], approval="pending")),
]

# ---------------------------------------------------------------- pilot strata
# (class, subtype, n, n_requested_D1). Mirror classes are sampled without replacement,
# so no two pilot instances are structural duplicates.
STRATA = [
    # class, subtype, (feature, value) or None, n, n_requested_D1
    ("A", "rail_A", ("other_executable", True), 2, 1),
    ("A", "rail_A", ("other_executable", False), 3, 2),
    ("A", "rail_B", ("other_executable", True), 2, 1),
    ("A", "rail_B", ("other_executable", False), 3, 1),
    ("B", "contract", ("canonical_rail", "A"), 2, 1),
    ("B", "contract", ("canonical_rail", "B"), 2, 1),
    ("B", "compliance", ("canonical_rail", "A"), 2, 1),
    ("B", "compliance", ("canonical_rail", "B"), 2, 1),
    ("B", "route", ("canonical_rail", "A"), 2, 1),
    ("C", "verification", ("requested_executable", True), 3, 2),
    ("C", "verification", ("requested_executable", False), 2, 1),
    ("C", "approval", ("requested_executable", True), 2, 1),
    ("C", "approval", ("requested_executable", False), 3, 1),
    ("R-ELIG", None, None, 5, 3),
    ("R-ROUTE", None, None, 5, 2),
]
TOP_CLASS = {"A": "A", "B": "B", "C": "C", "R-ELIG": "Reject", "R-ROUTE": "Reject"}


def features(s):
    ev, ex = evaluate(s), executable(s)
    q = s["requested_destination"]
    other = "D2" if q == "D1" else "D1"
    return {
        "requested_executable": q in ex,
        "other_executable": other in ex,
        "n_supported_routes": len(s["supported_routes"]),
        "contract_permits_both": len(s["permitted_destinations"]) == 2,
        "compliance_authorizes_both": len(s["authorized_destinations"]) == 2,
        "canonical_destination": ev["destination"],
        "canonical_rail": ev["rail"],
    }


def balance_ok(chosen):
    """Secondary state-balance constraints (checked after stratified draw)."""
    by = defaultdict(list)
    for s in chosen:
        c, sub = classify(s)
        by[(c, sub)].append(s)
    b_all = by[("B", "contract")] + by[("B", "compliance")] + by[("B", "route")]
    b_rail_a = sum(evaluate(s)["rail"] == "A" for s in b_all)
    c_all = by[("C", "verification")] + by[("C", "approval")]
    c_req_ex = sum(features(s)["requested_executable"] for s in c_all)
    c_v = sum(features(s)["requested_executable"] for s in by[("C", "verification")])
    c_a = sum(features(s)["requested_executable"] for s in by[("C", "approval")])
    a_all = by[("A", "rail_A")] + by[("A", "rail_B")]
    a_other = sum(features(s)["other_executable"] for s in a_all)
    checks = {
        "B_alternative_rail_A_in_4_6": 4 <= b_rail_a <= 6,
        "C_requested_executable_in_4_6": 4 <= c_req_ex <= 6,
        "C_per_blocker_requested_executable_in_2_3": 2 <= c_v <= 3 and 2 <= c_a <= 3,
        "A_other_executable_in_3_7": 3 <= a_other <= 7,
    }
    return all(checks.values()), checks


def draw_states(rng, excluded_keys):
    """Stratified draw of mirror classes without replacement; the requested destination
    of each drawn class is then fixed by the stratum's D1/D2 split."""
    pools = defaultdict(dict)  # stratum index -> structural_key -> {requested: state}
    for s in class_valid_states():
        k = structural_key(s)
        if k in excluded_keys:
            continue
        c, sub = classify(s)
        f = features(s)
        for si, (sc, ssub, feat, _, _) in enumerate(STRATA):
            if (c, sub) == (sc, ssub) and (feat is None or f[feat[0]] == feat[1]):
                pools[si].setdefault(k, {})[s["requested_destination"]] = s
    chosen = []
    for si, (c, sub, feat, n, n_d1) in enumerate(STRATA):
        keys = sorted(pools[si].keys())
        picks = rng.sample(keys, n)
        reqs = ["D1"] * n_d1 + ["D2"] * (n - n_d1)
        rng.shuffle(reqs)
        for k, q in zip(picks, reqs):
            chosen.append(pools[si][k][q])
    sizes = {f"{c}/{sub}/{feat[0]}={feat[1]}" if feat else f"{c}/{sub}": len(pools[si])
             for si, (c, sub, feat, _, _) in enumerate(STRATA)}
    return chosen, sizes


def latin_placements(rng, n_copies):
    out = []
    for _ in range(n_copies):
        base = rng.sample(DATA_ROLES, 5)
        out.append([base[k:] + base[:k] for k in range(5)])
    return out


def random_latin_square(rng, symbols):
    """Random 6x6 Latin square: independent random permutations of the rows, columns and
    symbols of the cyclic square."""
    n = len(symbols)
    rows, cols, sym = rng.sample(range(n), n), rng.sample(range(n), n), rng.sample(list(symbols), n)
    return [[sym[(rows[i] + cols[j]) % n] for j in range(n)] for i in range(n)]


def latin_speaking_orders(rng, n):
    assert n <= 12
    first = random_latin_square(rng, AGENTS)
    second = random_latin_square(rng, AGENTS)
    orders = first[:min(n, 6)] + rng.sample(second, max(0, n - 6))
    rng.shuffle(orders)
    return orders


def assign_topology(rng, insts_by_top):
    """Ring placement: Operations at ring position 0; per top-level class two 5x5 Latin
    squares over positions 1..5, so every data role occupies every position exactly twice.
    Speaking order: per top-level class, all six rows of one random 6x6 Latin square plus
    four random rows of a second one, so every agent (Operations included) holds every
    speaking slot once or twice within the class."""
    for top, insts in insts_by_top.items():
        squares = latin_placements(rng, 2)
        subs = sorted({i["subtype_key"] for i in insts})
        if len(insts) == 10 and len(subs) == 2 and all(sum(i["subtype_key"] == s for i in insts) == 5 for s in subs):
            groups = [[i for i in insts if i["subtype_key"] == s] for s in subs]
            for g, sq in zip(groups, squares):
                rows = sq[:]
                rng.shuffle(rows)
                for inst, row in zip(g, rows):
                    inst["ring_positions"] = ["Operations"] + row
        else:
            rows = squares[0] + squares[1]
            rng.shuffle(rows)
            for inst, row in zip(insts, rows[:len(insts)]):
                inst["ring_positions"] = ["Operations"] + row
        orders = latin_speaking_orders(rng, len(insts))
        for inst, order in zip(insts, orders):
            inst["speaking_order"] = order


def covariates(inst):
    req = inst["metadata"]["minimal_role_sets"][0]
    pos = inst["ring_positions"]
    order = inst["speaking_order"]
    dist = {r: ring_distance(pos, r, "Operations") for r in DATA_ROLES}
    t_ring = temporal_delivery("ring", order, pos)
    t_comp = temporal_delivery("complete", order)
    assert all(v is not None and v["earliest_arrival_turn"] <= 18 for v in t_ring.values()), "Ring reachability violated"
    return {
        "required_roles": req,
        "ring_distance_to_operations": dist,
        "temporal_delivery": {"ring": t_ring, "complete": t_comp},
        "required_role_covariates": {
            "ring": {
                "max_distance": max(dist[r] for r in req),
                "mean_distance": round(statistics.mean(dist[r] for r in req), 3),
                "sum_relay_steps": sum(dist[r] - 1 for r in req),
                "latest_arrival_turn": max(t_ring[r]["earliest_arrival_turn"] for r in req),
            },
            "complete": {
                "max_distance": 1,
                "sum_relay_steps": 0,
                "latest_arrival_turn": max(t_comp[r]["earliest_arrival_turn"] for r in req),
            },
        },
    }


def mc_expected_latest(required_sets, draws, rng):
    """Expected mean latest arrival (Ring and Complete) for a class under unconstrained random placement/order."""
    ring_vals, comp_vals = [], []
    for i in range(draws):
        req = required_sets[i % len(required_sets)]
        pos = ["Operations"] + rng.sample(DATA_ROLES, 5)
        order = rng.sample(AGENTS, 6)
        tr = temporal_delivery("ring", order, pos)
        tc = temporal_delivery("complete", order)
        ring_vals.append(max(tr[r]["earliest_arrival_turn"] for r in req))
        comp_vals.append(max(tc[r]["earliest_arrival_turn"] for r in req))
    return statistics.mean(ring_vals), statistics.mean(comp_vals)


def build_record(iid, set_name, s, td_id=None):
    md = metadata(s)
    return {
        "instance_id": iid,
        "set": set_name,
        "td_example_id": td_id,
        "public_state": {"requested_destination": s["requested_destination"], "amount": AMOUNT, "milestone": MILESTONE},
        "state": s,
        "base_facts": base_facts(s),
        "state_hash": state_hash(s),
        "structural_key_hash": "sha256:" + hashlib.sha256(json.dumps(structural_key(s)).encode()).hexdigest(),
        "class": md["class"],
        "subtype": md["subtype"],
        "subtype_key": f"{md['class']}/{md['subtype']}",
        "top_class": TOP_CLASS[md["class"]],
        "canonical_outcome": md["canonical_outcome"],
        "metadata": {k: md[k] for k in ("b_failure_reason", "minimal_fact_sets", "min_fact_set_size",
                                        "relevant_facts", "core_facts", "minimal_role_sets")},
        "features": features(s),
    }


def finalize(inst):
    cov = covariates(inst)
    inst["topology_assignment"] = {
        "speaking_order": inst.pop("speaking_order"),
        "ring_positions": inst.pop("ring_positions"),
    }
    inst["topology_assignment"]["ring_neighbors"] = ring_neighbors(inst["topology_assignment"]["ring_positions"])
    inst["topology_assignment"].update(cov)
    inst.pop("subtype_key")
    inst["runs"] = [{"run_id": f"{inst['instance_id']}-COMPLETE", "topology": "complete"},
                    {"run_id": f"{inst['instance_id']}-RING", "topology": "ring"}]
    return inst


def role_slot_ok(insts):
    """Within each top-level class every agent holds every speaking slot once or twice
    (true by construction; kept as a check). Also reports the counts over the pilot set."""
    per_class_ok = True
    for top in ("A", "B", "C", "Reject"):
        cnt = Counter()
        for i in insts:
            if i["top_class"] == top:
                for slot, a in enumerate(i["speaking_order"]):
                    cnt[(a, slot)] += 1
        per_class_ok &= all(1 <= cnt[(a, j)] <= 2 for a in AGENTS for j in range(6))
    cnt = Counter()
    for i in insts:
        for slot, a in enumerate(i["speaking_order"]):
            cnt[(a, slot)] += 1
    vals = [cnt[(a, j)] for a in AGENTS for j in range(6)]
    return per_class_ok, {"per_class_each_agent_each_slot_1_or_2": per_class_ok,
                          "pilot_agent_slot_min": min(vals), "pilot_agent_slot_max": max(vals),
                          "operations_slot_counts": [cnt[("Operations", j)] for j in range(6)]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="../instances")
    ap.add_argument("--report", default="../reports")
    args = ap.parse_args()
    assert len(public_state_space()) == 2048 and len(generator_state_space()) == 810 and len(class_valid_states()) == 582

    # ---- development set
    dev_rng = random.Random(DEV_SEED)
    dev = [build_record(i, "dev", s, td) for i, s, td in [(a, c, b) for a, b, c in DEV_STATES]]
    for inst in dev:
        assert inst["class"] != "excluded", inst["instance_id"]
        inst["ring_positions"] = ["Operations"] + dev_rng.sample(DATA_ROLES, 5)
        inst["speaking_order"] = dev_rng.sample(AGENTS, 6)
    dev = [finalize(i) for i in dev]
    excluded_keys = {structural_key(s) for _, _, s in DEV_STATES}

    # ---- pilot set: deterministic rejection sampling
    for attempt in range(MAX_ATTEMPTS):
        rng = random.Random(SAMPLING_SEED * 10000 + attempt)
        states, pool_sizes = draw_states(rng, excluded_keys)
        ok_state, state_checks = balance_ok(states)
        assert ok_state, state_checks  # guaranteed by the strata; kept as a check
        assert len({structural_key(s) for s in states}) == 40
        rng.shuffle(states)  # random instance order -> random IDs
        insts = [build_record(f"P-{k + 1:02d}", "pilot", s) for k, s in enumerate(states)]
        by_top = defaultdict(list)
        for i in insts:
            by_top[i["top_class"]].append(i)
        assign_topology(rng, by_top)
        ok_slots, slot_info = role_slot_ok(insts)
        if not ok_slots:
            continue
        insts = [finalize(i) for i in insts]
        # temporal balance against each class's own expectation
        mc_rng = random.Random(SAMPLING_SEED + 7)
        temporal = {}
        ok_t = True
        for top in ("A", "B", "C", "Reject"):
            g = [i for i in insts if i["top_class"] == top]
            req_sets = [i["topology_assignment"]["required_roles"] for i in g]
            exp_ring, exp_comp = mc_expected_latest(req_sets, MC_DRAWS, mc_rng)
            obs_ring = statistics.mean(i["topology_assignment"]["required_role_covariates"]["ring"]["latest_arrival_turn"] for i in g)
            obs_comp = statistics.mean(i["topology_assignment"]["required_role_covariates"]["complete"]["latest_arrival_turn"] for i in g)
            temporal[top] = {"ring_observed": round(obs_ring, 2), "ring_expected": round(exp_ring, 2),
                             "complete_observed": round(obs_comp, 2), "complete_expected": round(exp_comp, 2)}
            ok_t &= abs(obs_ring - exp_ring) <= TEMPORAL_TOL and abs(obs_comp - exp_comp) <= TEMPORAL_TOL
        if ok_t:
            break
    else:
        raise SystemExit("no acceptable draw")

    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.report, exist_ok=True)
    files = {}
    for name, data in (("dev_instances.json", dev), ("pilot_instances.json", insts)):
        path = os.path.join(args.out, name)
        blob = json.dumps({"sampling_version": SAMPLING_VERSION, "task_definition": "v1.4",
                           "exposure_spec": "v1.4", "instances": data}, indent=2)
        with open(path, "w") as fh:
            fh.write(blob + "\n")
        files[name] = "sha256:" + hashlib.sha256((blob + "\n").encode()).hexdigest()

    report = {
        "sampling_version": SAMPLING_VERSION,
        "sampling_seed": SAMPLING_SEED,
        "dev_seed": DEV_SEED,
        "accepted_attempt": attempt,
        "pool_sizes_after_dev_exclusion_mirror_classes": pool_sizes,
        "state_balance_checks": state_checks,
        "speaking_slot_checks": slot_info,
        "temporal_balance": temporal,
        "file_hashes": files,
    }
    with open(os.path.join(args.report, "sampling_record.json"), "w") as fh:
        json.dump(report, fh, indent=2)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
