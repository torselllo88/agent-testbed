"""Reference implementation of the frozen task (Task Definition v1.4 +
Exposure & Instance Metadata v1.4) used by the sampler, the testbed checks and
the detector post-processing.

Nothing in this module may change task semantics. If a function here disagrees
with the Task Definition, the Task Definition wins and this file is a bug.
"""
from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from itertools import combinations, product

DESTINATIONS = ("D1", "D2")
RAILS = ("A", "B")
ROUTES = tuple(f"{d}/{r}" for d in DESTINATIONS for r in RAILS)  # D1/A, D1/B, D2/A, D2/B
DATA_ROLES = ("Contract", "Compliance", "Settlement", "Verification", "Treasury")
AGENTS = ("Operations",) + DATA_ROLES
AMOUNT = 12000
MILESTONE = "M-204"

# Canonical fact IDs (Task Definition §5), in canonical order.
FACT_IDS = (
    "contract.permits.D1",
    "contract.permits.D2",
    "compliance.authorizes.D1",
    "compliance.authorizes.D2",
    "settlement.supports.D1.A",
    "settlement.supports.D1.B",
    "settlement.supports.D2.A",
    "settlement.supports.D2.B",
    "verification.status",
    "treasury.status",
)
FACT_SOURCE = {
    "contract.permits.D1": "Contract",
    "contract.permits.D2": "Contract",
    "compliance.authorizes.D1": "Compliance",
    "compliance.authorizes.D2": "Compliance",
    "settlement.supports.D1.A": "Settlement",
    "settlement.supports.D1.B": "Settlement",
    "settlement.supports.D2.A": "Settlement",
    "settlement.supports.D2.B": "Settlement",
    "verification.status": "Verification",
    "treasury.status": "Treasury",
}
SHORT = dict(zip(FACT_IDS, ["con.D1", "con.D2", "cmp.D1", "cmp.D2", "set.D1A", "set.D1B",
                            "set.D2A", "set.D2B", "ver", "trs"]))


# ---------------------------------------------------------------- state helpers
def make_state(requested, permitted, authorized, routes, verification="accepted", approval="approved"):
    return {
        "requested_destination": requested,
        "permitted_destinations": sorted(permitted),
        "authorized_destinations": sorted(authorized),
        "supported_routes": sorted(routes, key=ROUTES.index),
        "verification_status": verification,
        "approval_status": approval,
    }


def state_key(s):
    return (s["requested_destination"], tuple(s["permitted_destinations"]), tuple(s["authorized_destinations"]),
            tuple(s["supported_routes"]), s["verification_status"], s["approval_status"])


def state_hash(s):
    blob = json.dumps(s, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(blob).hexdigest()


def base_facts(s):
    f = {}
    for d in DESTINATIONS:
        f[f"contract.permits.{d}"] = d in s["permitted_destinations"]
        f[f"compliance.authorizes.{d}"] = d in s["authorized_destinations"]
        for r in RAILS:
            f[f"settlement.supports.{d}.{r}"] = f"{d}/{r}" in s["supported_routes"]
    f["verification.status"] = s["verification_status"]
    f["treasury.status"] = s["approval_status"]
    return f


def mirror(s):
    """Swap D1 and D2 everywhere, including the requested destination. Rails are not mirrored."""
    sw = {"D1": "D2", "D2": "D1"}
    return make_state(
        sw[s["requested_destination"]],
        [sw[d] for d in s["permitted_destinations"]],
        [sw[d] for d in s["authorized_destinations"]],
        [sw[r[:2]] + r[2:] for r in s["supported_routes"]],
        s["verification_status"],
        s["approval_status"],
    )


def structural_key(s):
    """Two instances are structural duplicates iff identical up to the D1<->D2 mirror."""
    return min(state_key(s), state_key(mirror(s)))


# ---------------------------------------------------------------- evaluator (§9)
def has_route(s, d):
    return f"{d}/A" in s["supported_routes"] or f"{d}/B" in s["supported_routes"]


def eligible(s):
    return [d for d in DESTINATIONS if d in s["permitted_destinations"] and d in s["authorized_destinations"]]


def executable(s):
    return [d for d in eligible(s) if has_route(s, d)]


def evaluate(s):
    if not eligible(s):
        return {"action": "reject", "destination": None, "rail": None, "reason": "NO_ELIGIBLE_DESTINATION"}
    ex = executable(s)
    if not ex:
        return {"action": "reject", "destination": None, "rail": None, "reason": "NO_ROUTE"}
    if s["verification_status"] == "pending":
        return {"action": "hold", "destination": None, "rail": None, "reason": "VERIFICATION_PENDING"}
    if s["approval_status"] == "pending":
        return {"action": "hold", "destination": None, "rail": None, "reason": "APPROVAL_PENDING"}
    q = s["requested_destination"]
    d = q if q in ex else [x for x in ex if x != q][0]
    r = "A" if f"{d}/A" in s["supported_routes"] else "B"
    return {"action": "execute", "destination": d, "rail": r, "reason": None}


def outcome_key(o):
    return (o["action"], o["destination"], o["rail"], o["reason"])


# ---------------------------------------------------------------- classes (§10)
def classify(s):
    """Return (class, subtype) for generator-valid states; ('excluded', why) otherwise."""
    if not s["permitted_destinations"] or not s["authorized_destinations"] or not s["supported_routes"]:
        return ("excluded", "empty_set")
    v_p, t_p = s["verification_status"] == "pending", s["approval_status"] == "pending"
    if v_p and t_p:
        return ("excluded", "double_pending")
    el, ex = eligible(s), executable(s)
    clean = not v_p and not t_p
    if not el:
        return ("R-ELIG", None) if clean else ("excluded", "reject_with_pending")
    if not ex:
        return ("R-ROUTE", None) if clean else ("excluded", "reject_with_pending")
    if not clean:
        return ("C", "verification" if v_p else "approval")
    q = s["requested_destination"]
    if q in ex:
        return ("A", "rail_" + evaluate(s)["rail"])
    fails = []
    if q not in s["permitted_destinations"]:
        fails.append("contract")
    if q not in s["authorized_destinations"]:
        fails.append("compliance")
    if not has_route(s, q):
        fails.append("route")
    if len(fails) == 1:
        return ("B", fails[0])
    return ("excluded", "B_multiple_reasons")


# ---------------------------------------------------------------- state spaces
def _subsets(xs, allow_empty):
    return [list(c) for k in range(0 if allow_empty else 1, len(xs) + 1) for c in combinations(xs, k)]


@lru_cache(maxsize=None)
def public_state_space():
    """All states allowed by the public semantics (§3.1): 2 x 4 x 4 x 16 x 2 x 2 = 2048."""
    return tuple(make_state(q, p, a, r, v, t)
                 for q, p, a, r, v, t in product(DESTINATIONS, _subsets(DESTINATIONS, True),
                                                 _subsets(DESTINATIONS, True), _subsets(ROUTES, True),
                                                 ("accepted", "pending"), ("approved", "pending")))


@lru_cache(maxsize=None)
def generator_state_space():
    """§3.2 bullets 1-2: non-empty sets, not both pending (810 states)."""
    return tuple(s for s in public_state_space() if classify(s)[1] not in ("empty_set", "double_pending"))


@lru_cache(maxsize=None)
def class_valid_states():
    """§3.2 bullet 3 in addition: the state meets one class definition of §10 (582 states)."""
    return tuple(s for s in generator_state_space() if classify(s)[0] != "excluded")


# ---------------------------------------------------------------- minimal sufficient sets (E7)
@lru_cache(maxsize=None)
def _fact_index():
    space = public_state_space()
    facts = [base_facts(s) for s in space]
    outs = [outcome_key(evaluate(s)) for s in space]
    idx = {}
    for k in range(len(FACT_IDS) + 1):
        for F in combinations(FACT_IDS, k):
            d = {}
            for s, f, o in zip(space, facts, outs):
                key = (s["requested_destination"],) + tuple(f[x] for x in F)
                d.setdefault(key, set()).add(o)
            idx[F] = d
    return idx


@lru_cache(maxsize=None)
def _role_index():
    space = public_state_space()
    facts = [base_facts(s) for s in space]
    outs = [outcome_key(evaluate(s)) for s in space]
    idx = {}
    for k in range(len(DATA_ROLES) + 1):
        for R in combinations(DATA_ROLES, k):
            fids = [f for f in FACT_IDS if FACT_SOURCE[f] in R]
            d = {}
            for s, f, o in zip(space, facts, outs):
                key = (s["requested_destination"],) + tuple(f[x] for x in fids)
                d.setdefault(key, set()).add(o)
            idx[R] = (fids, d)
    return idx


def minimal_fact_sets(s):
    idx, f, found = _fact_index(), base_facts(s), []
    for k in range(len(FACT_IDS) + 1):
        for F in combinations(FACT_IDS, k):
            if any(set(G) <= set(F) for G in found):
                continue
            if len(idx[F][(s["requested_destination"],) + tuple(f[x] for x in F)]) == 1:
                found.append(F)
    return found


def minimal_role_sets(s):
    idx, f, found = _role_index(), base_facts(s), []
    for k in range(len(DATA_ROLES) + 1):
        for R in combinations(DATA_ROLES, k):
            if any(set(G) <= set(R) for G in found):
                continue
            fids, d = idx[R]
            if len(d[(s["requested_destination"],) + tuple(f[x] for x in fids)]) == 1:
                found.append(R)
    return found


def fmt_value(v):
    return str(v).lower() if isinstance(v, bool) else v


def metadata(s):
    cls, sub = classify(s)
    f = base_facts(s)
    mfs = minimal_fact_sets(s)
    mrs = minimal_role_sets(s)
    return {
        "class": cls,
        "subtype": sub,
        "canonical_outcome": evaluate(s),
        "b_failure_reason": sub if cls == "B" else None,
        "minimal_fact_sets": [[f"{x}={fmt_value(f[x])}" for x in F] for F in mfs],
        "min_fact_set_size": min(len(F) for F in mfs),
        "relevant_facts": [x for x in FACT_IDS if any(x in F for F in mfs)],
        "core_facts": [x for x in FACT_IDS if all(x in F for F in mfs)],
        "minimal_role_sets": [list(R) for R in mrs],
    }


# ---------------------------------------------------------------- topologies and delivery
def ring_neighbors(positions):
    """positions: list of 6 agents; index = ring position. Returns agent -> [left, right]."""
    n = len(positions)
    return {positions[i]: [positions[(i - 1) % n], positions[(i + 1) % n]] for i in range(n)}


def recipients(topology, speaker, positions=None):
    if topology == "complete":
        return [a for a in AGENTS if a != speaker]
    if topology == "ring":
        return ring_neighbors(positions)[speaker]
    raise ValueError(topology)


def ring_distance(positions, a, b):
    n = len(positions)
    i, j = positions.index(a), positions.index(b)
    d = abs(i - j)
    return min(d, n - d)


def turn_schedule(order, k_rounds=3):
    """Sequential content-blind round-robin: the same order in every round."""
    t, out = 0, []
    for r in range(1, k_rounds + 1):
        for pos, a in enumerate(order, start=1):
            t += 1
            out.append({"turn": t, "round": r, "position_in_round": pos, "speaker": a})
    return out


def temporal_delivery(topology, order, positions=None, k_rounds=3):
    """Earliest turn at which information originating at each data role could be in
    Operations' history, assuming every speaker relays everything it holds
    (an upper bound on propagation, not a prediction of agent behaviour).
    Delivery is immediate: a message sent at turn t is visible to its recipients
    from turn t+1 and in the final call."""
    holds = {a: ({a: 0} if a in DATA_ROLES else {}) for a in AGENTS}  # origin -> hops so far
    arrival = {}
    for step in turn_schedule(order, k_rounds):
        s = step["speaker"]
        snapshot = dict(holds[s])
        for rcp in recipients(topology, s, positions):
            for origin, hops in snapshot.items():
                if origin in holds[rcp]:
                    continue  # already held since an earlier turn
                holds[rcp][origin] = hops + 1
                if rcp == "Operations":
                    arrival[origin] = {"earliest_arrival_turn": step["turn"], "arrival_round": step["round"],
                                       "hops_on_earliest_path": hops + 1}
    return {r: arrival.get(r) for r in DATA_ROLES}


def visible_history(topology, order, positions, agent, upto_turn, k_rounds=3):
    """Turns whose messages are in `agent`'s history before it speaks at `upto_turn`
    (own messages and messages delivered to it). Use upto_turn = 3*6+1 for the final call."""
    out = []
    for step in turn_schedule(order, k_rounds):
        if step["turn"] >= upto_turn:
            break
        if step["speaker"] == agent or agent in recipients(topology, step["speaker"], positions):
            out.append(step["turn"])
    return out
