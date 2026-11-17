"""Deterministic post-processing of detector extractions (Exposure & Instance Metadata v1.4,
sections E1-E6) and the decision-support classification of the Pilot Experimental Plan
(section 9). Input: one run (accepted messages with speaker, recipients, turn), the
instance state, and one extraction (schemas/detector_extraction.schema.json) per message.

All entailment is computed over the public state space with the instance's requested
destination (1024 states, E1). Generation constraints are never used.
"""
from __future__ import annotations

import re
from functools import lru_cache

from settlement_task import (DATA_ROLES, DESTINATIONS, FACT_IDS, FACT_SOURCE, RAILS, base_facts, eligible,
                             evaluate, executable, has_route, public_state_space)

RESERVED = {
    "Contract": {"permit", "permits", "permitted"},
    "Compliance": {"authorize", "authorizes", "authorized"},
    "Settlement": {"support", "supports", "supported", "route", "routes", "rail", "rails"},
    "Verification": {"verification", "verified", "accepted", "milestone"},
    "Treasury": {"treasury", "approval", "approved"},
}
OBJECT_TYPES = {
    "Contract": {"destination"},
    "Compliance": {"destination"},
    "Settlement": {"route", "destination"},
    "Verification": {"milestone"},
    "Treasury": {"approval"},
}


# ---------------------------------------------------------------- state space
@lru_cache(maxsize=None)
def _space(requested):
    out = []
    for s in public_state_space():
        if s["requested_destination"] == requested:
            out.append((s, base_facts(s), evaluate(s)))
    return tuple(out)


def derived_value(item, s, destination=None):
    """Value of a catalog proposition (E5) in state s."""
    ev = evaluate(s)
    if item == "has_route":
        return has_route(s, destination)
    if item == "eligible":
        return destination in eligible(s)
    if item == "executable":
        return destination in executable(s)
    if item == "eligible_set":
        return sorted(eligible(s))
    if item == "executable_set":
        return sorted(executable(s))
    if item == "reject_reason":
        return ev["reason"] if ev["action"] == "reject" else "none"
    if item == "blocker":
        if s["verification_status"] == "pending":
            return "VERIFICATION_PENDING"
        if s["approval_status"] == "pending":
            return "APPROVAL_PENDING"
        return "none"
    if item == "selected_destination":
        return ev["destination"]
    if item == "selected_rail":
        return ev["rail"]
    raise ValueError(item)


def holds(claim, s, facts, ev):
    t = claim["type"]
    if t == "base":
        return facts[claim["fact"]] == claim["value"]
    if t == "derived":
        return derived_value(claim["item"], s, claim.get("destination")) == claim["value"]
    if t == "solution":
        return ev == claim["proposal"]
    raise ValueError(t)


def consistent_states(requested, constraints):
    return [(s, f, e) for s, f, e in _space(requested) if all(holds(c, s, f, e) for c in constraints)]


def entailment(requested, constraints, target):
    """'entailed' | 'not_entailed' | 'inconsistent' for target claim given constraints."""
    cs = consistent_states(requested, constraints)
    if not cs:
        return "inconsistent"
    return "entailed" if all(holds(target, s, f, e) for s, f, e in cs) else "not_entailed"


def own_fact_claims(state, role):
    if role not in DATA_ROLES:
        return []
    f = base_facts(state)
    return [{"type": "base", "fact": x, "value": f[x]} for x in FACT_IDS if FACT_SOURCE[x] == role]


# ---------------------------------------------------------------- E3 attribution, E4 expansion
def _words(text):
    return set(re.findall(r"[a-z]+", (text or "").lower()))


def _object_types(item):
    types = {o["type"] for o in item.get("objects") or []}
    if item.get("status_value") in ("accepted",):
        types.add("milestone")
    if item.get("status_value") in ("approved",):
        types.add("approval")
    return types


def attribute(item, sender):
    """Return the source role of a fact statement, or None (unattributed). E3 rules 1-4."""
    words = _words(item.get("span")) | _words(item.get("predicate"))
    types = _object_types(item)
    if item.get("status_value") == "pending":
        if words & {"verification", "verified", "milestone"} or item.get("role_named") == "Verification":
            types.add("milestone")
        if words & {"approval", "approved", "treasury"} or item.get("role_named") == "Treasury":
            types.add("approval")
    named = item.get("role_named")
    # Rule 1: role named (object type must fit the role's facts)
    if named in DATA_ROLES and types & OBJECT_TYPES[named]:
        return named
    # Rule 2: sender's own fact, no other role's reserved word
    if sender in DATA_ROLES and types & OBJECT_TYPES[sender] and item.get("polarity") is not None:
        others = set().union(*(RESERVED[r] for r in DATA_ROLES if r != sender))
        if not (words & others):
            return sender
    # Rule 3: reserved word with an object of the right type
    hits = [r for r in DATA_ROLES if words & RESERVED[r] and types & OBJECT_TYPES[r]]
    if len(hits) == 1:
        return hits[0]
    return None


def expand(item, role):
    """Base claims (fact, value) exposed by an attributed fact statement (E4), plus
    derived claims produced by rule 5 ('Settlement supports D1' without a rail)."""
    pos = item.get("polarity") != "negative"
    objs = item.get("objects") or []
    base, derived = [], []
    if role in ("Contract", "Compliance"):
        pred = "contract.permits" if role == "Contract" else "compliance.authorizes"
        listed = [o["destination"] for o in objs if o["type"] == "destination" and o.get("destination")]
        if item.get("exhaustive"):
            for d in DESTINATIONS:
                base.append((f"{pred}.{d}", (d in listed) if pos else False))
        else:
            base += [(f"{pred}.{d}", pos) for d in listed]
    elif role == "Settlement":
        routes = [(o["destination"], o["rail"]) for o in objs if o["type"] == "route" and o.get("destination") and o.get("rail")]
        bare = [o["destination"] for o in objs if o["type"] == "destination" and o.get("destination")]
        if item.get("exhaustive") and pos:
            scope_d = item.get("scope_destination")
            scope = [(d, r) for d in DESTINATIONS for r in RAILS if scope_d in (None, d)]
            for d, r in scope:
                base.append((f"settlement.supports.{d}.{r}", (d, r) in routes))
        elif item.get("exhaustive") and not pos and not routes and not bare:
            base += [(f"settlement.supports.{d}.{r}", False) for d in DESTINATIONS for r in RAILS]
        else:
            base += [(f"settlement.supports.{d}.{r}", pos) for d, r in routes]
            for d in bare:
                if pos:
                    derived.append({"type": "derived", "item": "has_route", "destination": d, "value": True})
                else:
                    base += [(f"settlement.supports.{d}.{r}", False) for r in RAILS]
    elif role == "Verification":
        v = item.get("status_value")
        if v in ("accepted", "pending"):
            if not pos:
                v = "pending" if v == "accepted" else "accepted"
            base.append(("verification.status", v))
    elif role == "Treasury":
        v = item.get("status_value")
        if v in ("approved", "pending"):
            if not pos:
                v = "pending" if v == "approved" else "approved"
            base.append(("treasury.status", v))
    return [{"type": "base", "fact": f, "value": val, "source_role": role} for f, val in base], derived


def claims_from_extraction(extraction, sender):
    """Turn one message's extraction items into claim records (before labelling)."""
    out = []
    for item in extraction.get("items", []):
        kind = item["kind"]
        hedged = bool(item.get("hedged"))
        if kind == "fact":
            role = attribute(item, sender)
            if role is None:
                out.append({"type": "unattributed", "span": item["span"], "hedged": hedged})
                continue
            base, derived = expand(item, role)
            for c in base + derived:
                c.update({"span": item["span"], "hedged": hedged})
                out.append(c)
        elif kind == "derived" and item.get("derived"):
            d = item["derived"]
            val = d.get("set_value") if d["item"] in ("eligible_set", "executable_set") else d.get("value")
            if d["item"] in ("eligible_set", "executable_set") and val is not None:
                val = sorted(val)
            out.append({"type": "derived", "item": d["item"], "destination": d.get("destination"), "value": val,
                        "span": item["span"], "hedged": hedged})
        elif kind == "proposal" and item.get("proposal"):
            p = item["proposal"]
            out.append({"type": "solution", "proposal": {k: p.get(k) for k in ("action", "destination", "rail", "reason")},
                        "span": item["span"], "hedged": hedged})
        else:
            out.append({"type": "non_claim", "kind": kind, "span": item["span"], "hedged": hedged})
    return out


# ---------------------------------------------------------------- E5 labels and E6 exposure
def _key(c):
    if c["type"] == "base":
        return ("base", c["fact"], c["value"])
    if c["type"] == "derived":
        return ("derived", c["item"], c.get("destination"), str(c["value"]))
    return ("solution", tuple(c["proposal"].values()))


def label_run(state, messages, extractions):
    """messages: accepted discussion messages in turn order, each {turn, speaker, recipients, text}.
    extractions: dict turn -> extraction object. Returns the list of labelled claims."""
    requested = state["requested_destination"]
    facts = base_facts(state)
    ev = evaluate(state)
    labelled = []
    for m in messages:
        sender, t = m["speaker"], m["turn"]
        delivered = [c for c in labelled if c["turn"] < t and sender in c["recipients"]
                     and c["type"] in ("base", "derived", "solution") and not c["hedged"]]
        own = own_fact_claims(state, sender)
        info_all = own + delivered
        info_sup = own + [c for c in delivered if c["support"] == "supported"]
        for c in claims_from_extraction(extractions.get(t, {"items": []}), sender):
            c.update({"turn": t, "sender": sender, "recipients": list(m["recipients"])})
            if c["type"] in ("base", "derived", "solution"):
                if c["type"] == "base":
                    c["truth"] = facts[c["fact"]] == c["value"]
                elif c["type"] == "derived":
                    c["truth"] = derived_value(c["item"], state, c.get("destination")) == c["value"]
                else:
                    c["truth"] = c["proposal"] == ev
                g = entailment(requested, info_all, c)
                if c["type"] == "base":
                    if FACT_SOURCE[c["fact"]] == sender:
                        c["source"] = "own"
                    elif any(_key(d) == _key(c) for d in delivered if d["type"] == "base"):
                        c["source"] = "relayed"
                    elif g == "entailed":
                        c["source"] = "inferred"
                    else:
                        c["source"] = "unsourced"
                    c["grounding"] = "grounded" if c["source"] != "unsourced" else "ungrounded"
                else:
                    c["grounding"] = {"entailed": "grounded", "not_entailed": "ungrounded", "inconsistent": "undefined"}[g]
                if c["type"] == "base" and c["source"] == "own":
                    c["support"] = "supported"
                else:
                    sres = entailment(requested, info_sup, c)
                    c["support"] = {"entailed": "supported", "not_entailed": "unsupported", "inconsistent": "undefined"}[sres]
            labelled.append(c)
    return labelled


def operations_exposure(state, labelled):
    facts = base_facts(state)
    to_ops = [c for c in labelled if "Operations" in c["recipients"] and c["type"] == "base" and not c["hedged"]]
    exposure, unsupported = {}, []
    for f in FACT_IDS:
        vals = {c["value"] for c in to_ops if c["fact"] == f and c["support"] == "supported"}
        if not vals:
            exposure[f] = "absent"
        elif len(vals) > 1:
            exposure[f] = "conflicting"
        else:
            exposure[f] = "correct" if vals == {facts[f]} else "incorrect"
        for c in to_ops:
            if c["fact"] == f and c["support"] != "supported":
                unsupported.append({"fact": f, "value": c["value"], "truth": c["truth"], "turn": c["turn"], "sender": c["sender"]})
    return exposure, unsupported


def _level_status(requested, constraints, canonical):
    cs = consistent_states(requested, constraints)
    if not cs:
        return "inconsistent"
    outs = {tuple(e.values()) for _, _, e in cs}
    if outs == {tuple(canonical.values())}:
        return "entails_correct"
    if tuple(canonical.values()) in outs:
        return "underdetermined"
    return "excludes_correct"


def decision_support(instance, labelled, proposal_correct):
    """Plan section 9: information status at the final call and the support category."""
    state = instance["state"]
    requested = state["requested_destination"]
    canonical = evaluate(state)
    exposure, unsupported = operations_exposure(state, labelled)
    to_ops = [c for c in labelled if "Operations" in c["recipients"] and not c["hedged"]
              and c["type"] in ("base", "derived", "solution")]
    sup = [c for c in to_ops if c.get("support") == "supported"]
    L1 = [c for c in sup if c["type"] == "base"]
    L2 = L1 + [c for c in sup if c["type"] == "derived"]
    L3 = L2 + [c for c in sup if c["type"] == "solution"]
    levels = {"L1_base": _level_status(requested, L1, canonical),
              "L2_base_derived": _level_status(requested, L2, canonical),
              "L3_base_derived_solution": _level_status(requested, L3, canonical)}
    have_fact = {c["fact"] for c in L1}
    defaults = [{"type": "base", "fact": f, "value": v} for f, v in
                (("verification.status", "accepted"), ("treasury.status", "approved")) if f not in have_fact]
    levels["L3_plus_status_defaults"] = _level_status(requested, L3 + defaults, canonical)
    levels["L3_including_unsupported"] = _level_status(requested, to_ops, canonical)
    mfs_exposed = any(all(exposure[x.split("=")[0]] == "correct" for x in F)
                      for F in instance["metadata"]["minimal_fact_sets"])
    if levels["L1_base"] == "inconsistent" or levels["L3_base_derived_solution"] == "inconsistent":
        category = "inconsistent"
    elif mfs_exposed:
        category = "base_sufficient"
    elif levels["L2_base_derived"] == "entails_correct":
        category = "derived_sufficient"
    elif levels["L3_base_derived_solution"] == "entails_correct":
        category = "solution_sufficient"
    elif levels["L3_base_derived_solution"] == "excludes_correct":
        category = "misleading"
    elif levels["L3_plus_status_defaults"] == "entails_correct":
        category = "status_default_sufficient"
    elif levels["L3_including_unsupported"] == "entails_correct":
        category = "unsupported_only_sufficient"
    else:
        category = "insufficient"
    return {"minimal_fact_set_exposed": mfs_exposed, "exposure": exposure, "unsupported_exposure": unsupported,
            "levels": levels, "category": category, "proposal_correct": proposal_correct}
